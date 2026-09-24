import { execFile } from "child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "fs";
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
import { readTranscript } from "./transcript";

export const HOME = homedir();
const ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME, LANG: "en_US.UTF-8" };

export function run(cmd: string, args: string[], timeoutMs = 5000, maxBuffer = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: ENV, timeout: timeoutMs, maxBuffer, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
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

export interface Session {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  state: SessionState;
  busy: boolean;
  statusSince?: number;
  startedAt?: number;
  version?: string;
  tty: string;
  idleSeconds?: number;
  rssKB: number;
  topic?: string;
  lastPrompt?: string;
  lastMessageAt?: number;
  repo?: Repo;
  otherRepos: Repo[];
  workspace?: string;
  ticket?: string;
  transcriptPath?: string;
}

export interface Repo {
  root: string;
  branch?: string;
  changes: number;
}

interface StatusFile {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  status?: string;
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

function findTranscript(sessionId: string): string | undefined {
  const known = transcriptPaths.get(sessionId);
  if (known && existsSync(known)) return known;
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

// git answers are cached for 30 s per folder; branch and change counts don't move faster than that.
const gitCache = new Map<string, { at: number; repo?: Repo }>();

async function repoOf(dir: string): Promise<Repo | undefined> {
  const hit = gitCache.get(dir);
  if (hit && Date.now() - hit.at < 30_000) return hit.repo;
  let repo: Repo | undefined;
  try {
    const root = (await run("/usr/bin/git", ["-C", dir, "rev-parse", "--show-toplevel"], 3000)).trim();
    const status = await run("/usr/bin/git", ["-C", root, "status", "--porcelain=v1", "--branch"], 5000);
    const lines = status.split("\n").filter(Boolean);
    const head = lines[0]?.match(/^## (?:No commits yet on )?([^.\s]+)/)?.[1];
    repo = { root, branch: head && head !== "HEAD" ? head : undefined, changes: lines.length - 1 };
  } catch {
    repo = undefined;
  }
  gitCache.set(dir, { at: Date.now(), repo });
  return repo;
}

export interface SessionScan {
  sessions: Session[];
  totalKB: number;
}

export async function scanSessions(procs: Proc[], idle: Map<string, number>, reapable: Set<number>): Promise<SessionScan> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const keep = readKeepList();
  const files = readStatusFiles(new Set(byPid.keys()));

  const sessions = await Promise.all(
    files.map(async (f): Promise<Session> => {
      const proc = byPid.get(f.pid)!;
      const idleSeconds = proc.tty ? idle.get(proc.tty) : undefined;
      const transcriptPath = findTranscript(f.sessionId);
      const t = transcriptPath ? readTranscript(transcriptPath) : undefined;

      const repos: Repo[] = [];
      for (const dir of [...(t?.editedDirs ?? []), f.cwd]) {
        const r = await repoOf(dir);
        if (r && !repos.some((x) => x.root === r.root)) repos.push(r);
        if (repos.length >= 2) break;
      }
      const repo = repos[0];
      const branch = repo?.branch ?? t?.gitBranch;
      const kept = keep.some((g) => globMatch(g, f.cwd));
      const busy = f.status === "busy";
      let state: SessionState = busy ? "working" : "waiting";
      // Only claude-reap's own dry run decides what is reapable, so we never offer a reap it would refuse.
      if (reapable.has(f.pid)) state = "reapable";
      else if (kept) state = "kept";

      return {
        pid: f.pid,
        sessionId: f.sessionId,
        name: f.name ?? `pid ${f.pid}`,
        cwd: f.cwd,
        state,
        busy,
        statusSince: f.statusUpdatedAt ?? f.updatedAt,
        startedAt: f.startedAt ?? Date.now() - parseEtime(proc.etime) * 1000,
        version: f.version,
        tty: proc.tty,
        idleSeconds,
        rssKB: proc.rssKB,
        topic: t?.topic,
        lastPrompt: t?.lastPrompt,
        lastMessageAt: t?.lastMessageAt,
        repo,
        otherRepos: repos.slice(1),
        workspace: describeWorkspace(repo?.root ?? f.cwd) ?? describeWorkspace(f.cwd),
        ticket: ticketFromBranch(branch),
        transcriptPath,
      };
    }),
  );

  const order: Record<SessionState, number> = { reapable: 0, working: 1, waiting: 2, kept: 3 };
  sessions.sort((a, b) => order[a.state] - order[b.state] || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  const totalKB = procs.filter((p) => /(^|\/)claude$/.test(p.comm)).reduce((s, p) => s + p.rssKB, 0);
  return { sessions, totalKB };
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
