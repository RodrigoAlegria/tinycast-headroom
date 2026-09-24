import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const target = resolve(homedir(), "Library/Application Support/com.tinycast.app/extensions/tinycast-headroom");
if (!existsSync(resolve(dist, "index.js"))) throw new Error("Build first: npm run build");
cpSync(dist, target, { recursive: true, force: true });
console.log(`Installed to ${target}`);
console.log("Open: tinycast://extensions/rodrigoalegria/tinycast-headroom/index");
