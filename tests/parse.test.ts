import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeWorkspace,
  globMatch,
  groupApps,
  parseEtime,
  parseIdle,
  parseMemory,
  parsePs,
  parseSwap,
  parseW,
  thresholdSeconds,
  ticketFromBranch,
} from "../src/lib/parse";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5120.
Pages active:                            204637.
Pages wired down:                        184089.
Pages stored in compressor:             1521085.
Pages occupied by compressor:            411114.
`;

test("memory: sysctl + vm_stat", () => {
  const m = parseMemory("2\ntotal = 5120.00M  used = 3664.12M  free = 1455.88M  (encrypted)\n17179869184\n", VM_STAT);
  assert.equal(m.pressure, "warning");
  assert.equal(m.totalMB, 16384);
  assert.equal(m.freeMB, 80);
  assert.equal(Math.round(m.compressedMB), 6424);
  assert.equal(m.swapUsedMB, 3664.12);
  assert.equal(m.swapTotalMB, 5120);
});

test("pressure levels", () => {
  assert.equal(parseMemory("1\n\n0", "").pressure, "normal");
  assert.equal(parseMemory("4\n\n0", "").pressure, "critical");
});

test("swap in gigabytes", () => {
  assert.deepEqual(parseSwap("total = 6.00G  used = 1.50G  free = 4.50G"), { usedMB: 1536, totalMB: 6144 });
});

test("w idle column", () => {
  assert.equal(parseIdle("-"), 0);
  assert.equal(parseIdle("14"), 840);
  assert.equal(parseIdle("2:41"), 9660);
  assert.equal(parseIdle("09:05"), 32700);
  assert.equal(parseIdle("1day"), 86400);
  assert.equal(parseIdle("16days"), 1382400);
  const w = parseW("rodrigo console  -        08Sep26 16days -\nrodrigo s005     -        08Sep26 16days claude\nrodrigo s004     -        10:24       14 claude\n");
  assert.equal(w.get("s005"), 1382400);
  assert.equal(w.get("s004"), 840);
});

test("ps rows, tty normalised to w form", () => {
  const procs = parsePs(
    [
      "44887  84704 ttys005 16-03:51:26 claude",
      "  401 120000 ??      16-03:43:26 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
      "71000 781000 ??         01:02:03 /Applications/Orca.app/Contents/MacOS/Orca",
      "71001 300000 ??         01:02:03 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
      "71002 100000 ??         01:02:03 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].join("\n"),
  );
  assert.equal(procs.length, 5);
  assert.deepEqual(procs[0], { pid: 44887, rssKB: 84704, tty: "s005", etime: "16-03:51:26", comm: "claude" });
  assert.equal(procs[1].tty, "");

  const apps = groupApps(procs);
  assert.deepEqual(
    apps.map((a) => [a.name, a.rssKB, a.processes, a.quittable]),
    [
      ["Orca", 781000, 1, true],
      ["Google Chrome", 400000, 2, true],
      ["WindowServer", 120000, 1, false],
      ["Claude Code", 84704, 1, false],
    ],
  );
});

test("etime", () => {
  assert.equal(parseEtime("23:24"), 1404);
  assert.equal(parseEtime("01:43:13"), 6193);
  assert.equal(parseEtime("16-03:51:26"), 1396286);
});

test("ticket from branch", () => {
  assert.equal(ticketFromBranch("fix/SEW2-3455_uwsgi-home"), "SEW2-3455");
  assert.equal(ticketFromBranch("features/how2-748_flag-workflow-slug"), "HOW2-748");
  assert.equal(ticketFromBranch("features/HOW-517_portal"), "HOW-517");
  assert.equal(ticketFromBranch("main"), undefined);
  assert.equal(ticketFromBranch(undefined), undefined);
});

test("workspace", () => {
  assert.equal(describeWorkspace("/Users/r/orca/workspaces/AI.People21.AppRepo/murex"), "Orca · AI.People21.AppRepo / murex");
  assert.equal(describeWorkspace("/Users/r/Sewa/.worktrees/aiagent-how2-748-slug/app"), "Worktree · aiagent-how2-748-slug");
  assert.equal(describeWorkspace("/Users/r/Sewa"), undefined);
});

test("keep-list globs behave like bash [[ == ]]", () => {
  assert.ok(globMatch("*/StockTradingTool", "/Users/r/StockTradingTool"));
  assert.ok(globMatch("*/AI.People21.AppRepo/palolo", "/Users/r/orca/workspaces/AI.People21.AppRepo/palolo"));
  assert.ok(!globMatch("*/StockTradingTool", "/Users/r/StockTradingTool/sub"));
  assert.ok(!globMatch("*/AI.People21.AppRepo/palolo", "/Users/r/AIxPeople21xAppRepo/palolo"));
});

test("threshold spec", () => {
  assert.equal(thresholdSeconds("30m"), 1800);
  assert.equal(thresholdSeconds("12h"), 43200);
  assert.equal(thresholdSeconds("2d"), 172800);
});

test("claude project folder from a session's cwd", async () => {
  const { projectSlug } = await import("../src/lib/system");
  assert.equal(projectSlug("/Users/rodrigoalegria/orca/workspaces/AI.People21.AppRepo/murex"), "-Users-rodrigoalegria-orca-workspaces-AI-People21-AppRepo-murex");
  assert.equal(projectSlug("/Users/rodrigoalegria/Sewa"), "-Users-rodrigoalegria-Sewa");
});

test("row titles fall back and trim", async () => {
  const { displayTitle } = await import("../src/lib/system");
  assert.equal(displayTitle(undefined, "  first   prompt ", "Sewa"), "first prompt");
  assert.equal(displayTitle(undefined, undefined, undefined), "Untitled session");
  assert.equal(displayTitle("x".repeat(80)).length, 60);
});

test("a linked worktree reports its main repo's name", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { repoIdentity } = await import("../src/lib/system");
  const root = join(mkdtempSync(join(tmpdir(), "headroom-")), "aiagent-how2-748-slug");
  mkdirSync(root);
  writeFileSync(join(root, ".git"), "gitdir: /Users/r/Sewa/AI.People21.AIAgent/.git/worktrees/aiagent-how2-748-slug\n");
  assert.deepEqual(repoIdentity(root), { name: "AI.People21.AIAgent", worktree: "aiagent-how2-748-slug" });
  assert.deepEqual(repoIdentity("/Users/r/orca/workspaces/AI.People21.AppRepo/murex"), { name: "AI.People21.AppRepo", worktree: "murex" });
});
