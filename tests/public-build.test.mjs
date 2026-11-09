import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('public build removes stale private subfolders and rejects missing app modules', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'brixton-public-build-'));
  const script = path.join(temp, 'onedrive-worker', 'build-assets.mjs');
  try {
    await fs.mkdir(path.dirname(script));
    await fs.copyFile(path.join(root, 'onedrive-worker', 'build-assets.mjs'), script);
    // Names only: no private sensor bytes enter the temporary fixture.
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isFile()) await fs.writeFile(path.join(temp, entry.name), 'fixture');
    }
    await fs.writeFile(path.join(temp, 'victoria-training-private.json'), 'private');
    await fs.writeFile(path.join(temp, '.dev.vars'), 'secret');
    const output = path.join(temp, '.onedrive-public');
    await fs.mkdir(path.join(output, 'stale-private'), { recursive: true });
    await fs.writeFile(path.join(output, 'stale-private', 'recording.json'), 'private');
    const success = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    const names = await fs.readdir(output);
    assert.ok(names.includes('fork-engine.js'));
    assert.equal(names.some(name => name.startsWith('victoria-training-')), false);
    assert.equal(names.includes('.dev.vars'), false);
    assert.equal(names.includes('stale-private'), false);

    await fs.unlink(path.join(temp, 'fork-engine.js'));
    const incomplete = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /ENOENT/);
  } finally {
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
