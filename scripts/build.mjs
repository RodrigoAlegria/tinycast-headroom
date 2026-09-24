import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Tinycast loads <command-name>.js from the extension root.
await build({
  entryPoints: { index: resolve(root, "src/index.tsx") },
  outdir: dist,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  minify: true,
  external: ["@raycast/api", "react", "react/jsx-runtime", "fs", "os", "path", "child_process"],
});
cpSync(resolve(root, "package.json"), resolve(dist, "package.json"));
cpSync(resolve(root, "package.json"), resolve(dist, "manifest.json"));
cpSync(resolve(root, "assets"), resolve(dist, "assets"), { recursive: true });
for (const name of ["README.md", "LICENSE"]) cpSync(resolve(root, name), resolve(dist, name));
console.log("Built Tinycast extension in dist/");
