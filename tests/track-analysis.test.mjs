import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('track validation explains unusable stationary journeys before building empty references', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brixton-track-analysis-'));
  try {
    const file = path.join(directory, 'stationary.json');
    const examples = Array.from({ length: 7 }, (_, trip) => ({
      id: `trip-${trip}`, label: trip % 2 ? 'left' : 'right', timestamp: trip,
      rawMotionData: Array.from({ length: 1801 }, (_, i) => ({
        time: trip * 100000 + i * 20, ax: 0, ay: 0, az: 0,
        gx: 0, gy: 0, gz: 9.81, rotationAlpha: 0, rotationBeta: 0, rotationGamma: 0,
      })),
    }));
    fs.writeFileSync(file, JSON.stringify({ examples }));
    const result = spawnSync(process.execPath, ['tools/analyze-track.mjs', file], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fewer than 30 usable moving seconds/);
    assert.doesNotMatch(result.stderr, /TypeError/);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
