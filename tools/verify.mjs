// One reproducible local check of prediction, storage, mobile UI and updates.
// Private recordings are used by browser replay only; nothing is uploaded.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs'))
  .sort().map(name => `tests/${name}`);
const checks = [
  ['Unit and backend checks', ['--test', ...tests, 'onedrive-sync.test.mjs']],
  ['Mobile app, replay, recovery and offline checks', ['tools/test-browser.mjs']],
  ['Real IndexedDB migration and atomic writes', ['tools/test-journal.mjs']],
  ['Existing-installation update checks', ['tools/test-update.mjs']],
  ['Public asset build', ['onedrive-worker/build-assets.mjs']],
];
for (const [name, args] of checks) {
  console.log(`\n${name}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`${name} failed; remaining checks were not run.`);
    process.exit(result.status || 1);
  }
}
console.log('\nAll local verification checks passed. Physical iPhone sensors and OneDrive delivery still require a phone.');
