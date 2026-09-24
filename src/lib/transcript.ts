import { closeSync, openSync, readSync, statSync } from "fs";
import { dirname } from "path";

// Transcripts grow to tens of MB, so only the two ends are ever read:
// the head holds the first prompt (the topic), the tail holds the latest activity.
export const WINDOW_BYTES = 64 * 1024;

export interface TranscriptSummary {
  title?: string; // Claude's own generated title (ai-title), or a title the person set
  topic?: string;
  lastReply?: string;
  lastPrompt?: string;
  lastMessageAt?: number; // epoch ms
  gitBranch?: string;
  editedDirs: string[]; // most recent first, unique
  sizeBytes: number;
}

type Entry = {
  type?: string;
  aiTitle?: string;
  customTitle?: string;
  isMeta?: boolean;
  timestamp?: string;
  gitBranch?: string;
  message?: { content?: unknown };
};

/** The text a person typed, or undefined for tool results, commands and injected context. */
export function promptText(entry: Entry): string | undefined {
  if (entry.type !== "user" || entry.isMeta) return undefined;
  const content = entry.message?.content;
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const part of content as Array<{ type?: string; text?: string }>) {
      if (part?.type === "tool_result") return undefined;
      if (part?.type === "text" && typeof part.text === "string") text = part.text;
    }
  }
  // Drop pasted blocks and injected context, keep what was typed around them.
  // Closing tags may carry attributes (</pasted_content id="x">); an unclosed block runs to the end.
  text = text?.replace(/<([a-z_-]+)[^>]*>[\s\S]*?(?:<\/\1[^>]*>|$)/g, " ").trim();
  if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return undefined;
  return text;
}

/** "/analyze" from a slash-command entry, used as a topic when no prompt was typed. */
export function slashCommand(entry: Entry): string | undefined {
  if (entry.type !== "user") return undefined;
  const c = entry.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? (c as Array<{ text?: string }>).map((p) => p?.text ?? "").join(" ") : "";
  return text.match(/<command-name>(\/[^<]+)<\/command-name>/)?.[1];
}

/** Complete JSON lines in a window. A window that starts or ends mid-line drops that partial line. */
export function linesOf(chunk: string, cutStart: boolean, cutEnd: boolean): Entry[] {
  const lines = chunk.split("\n");
  if (cutStart) lines.shift();
  if (cutEnd) lines.pop();
  const entries: Entry[] = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // partial or corrupt line: skip
    }
  }
  return entries;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function summarize(head: Entry[], tail: Entry[], sizeBytes: number): TranscriptSummary {
  let topic: string | undefined;
  let command: string | undefined;
  for (const e of head) {
    command ??= slashCommand(e);
    const t = promptText(e);
    if (t) {
      topic = oneLine(t, 90);
      break;
    }
  }
  let title: string | undefined;
  let lastReply: string | undefined;
  let lastPrompt: string | undefined;
  let lastMessageAt: number | undefined;
  let gitBranch: string | undefined;
  const editedDirs: string[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (lastMessageAt === undefined && (e.type === "user" || e.type === "assistant") && e.timestamp) {
      const t = Date.parse(e.timestamp);
      if (!Number.isNaN(t)) lastMessageAt = t;
    }
    if (!gitBranch && e.gitBranch && e.gitBranch !== "HEAD") gitBranch = e.gitBranch;
    if (!title && (e.type === "custom-title" || e.type === "ai-title")) title = (e.customTitle ?? e.aiTitle)?.trim() || undefined;
    if (!lastReply && e.type === "assistant" && Array.isArray(e.message?.content)) {
      const text = (e.message!.content as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === "text" && p.text?.trim())
        .map((p) => p.text!)
        .join(" ");
      if (text) lastReply = oneLine(text.replace(/[*_`#>]/g, ""), 240);
    }
    if (!lastPrompt) {
      const t = promptText(e);
      if (t) lastPrompt = oneLine(t, 110);
    }
    for (const dir of editedDirsOf(e)) if (!editedDirs.includes(dir)) editedDirs.push(dir);
  }
  if (!topic) topic = command ?? lastPrompt;
  if (!title) {
    for (const e of head) if (e.type === "custom-title" || e.type === "ai-title") title = (e.customTitle ?? e.aiTitle)?.trim() || title;
  }
  return { title, topic, lastReply, lastPrompt, lastMessageAt, gitBranch, editedDirs: editedDirs.slice(0, 5), sizeBytes };
}

function editedDirsOf(e: Entry): string[] {
  if (e.type !== "assistant" || !Array.isArray(e.message?.content)) return [];
  const dirs: string[] = [];
  for (const part of e.message!.content as Array<{ type?: string; name?: string; input?: { file_path?: string } }>) {
    const file = part?.type === "tool_use" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(part.name ?? "") ? part.input?.file_path : undefined;
    // Memory notes, scratch files and temp dirs say nothing about which repo the session works in.
    if (file && file.startsWith("/") && !/\/\.claude\/|^\/(private\/)?tmp\/|^\/private\/var\//.test(file)) dirs.push(dirname(file));
  }
  return dirs;
}

// When the tail has no edits, walk backwards in 256 KB steps for the most recent ones, up to 8 MB.
// Runs at most once per transcript; the answer is kept until the tail shows newer edits.
// Only lines that mention an edit tool are JSON-parsed, so the walk is mostly string scanning.
const SCAN_STEP = 256 * 1024;
const SCAN_LIMIT = 8 * 1024 * 1024;
const EDIT_HINT = /"name":"(?:Edit|Write|MultiEdit|NotebookEdit)"/;

function scanBackForEdits(fd: number, size: number): string[] {
  let end = Math.max(0, size - WINDOW_BYTES);
  const floor = Math.max(0, size - SCAN_LIMIT);
  while (end > floor) {
    const start = Math.max(floor, end - SCAN_STEP);
    const chunk = readWindow(fd, start, end - start);
    const entries = EDIT_HINT.test(chunk) ? linesOf(chunk.split("\n").filter((l, i, all) => EDIT_HINT.test(l) || i === 0 || i === all.length - 1).join("\n"), start > 0, true) : [];
    const dirs: string[] = [];
    for (let i = entries.length - 1; i >= 0; i--) for (const d of editedDirsOf(entries[i])) if (!dirs.includes(d)) dirs.push(d);
    if (dirs.length) return dirs.slice(0, 5);
    end = start + 1024; // overlap so a line cut at the boundary is read whole next time
    if (start === floor) break;
  }
  return [];
}

const olderEdits = new Map<string, string[]>();

export function readWindow(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n).toString("utf8");
}

const cache = new Map<string, TranscriptSummary>();

/** Summary of one transcript, re-read only when its size changes. */
export function readTranscript(path: string): TranscriptSummary | undefined {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return undefined;
  }
  const hit = cache.get(path);
  if (hit && hit.sizeBytes === size) return hit;

  const fd = openSync(path, "r");
  try {
    const headLen = Math.min(WINDOW_BYTES, size);
    const head = linesOf(readWindow(fd, 0, headLen), false, headLen < size);
    const tailStart = Math.max(0, size - WINDOW_BYTES);
    const tail = tailStart === 0 ? head : linesOf(readWindow(fd, tailStart, size - tailStart), true, false);
    const summary = summarize(head, tail, size);
    if (!summary.editedDirs.length && tailStart > 0) {
      if (!olderEdits.has(path)) olderEdits.set(path, scanBackForEdits(fd, size));
      summary.editedDirs = olderEdits.get(path)!;
    }
    cache.set(path, summary);
    return summary;
  } finally {
    closeSync(fd);
  }
}
