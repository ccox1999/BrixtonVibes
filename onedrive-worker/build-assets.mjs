// Allowlist copying avoids publishing private exports, local sessions or secrets.
import { mkdir, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".onedrive-public");
const names = ["index.html", "style.css", "app.js", "app-bootstrap.js", "update.html", "update.js", "features.js", "classifier.js", "training-set.js", "raw-store.js", "fork-engine.js", "onedrive-sync.js", "native-save.js", "track-position.js", "track-reference.js", "track-view.js", "manifest.json", "sw.js", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
// Verify the absolute deletion target before removing this generated folder.
// A clean rebuild also removes stale nested files and links that an allowlist
// copy alone would leave available to the static hosting service.
if (!path.isAbsolute(target) || path.relative(root, target) !== ".onedrive-public") throw new Error("Unsafe public build target");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of names) {
  // A missing required module must fail the build, not publish a broken app.
  await copyFile(path.join(root, name), path.join(target, name));
}
console.log(`Prepared public app assets in ${target}; no raw exports or server configuration copied.`);
