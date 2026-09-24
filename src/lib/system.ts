import { execFile } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  AppGroup,
  describeWorkspace,
  globMatch,
  groupApps,
  Memory,
  parseEtime,
  parseKeepList,
  parseMemory,
  parsePs,
  parseW,
  Proc,
  ticketFromBranch,
} from "./parse";
import { SUPPORT_DIR } from "./log";
import { readTranscript } from "./transcript";

export const HOME = homedir();
const ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME, LANG: "en_US.UTF-8" };

export function run(cmd: string, args: string[], timeoutMs = 5000, maxBuffer = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: ENV, timeout: timeoutMs, maxBuffer, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        // keep the output: some tools (lsof) exit non-zero with a usable result
        Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        if (stderr && !error.message.includes(String(stderr).trim())) error.message = `${error.message.trim()}: ${String(stderr).trim()}`;
        reject(error);
      } else resolve(String(stdout));
    });
  });
}

export const tilde = (p: string) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
export const expandTilde = (p: string) => (p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

// ---------- memory (the cheap part: two tiny commands) ----------

export async function readMemory(): Promise<Memory> {
  const [sysctl, vmStat] = await Promise.all([
    run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level", "vm.swapusage", "hw.memsize"]),
    run("/usr/bin/vm_stat", []),
  ]);
  return parseMemory(sysctl, vmStat);
}

// ---------- processes ----------

export async function readProcs(): Promise<Proc[]> {
  // comm (not command) keeps this ~70 KB instead of ~180 KB of full command lines.
  return parsePs(await run("/bin/ps", ["-axo", "pid=,rss=,tty=,etime=,comm="]));
}

export async function readIdle(): Promise<Map<string, number>> {
  return parseW(await run("/usr/bin/w", ["-h"]));
}

export function heavyApps(procs: Proc[], minKB = 150 * 1024): AppGroup[] {
  return groupApps(procs).filter((g) => g.rssKB >= minKB);
}

export async function quitApp(name: string): Promise<void> {
  await run("/usr/bin/osascript", ["-e", `quit app "${name.replace(/"/g, '\\"')}"`], 15000);
}

// ---------- screenshot (for reporting what the window looks like) ----------

export const SCREENSHOT_DIR = SUPPORT_DIR;
export const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export class ScreenRecordingPermissionError extends Error {
  constructor(detail: string) {
    super(
      "Tinycast is not allowed to record the screen. Open System Settings → Privacy & Security → Screen & System Audio Recording, " +
        `turn on Tinycast (add it with + if it's missing), then quit and reopen Tinycast. (${detail})`,
    );
    this.name = "ScreenRecordingPermissionError";
  }
}

/** Captures the screen after `delaySeconds`, so the action panel has closed. Returns the file path. */
export async function takeScreenshot(delaySeconds = 1): Promise<string> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const path = join(SCREENSHOT_DIR, "headroom-latest.png");
  try {
    rmSync(path, { force: true });
  } catch {
    // an old file we can't remove is overwritten below anyway
  }
  try {
    await run("/usr/sbin/screencapture", ["-x", "-T", String(delaySeconds), path], 15000);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Without the permission, screencapture exits non-zero with "could not create image from display".
    if (/could not create image|not permitted|permission|declined/i.test(detail) || !existsSync(path)) throw new ScreenRecordingPermissionError(detail.trim());
    throw e;
  }
  if (!existsSync(path) || statSync(path).size === 0) throw new ScreenRecordingPermissionError("screencapture wrote no image");
  return path;
}

// ---------- keep list (shared with claude-reap) ----------

const KEEP_FILE = join(HOME, ".config/claude-reap/keep");

export function readKeepList(): string[] {
  try {
    return parseKeepList(readFileSync(KEEP_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function addToKeepList(dir: string): void {
  appendFileSync(KEEP_FILE, `${dir}\n`);
}

// ---------- Claude Code sessions ----------

export type SessionState = "reapable" | "working" | "waiting" | "kept";
export type Tool = "claude" | "codex" | "opencode";

export interface Session {
  tool: Tool;
  key: string; // unique across tools
  sessionId: string;
  name: string; // the tool's own id-like name: "sewa-15", a thread name, an OpenCode title
  title: string; // what the row shows: a generated or set title, else the topic, else the folder
  origin: string; // where it runs: "CLI · s005", "Codex Desktop", "OpenCode Desktop"
  cwd: string;
  state: SessionState;
  busy: boolean;
  statusSince?: number;
  startedAt?: number;
  version?: string;
  model?: string;
  pid?: number;
  tty?: string;
  idleSeconds?: number;
  rssKB?: number;
  topic?: string;
  lastPrompt?: string;
  lastReply?: string;
  lastMessageAt?: number;
  repo?: Repo;
  otherRepos: Repo[];
  workspace?: string;
  ticket?: string;
  resumeCommand?: string;
}

export interface Repo {
  root: string;
  name: string; // the main repo's name, also for a linked worktree
  worktree?: string; // set when root is a linked worktree
  branch?: string;
  changes: number;
}

/** A linked worktree's .git is a file: "gitdir: /path/Main/.git/worktrees/<name>". */
export function repoIdentity(root: string): { name: string; worktree?: string } {
  const base = root.split("/").pop() || root;
  try {
    const dotGit = join(root, ".git");
    if (statSync(dotGit).isFile()) {
      const main = readFileSync(dotGit, "utf8").match(/gitdir:\s*(.+?)\/\.git\/worktrees\//)?.[1];
      if (main) return { name: main.split("/").pop() || base, worktree: base };
    }
  } catch {
    // unreadable: fall back to the folder name
  }
  const orca = root.match(/\/orca\/workspaces\/([^/]+)\/([^/]+)$/);
  if (orca) return { name: orca[1], worktree: orca[2] };
  return { name: base };
}

/** A row title from whatever the tool offers, trimmed for the narrow list column. */
export function displayTitle(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    const t = c?.replace(/\s+/g, " ").trim();
    if (t) return t.length > 60 ? `${t.slice(0, 59)}…` : t;
  }
  return "Untitled session";
}

interface StatusFile {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  status?: string;
  entrypoint?: string;
  statusUpdatedAt?: number;
  updatedAt?: number;
  startedAt?: number;
  version?: string;
}

const SESSIONS_DIR = join(HOME, ".claude/sessions");
const PROJECTS_DIR = join(HOME, ".claude/projects");

/** Status files of sessions whose process is still alive. Cheap: a directory listing plus small JSON files. */
export function readStatusFiles(alive: Set<number>): StatusFile[] {
  let names: string[];
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out: StatusFile[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const pid = parseInt(n, 10);
    if (!alive.has(pid)) continue;
    try {
      out.push(JSON.parse(readFileSync(join(SESSIONS_DIR, n), "utf8")));
    } catch {
      // being rewritten right now: pick it up next refresh
    }
  }
  return out;
}

const transcriptPaths = new Map<string, string>();

/** Claude Code stores a session under ~/.claude/projects/<cwd with every non-alphanumeric as "-">/. */
export const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

function findTranscript(sessionId: string, cwd: string): string | undefined {
  const known = transcriptPaths.get(sessionId);
  if (known && existsSync(known)) return known;
  const direct = join(PROJECTS_DIR, projectSlug(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) {
    transcriptPaths.set(sessionId, direct);
    return direct;
  }
  // Every file call crosses Tinycast's native bridge, so the full folder scan is the fallback only.
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const p = join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
    if (existsSync(p)) {
      transcriptPaths.set(sessionId, p);
      return p;
    }
  }
  return undefined;
}

// Repo roots are found by walking up for a .git entry (a folder, or a file in worktrees),
// which costs a few existsSync calls instead of a git process. Git then runs once per repo.
const rootCache = new Map<string, string | null>();
const statusCache = new Map<string, { at: number; repo: Repo }>();

export function repoRoot(dir: string): string | undefined {
  const hit = rootCache.get(dir);
  if (hit !== undefined) return hit ?? undefined;
  let d = dir;
  let root: string | null = null;
  while (d && d !== "/" && d.startsWith("/")) {
    if (existsSync(join(d, ".git"))) {
      root = d;
      break;
    }
    if (d === HOME) break;
    d = d.slice(0, d.lastIndexOf("/")) || "/";
  }
  rootCache.set(dir, root);
  return root ?? undefined;
}

export async function repoOf(dir: string): Promise<Repo | undefined> {
  const root = repoRoot(dir);
  if (!root) return undefined;
  const hit = statusCache.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.repo;
  let repo: Repo = { root, ...repoIdentity(root), changes: 0 };
  try {
    const status = await run("/usr/bin/git", ["-C", root, "status", "--porcelain=v1", "--branch", "--untracked-files=normal"], 5000);
    const lines = status.split("\n").filter(Boolean);
    const head = lines[0]?.match(/^## (?:No commits yet on )?([^.\s]+)/)?.[1];
    repo = { root, ...repoIdentity(root), branch: head && head !== "HEAD" ? head : undefined, changes: lines.length - 1 };
  } catch {
    // not a readable repo after all: keep the root, skip branch and changes
  }
  statusCache.set(root, { at: Date.now(), repo });
  return repo;
}

/** Up to two distinct repos, trying edited folders first and the start folder last. Sequential, to keep git calls one at a time. */
export async function reposFor(dirs: string[]): Promise<Repo[]> {
  const repos: Repo[] = [];
  for (const dir of dirs) {
    const r = await repoOf(dir);
    if (r && !repos.some((x) => x.root === r.root)) repos.push(r);
    if (repos.length >= 2) break;
  }
  return repos;
}

export function located(cwd: string, repos: Repo[], fallbackBranch?: string) {
  const repo = repos[0];
  return {
    repo,
    otherRepos: repos.slice(1),
    workspace: describeWorkspace(repo?.root ?? cwd) ?? describeWorkspace(cwd),
    ticket: ticketFromBranch(repo?.branch ?? fallbackBranch),
  };
}

export function isKept(cwd: string, keep = readKeepList()): boolean {
  return keep.some((g) => globMatch(g, cwd));
}

export async function scanClaude(procs: Proc[], idle: Map<string, number>, withRepos = true): Promise<Session[]> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const keep = readKeepList();
  const sessions: Session[] = [];
  for (const f of readStatusFiles(new Set(byPid.keys()))) {
    const proc = byPid.get(f.pid)!;
    const transcriptPath = findTranscript(f.sessionId, f.cwd);
    const t = transcriptPath ? readTranscript(transcriptPath) : undefined;
    const repos = withRepos ? await reposFor([...(t?.editedDirs ?? []), f.cwd]) : [];
    const busy = f.status === "busy";
    sessions.push({
      tool: "claude",
      key: `claude-${f.pid}`,
      sessionId: f.sessionId,
      name: f.name ?? `pid ${f.pid}`,
      title: displayTitle(t?.title, t?.topic, f.cwd.split("/").pop()),
      origin: proc.tty ? `${f.entrypoint === "cli" || !f.entrypoint ? "CLI" : f.entrypoint} · ${proc.tty}` : (f.entrypoint ?? "app"),
      cwd: f.cwd,
      state: isKept(f.cwd, keep) ? "kept" : busy ? "working" : "waiting",
      busy,
      statusSince: f.statusUpdatedAt ?? f.updatedAt,
      startedAt: f.startedAt ?? Date.now() - parseEtime(proc.etime) * 1000,
      version: f.version,
      pid: f.pid,
      tty: proc.tty,
      idleSeconds: proc.tty ? idle.get(proc.tty) : undefined,
      rssKB: proc.rssKB,
      topic: t?.topic,
      lastPrompt: t?.lastPrompt,
      lastReply: t?.lastReply,
      lastMessageAt: t?.lastMessageAt,
      ...located(f.cwd, repos, t?.gitBranch),
      resumeCommand: `cd ${JSON.stringify(f.cwd)} && claude --resume ${f.sessionId}`,
    });
  }
  return sessions;
}

// ---------- claude-reap ----------

export interface ReapVictim {
  pid: number;
  tty: string;
  idleSeconds: number;
  rssKB: number;
  kind: "session" | "shell";
  cwd: string;
}

export interface ReapResult {
  mode: "dry-run" | "apply";
  before: { freeMB: number; compressorMB: number; swapUsedMB: number };
  after: { freeMB: number; compressorMB: number; swapUsedMB: number } | null;
  victims: ReapVictim[];
  kept: Omit<ReapVictim, "rssKB">[];
  reclaimKB: number;
  stragglers: number[];
}

export async function reap(reapPath: string, idle: string, apply: boolean, only?: number[]): Promise<ReapResult> {
  // Applying always names the exact PIDs the person confirmed; claude-reap re-checks each is still reapable.
  if (apply && !only?.length) throw new Error("Refusing to reap without an explicit PID list");
  const args = ["--json", "--idle", idle];
  if (apply) args.push("--apply");
  if (only) args.push("--only", only.join(","));
  const out = await run(expandTilde(reapPath), args, 30_000);
  return JSON.parse(out) as ReapResult;
}
