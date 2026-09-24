import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { log } from "./log";
import { HOME, run, Session } from "./system";

// Everything here runs only when an action is pressed, never on refresh.

export interface HostApp {
  name: string; // "Orca", "Terminal", "iTerm2", "Ghostty", …
  bundlePath: string;
}

/** Walks up the process tree from `pid` to the first process inside an .app bundle. */
export async function hostApp(pid: number): Promise<HostApp | undefined> {
  let current = pid;
  for (let i = 0; i < 12 && current > 1; i++) {
    let out: string;
    try {
      out = (await run("/bin/ps", ["-o", "ppid=,comm=", "-p", String(current)], 2000)).trim();
    } catch {
      return undefined;
    }
    const m = out.match(/^(\d+)\s+(.+)$/);
    if (!m) return undefined;
    const app = m[2].match(/^(.*?\/([^/]+)\.app)(?:\/|$)/);
    if (app && i > 0) return { name: app[2], bundlePath: app[1] };
    current = parseInt(m[1], 10);
  }
  return undefined;
}

interface OrcaTerminal {
  handle: string;
  title?: string;
  agentIdentity?: string;
}

const stripGlyph = (t: string) => t.replace(/^[^\p{L}\p{N}]+/u, "").trim().toLowerCase();

/**
 * Orca doesn't report a terminal's pid or tty, but it titles each tab with the agent's own
 * session title ("✳ Client portal"). Match on that, preferring the same agent.
 */
async function switchOrcaTab(s: Session): Promise<boolean> {
  let list: OrcaTerminal[] = [];
  try {
    const out = await run("/usr/local/bin/orca", ["terminal", "list", "--json"], 5000);
    list = (JSON.parse(out) as { result?: { terminals?: OrcaTerminal[] } }).result?.terminals ?? [];
  } catch (e) {
    log("index", "orca terminal list failed", e);
    return false;
  }
  const want = stripGlyph(s.title);
  const agent = s.tool === "claude" ? "claude" : s.tool;
  const candidates = list.filter((t) => t.title && stripGlyph(t.title) === want);
  const match = candidates.find((t) => t.agentIdentity === agent) ?? candidates[0];
  if (!match) return false;
  await run("/usr/local/bin/orca", ["terminal", "switch", "--terminal", match.handle], 5000);
  return true;
}

async function activate(app: HostApp) {
  await run("/usr/bin/open", [app.bundlePath], 5000);
}

/** Terminal.app and iTerm2 can select the exact tab by its tty. */
async function selectTabByTty(app: HostApp, tty: string): Promise<boolean> {
  const dev = `/dev/tty${tty.replace(/^tty/, "")}`;
  const script =
    app.name === "Terminal"
      ? `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${dev}" then
        set selected of t to true
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell`
      : app.name === "iTerm2" || app.name === "iTerm"
        ? `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${dev}" then
          select t
          select s
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell`
        : "";
  if (!script) return false;
  const out = await run("/usr/bin/osascript", ["-e", script], 8000);
  return out.trim() === "ok";
}

/** Brings the session's terminal (or app) to the front. Returns what it did, for the toast. */
export async function showSession(s: Session): Promise<string> {
  if (s.tool === "opencode" && s.origin === "OpenCode Desktop") {
    await run("/usr/bin/open", ["/Applications/OpenCode.app"], 5000);
    return "Opened OpenCode";
  }
  const app = s.pid ? await hostApp(s.pid) : undefined;
  if (!app) throw new Error("Couldn't find the app this session runs in");
  if (app.name === "Orca") {
    await activate(app);
    return (await switchOrcaTab(s)) ? "Switched to its Orca tab" : "Opened Orca (no tab titled like this session)";
  }
  if (s.tty && (await selectTabByTty(app, s.tty).catch(() => false))) return `Switched to its ${app.name} tab`;
  await activate(app);
  return `Opened ${app.name}`;
}

// ---------- Claude version ----------

let latestClaude: { at: number; version?: string } | undefined;

const semver = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);

/** Newest Claude Code version installed locally (the versions folder), cached for 10 minutes. */
export function latestClaudeVersion(): string | undefined {
  if (latestClaude && Date.now() - latestClaude.at < 600_000) return latestClaude.version;
  let version: string | undefined;
  const dir = join(HOME, ".local/share/claude/versions");
  try {
    if (existsSync(dir)) {
      version = readdirSync(dir)
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => {
          const [x, y] = [semver(a), semver(b)];
          return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
        })
        .pop();
    }
  } catch {
    version = undefined;
  }
  latestClaude = { at: Date.now(), version };
  return version;
}

/** "18 versions behind" for the same major.minor, "outdated" across minors, undefined when current. */
export function versionLag(current: string | undefined, latest: string | undefined): string | undefined {
  if (!current || !latest || current === latest) return undefined;
  const [a, b] = [semver(current), semver(latest)];
  if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])))) return undefined;
  if (a[0] === b[0] && a[1] === b[1]) {
    const n = b[2] - a[2];
    return `${n} version${n === 1 ? "" : "s"} behind ${latest}`;
  }
  return `outdated, ${latest} is installed`;
}

export const linearUrl = (workspace: string, ticket: string) => `https://linear.app/${workspace}/issue/${ticket}`;
