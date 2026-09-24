import assert from "node:assert/strict";
import { test } from "node:test";
import { compareBars, memoryPanel } from "../src/lib/charts";
import { versionLag } from "../src/lib/focus";
import { nextPressureState } from "../src/lib/pressure";
import type { Memory } from "../src/lib/parse";

test("version lag", () => {
  assert.equal(versionLag("2.1.263", "2.1.281"), "18 versions behind 2.1.281");
  assert.equal(versionLag("2.1.280", "2.1.281"), "1 version behind 2.1.281");
  assert.equal(versionLag("2.1.281", "2.1.281"), undefined);
  assert.equal(versionLag("2.1.290", "2.1.281"), undefined, "newer than installed is not behind");
  assert.equal(versionLag("2.0.9", "2.1.281"), "outdated, 2.1.281 is installed");
  assert.equal(versionLag(undefined, "2.1.281"), undefined);
});

test("pressure 'since' is only claimed when watched without gaps", () => {
  const t0 = 1_790_000_000_000;
  const first = nextPressureState(undefined, "warning", t0);
  assert.deepEqual([first.since, first.observed], [t0, false], "first sighting: seen since, not since");
  const same = nextPressureState(first, "warning", t0 + 5000);
  assert.equal(same.since, t0);
  const change = nextPressureState(same, "normal", t0 + 10_000);
  assert.deepEqual([change.since, change.observed], [t0 + 10_000, true], "a change we saw happen is a real since");
  const afterGap = nextPressureState(change, "normal", t0 + 10_000 + 6 * 60_000);
  assert.equal(afterGap.observed, false, "after 6 unwatched minutes the start time is no longer trusted");
});

const svgOf = (uri: string) => Buffer.from(uri.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");
const memory: Memory = { pressure: "warning", totalMB: 16384, freeMB: 80, wiredMB: 3072, compressedMB: 6400, swapUsedMB: 4800, swapTotalMB: 6144 };

test("memory panel is an SVG with the swap percentage and legend", () => {
  const svg = svgOf(memoryPanel(memory));
  assert.match(svg, /^<svg [^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, />78%</);
  assert.match(svg, /Compressed 6\.3 GB/);
  assert.ok(!/NaN|undefined/.test(svg));
});

test("compare bars escape labels and never draw negative widths", () => {
  const svg = svgOf(compareBars([{ label: "A & <B>", mb: 0, color: "#000" }, { label: "Dia", mb: 2563, color: "#111" }], 4096));
  assert.match(svg, /A &amp; &lt;B>/);
  assert.ok(!/width="-/.test(svg));
});

test("the bundled claude-reap runs through bash and refuses --ignore-idle without --only", async () => {
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const script = join(__dirname, "..", "assets", "claude-reap");
  const refused = spawnSync("/bin/bash", [script, "--ignore-idle", "--json"], { encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /needs --only/);
  const help = spawnSync("/bin/bash", [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--ignore-idle/);
});
