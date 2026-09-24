import assert from "node:assert/strict";
import { test } from "node:test";
import { codexHead, codexTail, openCodeQuery, parseLsofRollouts } from "../src/lib/agents";

test("lsof: only open rollout files count, per pid", () => {
  const out = [
    "p71004",
    "n/Users/me/.codex/logs/codex-tui.log",
    "p83854",
    "n/dev/ttys010",
    "n/Users/me/.codex/sessions/2026/09/24/rollout-2026-09-24T12-12-46-01a0d31e.jsonl",
    "n/Users/me/.codex/sessions/2026/09/24/rollout-2026-09-24T12-12-46-01a0d31e.jsonl",
  ].join("\n");
  const map = parseLsofRollouts(out);
  assert.equal(map.has(71004), false, "Tinycast's own app-server has no rollout open");
  assert.deepEqual(map.get(83854), ["/Users/me/.codex/sessions/2026/09/24/rollout-2026-09-24T12-12-46-01a0d31e.jsonl"]);
});

const meta = { type: "session_meta", payload: { id: "01a0d31e", cwd: "/Users/me/work", originator: "codex-tui", cli_version: "0.149.0", timestamp: "2026-09-24T11:12:46.000Z", git: null } };
const userMsg = (text: string, ts: string) => ({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const event = (type: string, ts: string) => ({ timestamp: ts, type: "event_msg", payload: { type } });

test("codex head: meta and first typed prompt, skipping injected context", () => {
  const h = codexHead([meta, userMsg("<environment_context>…</environment_context>", "2026-09-24T11:12:49.9Z"), userMsg("ola", "2026-09-24T11:12:50.1Z")] as never);
  assert.equal(h.cwd, "/Users/me/work");
  assert.equal(h.originator, "codex-tui");
  assert.equal(h.topic, "ola");
});

test("codex tail: waiting after task_complete, working after task_started", () => {
  const done = codexTail([event("task_started", "2026-09-24T11:12:49Z"), userMsg("ola", "2026-09-24T11:12:50Z"), event("task_complete", "2026-09-24T11:12:51Z")] as never);
  assert.equal(done.busy, false);
  assert.equal(done.statusSince, Date.parse("2026-09-24T11:12:51Z"));
  assert.equal(done.lastPrompt, "ola");
  const running = codexTail([event("task_complete", "2026-09-24T11:00:00Z"), event("task_started", "2026-09-24T11:13:00Z")] as never);
  assert.equal(running.busy, true);
});

test("codex tail: files from apply_patch", () => {
  const patch = { timestamp: "2026-09-24T11:20:00Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n*** Add File: /Users/me/x/new.ts\n*** End Patch" } };
  assert.deepEqual(codexTail([patch] as never).editedFiles, ["src/app.ts", "/Users/me/x/new.ts"]);
});

test("opencode query filters subagents, archived and stale sessions", () => {
  const q = openCodeQuery(1790000000000);
  assert.match(q, /parent_id is null/);
  assert.match(q, /time_archived is null/);
  assert.match(q, /time_updated > 1790000000000/);
});
