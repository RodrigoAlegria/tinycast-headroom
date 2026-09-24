import { closeSync, openSync, readFileSync, statSync } from "fs";
import { basename, isAbsolute, join } from "path";
import { log, timed } from "./log";
import type { Proc } from "./parse";
import { displayTitle, HOME, located, reposFor, run, scanClaude, Session, Tool, ttyLastInput } from "./system";
import { linesOf, oneLine, readWindow, WINDOW_BYTES } from "./transcript";

// ---------- Codex ----------
// A live Codex session is one whose rollout file a codex process has open, whether it was
// started from a terminal, Orca or the Codex desktop app. Tinycast's own `codex app-server`
// holds no rollout open, so it never shows up.

const ROLLOUT = /\/\.codex\/(?:archived_)?sessions\/.*rollout-[^/]*\.jsonl$/;

/** `lsof -c codex -Fpn` → pid → open rollout files. */
export function parseLsofRollouts(text: string): Map<number, string[]> {
  const map = new Map<number, string[]>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = parseInt(line.slice(1), 10);
    else if (line.startsWith("n") && ROLLOUT.test(line.slice(1))) {
      const list = map.get(pid) ?? [];
      if (!list.includes(line.slice(1))) list.push(line.slice(1));
      map.set(pid, list);
    }
  }
  return map;
}

type CodexEntry = { timestamp?: string; type?: string; payload?: Record<string, unknown> & { type?: string } };

interface CodexHead {
  id?: string;
  cwd?: string;
  originator?: string;
  version?: string;
  gitBranch?: string;
  startedAt?: number;
  topic?: string;
}

export interface CodexTail {
  busy: boolean;
  statusSince?: number;
  lastMessageAt?: number;
  lastPrompt?: string;
  lastReply?: string;
  editedFiles: string[];
}

function codexPrompt(e: CodexEntry): string | undefined {
  const p = e.payload;
  if (e.type !== "response_item" || p?.type !== "message" || p.role !== "user" || !Array.isArray(p.content)) return undefined;
  for (const part of p.content as Array<{ type?: string; text?: string }>) {
    const text = part?.type === "input_text" ? part.text?.trim() : undefined;
    if (text && !text.startsWith("<")) return text;
  }
  return undefined;
}

export function codexHead(entries: CodexEntry[]): CodexHead {
  const meta = entries.find((e) => e.type === "session_meta")?.payload as
    | { id?: string; cwd?: string; originator?: string; cli_version?: string; timestamp?: string; git?: { branch?: string } | null }
    | undefined;
  let topic: string | undefined;
  for (const e of entries) {
    const t = codexPrompt(e);
    if (t) {
      topic = oneLine(t, 90);
      break;
    }
  }
  return {
    id: meta?.id,
    cwd: meta?.cwd,
    originator: meta?.originator,
    version: meta?.cli_version,
    gitBranch: meta?.git?.branch,
    startedAt: meta?.timestamp ? Date.parse(meta.timestamp) : undefined,
    topic,
  };
}

export function codexTail(entries: CodexEntry[]): CodexTail {
  const out: CodexTail = { busy: false, editedFiles: [] };
  let stateKnown = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const p = e.payload;
    const at = e.timestamp ? Date.parse(e.timestamp) : undefined;
    if (out.lastMessageAt === undefined && e.type === "response_item" && at) out.lastMessageAt = at;
    if (!stateKnown && e.type === "event_msg") {
      if (p?.type === "task_complete" || p?.type === "turn_aborted") {
        stateKnown = true;
        out.statusSince = at;
      } else if (p?.type === "task_started") {
        stateKnown = true;
        out.busy = true;
        out.statusSince = at;
      }
    }
    if (!out.lastPrompt) {
      const t = codexPrompt(e);
      if (t) out.lastPrompt = oneLine(t, 110);
    }
    if (!out.lastReply && e.type === "response_item" && p?.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      const text = (p.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c?.type === "output_text" && c.text?.trim())
        .map((c) => c.text!)
        .join(" ");
      if (text) out.lastReply = oneLine(text.replace(/[*_`#>]/g, ""), 240);
    }
    if (e.type === "response_item" && p?.type === "custom_tool_call" && p.name === "apply_patch" && typeof p.input === "string") {
      for (const m of p.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
        if (!out.editedFiles.includes(m[1])) out.editedFiles.push(m[1]);
      }
    }
  }
  return out;
}

const HEAD_BYTES = 192 * 1024; // the meta line and injected context take ~60 KB before the first prompt
const codexHeads = new Map<string, CodexHead>();
const codexTails = new Map<string, { size: number; tail: CodexTail }>();

function readCodex(path: string): { head: CodexHead; tail: CodexTail } | undefined {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return undefined;
  }
  const head = codexHeads.get(path);
  const tail = codexTails.get(path);
  if (head && tail && tail.size === size) return { head, tail: tail.tail };
  const fd = openSync(path, "r");
  try {
    let h = head;
    if (!h) {
      const len = Math.min(HEAD_BYTES, size);
      h = codexHead(linesOf(readWindow(fd, 0, len), false, len < size) as CodexEntry[]);
      codexHeads.set(path, h); // the start of a rollout never changes
    }
    const start = Math.max(0, size - WINDOW_BYTES);
    const t = codexTail(linesOf(readWindow(fd, start, size - start), start > 0, false) as CodexEntry[]);
    codexTails.set(path, { size, tail: t });
    return { head: h, tail: t };
  } finally {
    closeSync(fd);
  }
}

let threadNames: { size: number; names: Map<string, string> } | undefined;

function codexThreadName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const path = join(HOME, ".codex/session_index.jsonl");
  try {
    const size = statSync(path).size;
    if (!threadNames || threadNames.size !== size) {
      const names = new Map<string, string>();
      for (const line of readFileSync(path, "utf8").split("\n")) {
        try {
          const e = JSON.parse(line) as { id?: string; thread_name?: string };
          if (e.id && e.thread_name) names.set(e.id, e.thread_name);
        } catch {
          // skip partial line
        }
      }
      threadNames = { size, names };
    }
    return threadNames.names.get(id);
  } catch {
    return undefined;
  }
}

export async function scanCodex(procs: Proc[], idle: Map<string, number>, withRepos = true): Promise<Session[]> {
  const codexPids = procs.filter((p) => /(^|\/)codex$/.test(p.comm));
  if (!codexPids.length) return [];
  let lsof = "";
  try {
    lsof = await run("/usr/sbin/lsof", ["-c", "codex", "-a", "-d", "0-9999", "-Fpn"], 5000);
  } catch (e) {
    // lsof exits 1 when a listed process has nothing matching; its output is still usable
    lsof = (e as { stdout?: string }).stdout ?? "";
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const sessions: Session[] = [];
  for (const [pid, paths] of parseLsofRollouts(lsof)) {
    const proc = byPid.get(pid);
    for (const path of paths) {
      const r = readCodex(path);
      if (!r) continue;
      const { head, tail } = r;
      const cwd = head.cwd ?? HOME;
      const edited = tail.editedFiles.map((f) => (isAbsolute(f) ? f : join(cwd, f))).map((f) => f.slice(0, f.lastIndexOf("/")));
      const repos = withRepos ? await reposFor([...new Set(edited)].slice(0, 5).concat(cwd)) : [];
      const desktop = head.originator && /desktop/i.test(head.originator);
      const id = head.id ?? basename(path, ".jsonl");
      sessions.push({
        tool: "codex",
        key: `codex-${id}`,
        sessionId: id,
        name: codexThreadName(head.id) ?? `codex · ${basename(cwd)}`,
        title: displayTitle(codexThreadName(head.id), head.topic, tail.lastPrompt, basename(cwd)),
        origin: desktop ? "Codex Desktop" : proc?.tty ? `CLI · ${proc.tty}` : (head.originator ?? "Codex"),
        cwd,
        state: tail.busy ? "working" : "waiting",
        busy: tail.busy,
        statusSince: tail.statusSince,
        startedAt: head.startedAt,
        version: head.version,
        pid,
        tty: proc?.tty,
        idleSeconds: proc?.tty ? idle.get(proc.tty) : undefined,
        lastInputAt: ttyLastInput(proc?.tty),
        rssKB: paths.length === 1 ? proc?.rssKB : undefined, // an app-server hosting several threads can't split its memory
        topic: head.topic ?? tail.lastPrompt,
        lastPrompt: tail.lastPrompt,
        lastReply: tail.lastReply,
        lastMessageAt: tail.lastMessageAt,
        ...located(cwd, repos, head.gitBranch),
        resumeCommand: `cd ${JSON.stringify(cwd)} && codex resume ${id}`,
      });
    }
  }
  return sessions;
}

// ---------- OpenCode ----------
// OpenCode (desktop app or CLI) keeps every session in one SQLite database. While any OpenCode
// process runs, sessions touched in the last 24 h are listed. Read-only, one query per refresh.

const OPENCODE_DB = join(HOME, ".local/share/opencode/opencode.db");
const OPENCODE_WINDOW_MS = 24 * 3600 * 1000;

interface OpenCodeRow {
  id: string;
  title?: string;
  directory: string;
  time_created: number;
  time_updated: number;
  version?: string;
  model?: string;
  last_role?: string;
  last_completed?: number | null;
  last_prompt?: string | null;
  last_reply?: string | null;
}

export function openCodeQuery(since: number): string {
  return `select s.id, s.title, s.directory, s.time_created, s.time_updated, s.version,
    json_extract(s.model, '$.id') as model,
    json_extract(m.data, '$.role') as last_role,
    json_extract(m.data, '$.time.completed') as last_completed,
    (select json_extract(p.data, '$.text') from part p
       where p.message_id = (select u.id from message u where u.session_id = s.id and json_extract(u.data, '$.role') = 'user'
                             order by u.time_created desc limit 1)
         and json_extract(p.data, '$.type') = 'text' and ifnull(json_extract(p.data, '$.synthetic'), 0) = 0
       order by p.id limit 1) as last_prompt,
    (select group_concat(json_extract(p.data, '$.text'), ' ') from part p
       where p.message_id = (select a.id from message a where a.session_id = s.id and json_extract(a.data, '$.role') = 'assistant'
                             order by a.time_created desc limit 1)
         and json_extract(p.data, '$.type') = 'text') as last_reply
  from session s
  left join message m on m.id = (select id from message where session_id = s.id order by time_created desc limit 1)
  where s.parent_id is null and s.time_archived is null and s.time_updated > ${Math.floor(since)}
  order by s.time_updated desc limit 15`;
}

export async function scanOpenCode(procs: Proc[], withRepos = true): Promise<Session[]> {
  const running = procs.filter((p) => /OpenCode\.app\/|(^|\/)opencode$/.test(p.comm));
  if (!running.length) return [];
  const desktop = running.some((p) => p.comm.includes("OpenCode.app/"));
  // Not -readonly: a read-only connection can't open a WAL database while its -shm file is missing or
  // being recreated (SQLITE_CANTOPEN). query_only still refuses every write.
  const out = await run(
    "/usr/bin/sqlite3",
    ["-json", "-cmd", ".timeout 2000", "-cmd", "PRAGMA query_only=1", OPENCODE_DB, openCodeQuery(Date.now() - OPENCODE_WINDOW_MS)],
    5000,
  );
  const rows = (out.trim() ? JSON.parse(out) : []) as OpenCodeRow[];
  const sessions: Session[] = [];
  for (const r of rows) {
    const busy = r.last_role === "user" || (r.last_role === "assistant" && !r.last_completed);
    const repos = withRepos ? await reposFor([r.directory]) : [];
    sessions.push({
      tool: "opencode",
      key: `opencode-${r.id}`,
      sessionId: r.id,
      name: r.title || `opencode · ${basename(r.directory)}`,
      title: displayTitle(r.title, r.last_prompt ?? undefined, basename(r.directory)),
      origin: desktop ? "OpenCode Desktop" : "OpenCode CLI",
      cwd: r.directory,
      state: busy ? "working" : "waiting",
      busy,
      statusSince: r.time_updated,
      startedAt: r.time_created,
      version: r.version,
      model: r.model,
      topic: r.title,
      lastPrompt: r.last_prompt ? oneLine(r.last_prompt, 110) : undefined,
      lastReply: r.last_reply ? oneLine(r.last_reply.replace(/[*_`#>]/g, ""), 240) : undefined,
      lastMessageAt: r.time_updated,
      ...located(r.directory, repos),
      resumeCommand: `cd ${JSON.stringify(r.directory)} && opencode --session ${r.id}`,
    });
  }
  return sessions;
}

// ---------- all tools ----------

export interface AgentScan {
  sessions: Session[];
  errors: Partial<Record<Tool, string>>;
}

/** Each tool is scanned on its own, so one failing source never hides the others. */
/** `withRepos: false` is the fast first pass (no git); the second pass fills in repo, branch and changes. */
export async function scanAgents(command: string, procs: Proc[], idle: Map<string, number>, withRepos = true): Promise<AgentScan> {
  const errors: AgentScan["errors"] = {};
  const sessions: Session[] = [];
  const sources: Array<[Tool, () => Promise<Session[]>]> = [
    ["claude", () => scanClaude(procs, idle, withRepos)],
    ["codex", () => scanCodex(procs, idle, withRepos)],
    ["opencode", () => scanOpenCode(procs, withRepos)],
  ];
  for (const [tool, scan] of sources) {
    try {
      sessions.push(...(await timed(command, `scan ${tool}${withRepos ? "" : " (fast pass)"}`, scan, 1000)));
    } catch (e) {
      errors[tool] = e instanceof Error ? e.message : String(e);
    }
  }
  const order = { reapable: 0, working: 1, waiting: 2, kept: 3 } as const;
  sessions.sort((a, b) => order[a.state] - order[b.state] || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  if (Object.keys(errors).length) log(command, `scan finished with errors: ${JSON.stringify(errors)}`);
  return { sessions, errors };
}

