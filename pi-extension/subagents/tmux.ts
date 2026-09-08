/**
 * Terminal-multiplexer surface layer for tmux and Herdr.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping multiplexer calls isolated here means
 * index.ts stays testable without a multiplexer running.
 *
 * tmux panes use ids such as `%12`; Herdr panes use opaque ids such as
 * `w3:p1H`. Creation always targets the parent Pi pane rather than whichever
 * pane happens to be focused in another client.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

/** True when Pi is running in a Herdr-managed pane. */
export function isHerdrAvailable(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    !!process.env.HERDR_PANE_ID &&
    hasCommand(process.env.HERDR_BIN_PATH || "herdr")
  );
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable() || isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start Pi inside Herdr or tmux (`tmux new -A -s pi 'pi'`).";
}

function requireMux(): void {
  if (!isMuxAvailable()) {
    throw new Error(`A supported terminal multiplexer is required for subagents. ${muxSetupHint()}`);
  }
}

function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function runHerdr(args: string[]): any {
  const output = execFileSync(herdrBin(), args, { encoding: "utf8" });
  if (!output.trim()) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function isHerdrSurface(surface: string): boolean {
  return !surface.startsWith("%");
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

/** Herdr builds this many columns before starting the second row. */
const HERDR_GRID_COLUMNS = Math.max(
  1,
  Number.parseInt(process.env.PI_SUBAGENT_HERDR_GRID_COLUMNS || "5", 10) || 5,
);

export interface HerdrRoute {
  workspace: string;
  tab: string;
}

interface HerdrLayoutPane {
  pane_id: string;
  rect: { width: number; height: number };
}

interface HerdrLivePane {
  pane_id: string;
  agent?: string;
}

/**
 * Parse the optional dedicated-tab route. Environment variables override the
 * shared user config so one process can opt out or point elsewhere without
 * editing the machine-wide policy.
 */
export function parseHerdrRoute(
  rawConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): HerdrRoute | null {
  const config = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
    ? rawConfig as Record<string, unknown>
    : {};
  const herdr = config.herdr && typeof config.herdr === "object" && !Array.isArray(config.herdr)
    ? config.herdr as Record<string, unknown>
    : {};
  const workspace = (env.PI_SUBAGENT_HERDR_WORKSPACE ?? herdr.workspace)?.toString().trim();
  const tab = (env.PI_SUBAGENT_HERDR_TAB ?? herdr.tab)?.toString().trim();

  if (!workspace && !tab) return null;
  if (!workspace || !tab) {
    throw new Error(
      "Dedicated Herdr subagent routing requires both a workspace and tab " +
      "(PI_SUBAGENT_HERDR_WORKSPACE/PI_SUBAGENT_HERDR_TAB or shared config).",
    );
  }
  return { workspace, tab };
}

function loadHerdrRoute(): HerdrRoute | null {
  const configPath = process.env.PI_SUBAGENT_CONFIG_PATH || join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "pi-interactive-subagents",
    "config.json",
  );
  let rawConfig: unknown = {};
  if (existsSync(configPath)) {
    try {
      rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid interactive-subagents config ${configPath}: ${detail}`);
    }
  }
  return parseHerdrRoute(rawConfig);
}

/** Choose the largest current pane so a shared dynamic tab stays balanced. */
export function selectHerdrSplitPane(
  layoutPanes: HerdrLayoutPane[],
  livePanes: HerdrLivePane[],
): { paneId: string; direction: "right" | "down" } {
  if (layoutPanes.length === 0) throw new Error("Dedicated Herdr subagent tab has no panes");
  const liveById = new Map(livePanes.map((pane) => [pane.pane_id, pane]));
  const ordered = [...layoutPanes].sort((a, b) => {
    const areaDelta = b.rect.width * b.rect.height - a.rect.width * a.rect.height;
    if (areaDelta !== 0) return areaDelta;
    const aOccupied = liveById.get(a.pane_id)?.agent ? 1 : 0;
    const bOccupied = liveById.get(b.pane_id)?.agent ? 1 : 0;
    if (aOccupied !== bOccupied) return aOccupied - bOccupied;
    return a.pane_id.localeCompare(b.pane_id);
  });
  const target = ordered[0];
  return {
    paneId: target.pane_id,
    direction: target.rect.width >= target.rect.height * 1.6 ? "right" : "down",
  };
}

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;
const herdrTopRow: string[] = [];
const herdrBottomRow: string[] = [];

/**
 * Re-balance tmux panes so repeated splits don't leave them lopsided. Herdr
 * uses explicit split ratios while surfaces are created, so it needs no
 * equivalent post-layout command.
 */
function rebalanceSurfaces(hintPane?: string): void {
  if (!isTmuxAvailable()) return;
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

function renameHerdrSurface(surface: string, name: string): void {
  try {
    runHerdr(["pane", "rename", surface, `subagent: ${name}`]);
  } catch {
    // A label is cosmetic; failure must not prevent launch.
  }
}

function splitHerdrSurface(
  fromSurface: string,
  direction: "right" | "down",
  ratio: number,
): string {
  const response = runHerdr([
    "pane",
    "split",
    fromSurface,
    "--direction",
    direction,
    "--ratio",
    String(ratio),
    "--cwd",
    process.cwd(),
    "--no-focus",
  ]);
  const pane = response?.result?.pane?.pane_id;
  if (typeof pane !== "string" || !pane) {
    throw new Error(`Unexpected Herdr pane split response: ${JSON.stringify(response)}`);
  }
  return pane;
}

/**
 * Create a full-width Herdr area below an existing two-pane top row. This is
 * deliberately topology-aware: moving the original right pane beside the
 * original left pane changes the root from a horizontal split into a vertical
 * split whose top child retains the two existing panes.
 */
function createInitialHerdrSurface(name: string, parent: string): string {
  let pane: string | null = null;
  let layout: any = null;
  let panes: any[] = [];
  try {
    const response = runHerdr(["pane", "layout", "--pane", parent]);
    layout = response?.result?.layout;
    panes = Array.isArray(layout?.panes) ? [...layout.panes] : [];
    panes.sort((a, b) => a.rect.x - b.rect.x);
  } catch {
    // The generic parent split below remains available as a safe fallback.
  }

  const isTwoPaneTopRow =
    panes.length === 2 &&
    panes.some((item) => item.pane_id === parent) &&
    panes[0].rect.y === panes[1].rect.y &&
    panes[0].rect.height === panes[1].rect.height;

  if (isTwoPaneTopRow) {
    const [left, right] = panes;
    const temporary = runHerdr([
      "tab",
      "create",
      "--workspace",
      layout.workspace_id,
      "--cwd",
      process.cwd(),
      "--label",
      `subagent-layout-${process.pid}`,
      "--no-focus",
    ]);
    const temporaryTab = temporary?.result?.tab?.tab_id;
    const temporaryRoot = temporary?.result?.root_pane?.pane_id;
    if (!temporaryTab || !temporaryRoot) {
      throw new Error(`Unexpected Herdr temporary tab response: ${JSON.stringify(temporary)}`);
    }

    let rightMovedOut = false;
    let rightMovedBack = false;
    let candidate: string | null = null;
    try {
      runHerdr([
        "pane",
        "move",
        right.pane_id,
        "--tab",
        temporaryTab,
        "--split",
        "right",
        "--target-pane",
        temporaryRoot,
        "--ratio",
        "0.5",
        "--no-focus",
      ]);
      rightMovedOut = true;
      candidate = splitHerdrSurface(left.pane_id, "down", 0.34);
      runHerdr([
        "pane",
        "move",
        right.pane_id,
        "--tab",
        layout.tab_id,
        "--split",
        "right",
        "--target-pane",
        left.pane_id,
        "--ratio",
        "0.5",
        right.pane_id === parent ? "--focus" : "--no-focus",
      ]);
      rightMovedBack = true;
      pane = candidate;
      runHerdr(["tab", "close", temporaryTab]);
    } catch (error) {
      if (rightMovedOut && !rightMovedBack) {
        try {
          runHerdr([
            "pane",
            "move",
            right.pane_id,
            "--tab",
            layout.tab_id,
            "--split",
            "right",
            "--target-pane",
            left.pane_id,
            "--ratio",
            "0.5",
            right.pane_id === parent ? "--focus" : "--no-focus",
          ]);
          rightMovedBack = true;
        } catch {}
      }
      if (candidate) {
        try {
          runHerdr(["pane", "close", candidate]);
        } catch {}
      }
      if (rightMovedBack) {
        try {
          runHerdr(["tab", "close", temporaryTab]);
        } catch {}
      }
      throw error;
    }
  }

  // Generic fallback: reserve the lower two-thirds beneath the parent pane.
  pane ??= splitHerdrSurface(parent, "down", 0.34);
  herdrTopRow.push(pane);
  renameHerdrSurface(pane, name);
  return pane;
}

function createRoutedHerdrSurface(name: string, route: HerdrRoute): string {
  const workspaceResponse = runHerdr(["workspace", "list"]);
  const workspaces = workspaceResponse?.result?.workspaces;
  const workspaceMatches = Array.isArray(workspaces)
    ? workspaces.filter((workspace: any) => workspace?.workspace_id === route.workspace || workspace?.label === route.workspace)
    : [];
  if (workspaceMatches.length !== 1) {
    throw new Error(
      `Dedicated Herdr workspace "${route.workspace}" matched ${workspaceMatches.length} workspaces`,
    );
  }
  const workspaceId = workspaceMatches[0].workspace_id;

  const tabsResponse = runHerdr(["tab", "list", "--workspace", workspaceId]);
  const tabs = tabsResponse?.result?.tabs;
  let tabMatches = Array.isArray(tabs)
    ? tabs.filter((tab: any) => tab?.tab_id === route.tab || tab?.label === route.tab)
    : [];
  if (tabMatches.length === 0) {
    const anchorCwd = join(homedir(), ".local", "state", "pi-interactive-subagents");
    mkdirSync(anchorCwd, { recursive: true });
    const created = runHerdr([
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      anchorCwd,
      "--label",
      route.tab,
      "--no-focus",
    ]);
    const tab = created?.result?.tab;
    if (!tab?.tab_id) {
      throw new Error(`Unexpected Herdr tab creation response: ${JSON.stringify(created)}`);
    }
    tabMatches = [tab];
  }
  if (tabMatches.length !== 1) {
    throw new Error(`Dedicated Herdr tab "${route.tab}" matched ${tabMatches.length} tabs`);
  }
  const tabId = tabMatches[0].tab_id;

  const panesResponse = runHerdr(["pane", "list", "--workspace", workspaceId]);
  const livePanes = Array.isArray(panesResponse?.result?.panes)
    ? panesResponse.result.panes.filter((pane: any) => pane?.tab_id === tabId)
    : [];
  if (livePanes.length === 0) {
    throw new Error(`Dedicated Herdr tab "${route.tab}" has no panes`);
  }
  const layoutResponse = runHerdr(["pane", "layout", "--pane", livePanes[0].pane_id]);
  const layoutPanes = layoutResponse?.result?.layout?.panes;
  if (!Array.isArray(layoutPanes)) {
    throw new Error(`Unexpected Herdr pane layout response: ${JSON.stringify(layoutResponse)}`);
  }
  const target = selectHerdrSplitPane(layoutPanes, livePanes);
  const pane = splitHerdrSurface(target.paneId, target.direction, 0.5);
  renameHerdrSurface(pane, name);
  return pane;
}

function createHerdrSurface(name: string): string {
  const parent = process.env.HERDR_PANE_ID;
  if (!parent) throw new Error("HERDR_PANE_ID is required to create a Herdr subagent pane");

  const route = loadHerdrRoute();
  if (route) return createRoutedHerdrSurface(name, route);

  if (herdrTopRow.length === 0) {
    return createInitialHerdrSurface(name, parent);
  }

  if (herdrTopRow.length < HERDR_GRID_COLUMNS) {
    const remainder = herdrTopRow[herdrTopRow.length - 1];
    const remainingColumns = HERDR_GRID_COLUMNS - herdrTopRow.length + 1;
    const pane = splitHerdrSurface(remainder, "right", 1 / remainingColumns);
    herdrTopRow.push(pane);
    renameHerdrSurface(pane, name);
    return pane;
  }

  if (herdrBottomRow.length < HERDR_GRID_COLUMNS) {
    const pane = splitHerdrSurface(herdrTopRow[herdrBottomRow.length], "down", 0.5);
    herdrBottomRow.push(pane);
    renameHerdrSurface(pane, name);
    return pane;
  }

  // More than two rows: continue downward in column order.
  const all = [...herdrTopRow, ...herdrBottomRow];
  const target = all[(all.length - HERDR_GRID_COLUMNS * 2) % HERDR_GRID_COLUMNS];
  const pane = splitHerdrSurface(target, "down", 0.5);
  herdrBottomRow.push(pane);
  renameHerdrSurface(pane, name);
  return pane;
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent. Herdr places panes in a grid below the
 * parent area; tmux creates a right split and then rebalances the window.
 * Creation never follows another client's focus.
 */
export function createSurface(name: string): string {
  requireMux();
  if (isHerdrAvailable()) return createHerdrSurface(name);
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  requireMux();

  if (isHerdrAvailable()) {
    const parent = fromSurface ?? process.env.HERDR_PANE_ID;
    if (!parent) throw new Error("HERDR_PANE_ID is required to split a Herdr pane");
    const nativeDirection = direction === "left" ? "right" : direction === "up" ? "down" : direction;
    const pane = splitHerdrSurface(parent, nativeDirection, 0.5);
    if (direction === "left" || direction === "up") {
      runHerdr(["pane", "swap", "--source-pane", pane, "--target-pane", parent]);
    }
    renameHerdrSurface(pane, name);
    return pane;
  }

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireMux();
  if (isHerdrSurface(surface)) {
    runHerdr(["pane", "run", surface, command]);
    return;
  }
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireMux();
  if (isHerdrSurface(surface)) {
    return execFileSync(
      herdrBin(),
      ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
  }
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireMux();
  const command = isHerdrSurface(surface) ? herdrBin() : "tmux";
  const args = isHerdrSurface(surface)
    ? ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))]
    : ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`];
  const { stdout } = await execFileAsync(command, args, { encoding: "utf8" });
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireMux();
  if (isHerdrSurface(surface)) {
    runHerdr(["pane", "close", surface]);
    return;
  }
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
