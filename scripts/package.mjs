// Builds the release download: tinycast-headroom.zip (the dist folder, named like the extension) + SHA256SUMS.
import { execFileSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const out = resolve(root, "release");
if (!existsSync(resolve(dist, "index.js"))) throw new Error("Build first: npm run build");
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "stage"), { recursive: true });
cpSync(dist, resolve(out, "stage/tinycast-headroom"), { recursive: true });
execFileSync("/usr/bin/zip", ["-qrX", "../tinycast-headroom.zip", "tinycast-headroom", "-x", "*.DS_Store"], { cwd: resolve(out, "stage") });
rmSync(resolve(out, "stage"), { recursive: true, force: true });
const hash = createHash("sha256");
await new Promise((ok, fail) => createReadStream(resolve(out, "tinycast-headroom.zip")).on("data", (d) => hash.update(d)).on("end", ok).on("error", fail));
writeFileSync(resolve(out, "SHA256SUMS"), `${hash.digest("hex")}  tinycast-headroom.zip\n`);
console.log("release/tinycast-headroom.zip + release/SHA256SUMS");
