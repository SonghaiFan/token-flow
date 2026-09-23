import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const uiDirectory = resolve(scriptDirectory, "..");
const source = resolve(uiDirectory, "dist");
const destination = resolve(uiDirectory, "..", "claude_tap", "static_ui");

if (!existsSync(resolve(source, "index.html"))) {
  throw new Error("Run `npm run build:vite` before syncing the Vite UI.");
}

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
console.log(`Synced Vite UI to ${destination}`);
