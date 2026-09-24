import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { linesOf, promptText, readTranscript, summarize, WINDOW_BYTES } from "../src/lib/transcript";

const user = (content: unknown, extra = {}) => ({ type: "user", timestamp: "2026-09-24T10:00:00.000Z", message: { content }, ...extra });
const assistant = (ts: string, content: unknown[] = [], gitBranch = "HEAD") => ({ type: "assistant", timestamp: ts, gitBranch, message: { content } });
const edit = (file_path: string) => ({ type: "tool_use", name: "Edit", input: { file_path } });

test("prompt text skips tool results, meta and injected tags", () => {
  assert.equal(promptText(user("Fix the login redirect") as never), "Fix the login redirect");
  assert.equal(promptText(user([{ type: "text", text: "check now" }]) as never), "check now");
  assert.equal(promptText(user([{ type: "tool_result", content: "x" }]) as never), undefined);
  assert.equal(promptText(user("<command-name>/clear</command-name>") as never), undefined);
  assert.equal(promptText(user("hello", { isMeta: true }) as never), undefined);
});

test("summary: topic from the head, latest activity from the tail", () => {
  const head = [user("<system-reminder>ctx</system-reminder>"), user("Get this worktree up to date"), assistant("2026-09-24T09:00:00.000Z")];
  const tail = [
    user("fix all you need to fix"),
    assistant("2026-09-24T10:39:00.000Z", [edit("/Users/me/orca/workspaces/app/feature-login/backend/settings.py"), edit("/Users/me/work/.worktrees/x/a.py")], "fix/ABC-123_login-redirect"),
    user([{ type: "tool_result", content: "ok" }]),
    assistant("2026-09-24T10:40:07.548Z"),
  ];
  const s = summarize(head as never, tail as never, 1000);
  assert.equal(s.topic, "Get this worktree up to date");
  assert.equal(s.lastPrompt, "fix all you need to fix");
  assert.equal(s.lastMessageAt, Date.parse("2026-09-24T10:40:07.548Z"));
  assert.equal(s.gitBranch, "fix/ABC-123_login-redirect");
  assert.deepEqual(s.editedDirs, ["/Users/me/orca/workspaces/app/feature-login/backend", "/Users/me/work/.worktrees/x"]);
});

test("windows drop partial lines at the cut", () => {
  const chunk = `tail of a line"}\n${JSON.stringify(user("a"))}\n{"type":"user","mess`;
  assert.equal(linesOf(chunk, true, true).length, 1);
});

test("reads only the two ends of a large transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "headroom-"));
  const path = join(dir, "s.jsonl");
  const filler = JSON.stringify(assistant("2026-09-20T00:00:00.000Z", [{ type: "text", text: "x".repeat(2000) }]));
  const lines = [JSON.stringify(user("The very first prompt"))];
  while (lines.join("\n").length < WINDOW_BYTES * 4) lines.push(filler);
  lines.push(JSON.stringify(user("The latest prompt")), JSON.stringify(assistant("2026-09-24T11:42:00.000Z")));
  writeFileSync(path, `${lines.join("\n")}\n`);
  const s = readTranscript(path)!;
  assert.equal(s.topic, "The very first prompt");
  assert.equal(s.lastPrompt, "The latest prompt");
  assert.equal(s.lastMessageAt, Date.parse("2026-09-24T11:42:00.000Z"));
  assert.ok(readTranscript(path) === s, "unchanged file is served from cache");
});

test("pasted blocks are stripped from prompts; slash commands become a fallback topic", () => {
  assert.equal(promptText(user("Trying to install Tinycast but error <pasted_content id=\"a\">lots\nof\nlog</pasted_content>") as never), "Trying to install Tinycast but error");
  assert.equal(promptText(user("Install error\n\n<pasted_content id=\"4f10\">\nlog\n</pasted_content id=\"4f10\">") as never), "Install error");
  assert.equal(promptText(user("Cut off <pasted_content id=\"b\">never closed") as never), "Cut off");
  const s = summarize([user("<command-message>analyze</command-message>\n<command-name>/analyze</command-name>")] as never, [] as never, 10);
  assert.equal(s.topic, "/analyze");
});

test("edits older than the tail window are found by the backward scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "headroom-"));
  const path = join(dir, "old-edit.jsonl");
  const filler = JSON.stringify(assistant("2026-09-20T00:00:00.000Z", [{ type: "text", text: "y".repeat(2000) }]));
  const lines = [
    JSON.stringify(user("start")),
    JSON.stringify(assistant("2026-09-21T00:00:00.000Z", [edit("/Users/me/work/.worktrees/api-abc-42-cache/app/x.py")])),
    JSON.stringify(assistant("2026-09-21T00:01:00.000Z", [edit("/Users/me/.claude/projects/-Users-me-work/memory/note.md")])),
  ];
  while (lines.join("\n").length < WINDOW_BYTES * 6) lines.push(filler);
  writeFileSync(path, `${lines.join("\n")}\n`);
  assert.deepEqual(readTranscript(path)!.editedDirs, ["/Users/me/work/.worktrees/api-abc-42-cache/app"]);
});

test("Claude's generated title and last reply come from the tail", () => {
  const tail = [
    { type: "ai-title", aiTitle: "Billing page" },
    user("resume the billing page work"),
    assistant("2026-09-24T11:48:00.000Z", [{ type: "text", text: "**Done.** The plan is *updated*." }]),
  ];
  const s = summarize([] as never, tail as never, 10);
  assert.equal(s.title, "Billing page");
  assert.equal(s.lastReply, "Done. The plan is updated.");
});

test("a title the person set wins over an older generated one", () => {
  const s = summarize([] as never, [{ type: "ai-title", aiTitle: "Old" }, { type: "custom-title", customTitle: "My name" }] as never, 10);
  assert.equal(s.title, "My name");
});
