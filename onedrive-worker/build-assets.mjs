// Allowlist copying avoids publishing private exports, local sessions or secrets.
import { mkdir, copyFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".onedrive-public");
const names = ["index.html", "style.css", "app.js", "app-bootstrap.js", "update.html", "update.js", "features.js", "classifier.js", "training-set.js", "raw-store.js", "fork-engine.js", "onedrive-sync.js", "native-save.js", "track-position.js", "track-reference.js", "track-view.js", "manifest.json", "sw.js", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
await mkdir(target, { recursive: true });
// Remove only immediate generated files in this fixed build folder; do not follow links.
for (const entry of await readdir(target, { withFileTypes: true })) if (entry.isFile()) await rm(path.join(target, entry.name));
for (const name of names) {
  try { await copyFile(path.join(root, name), path.join(target, name)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
console.log(`Prepared public app assets in ${target}; no raw exports or server configuration copied.`);
