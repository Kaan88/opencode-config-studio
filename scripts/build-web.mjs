// Bundles the UI into dist/ (index.html + app.js); Tauri embeds dist/ into the exe.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
await build({ entryPoints: [join(root, "src", "main.js")], bundle: true, format: "iife", minify: true, target: "chrome120", outfile: join(dist, "app.js"), legalComments: "none" });
copyFileSync(join(root, "src", "index.html"), join(dist, "index.html"));
console.log("dist/ built");
