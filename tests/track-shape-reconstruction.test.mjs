import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function syntheticTrip(extraStopSeconds = 0) {
  const schedule = [
    [0, 10 + extraStopSeconds, 0, 0],
    [10 + extraStopSeconds, 20 + extraStopSeconds, 0.5, null],
    [20 + extraStopSeconds, 40 + extraStopSeconds, 0, null],
    [40 + extraStopSeconds, 50 + extraStopSeconds, -0.5, null],
    [50 + extraStopSeconds, 65 + 2 * extraStopSeconds, 0, 0],
    [65 + 2 * extraStopSeconds, 75 + 2 * extraStopSeconds, 0.5, null],
    [75 + 2 * extraStopSeconds, 95 + 2 * extraStopSeconds, 0, null],
    [95 + 2 * extraStopSeconds, 105 + 2 * extraStopSeconds, -0.5, null],
    [105 + 2 * extraStopSeconds, 120 + 2 * extraStopSeconds, 0, 0],
  ];
  const end = schedule.at(-1)[1], samples = [];
  let speed = 0, distance = 0, heading = 0;
  for (let i = 0; i <= end * 60; i++) {
    const sec = i / 60;
    const segment = schedule.find(([a, b]) => sec >= a && sec < b) || schedule.at(-1);
    const [a, , accel, forcedSpeed] = segment;
    const dt = i === 0 ? 0 : 1 / 60;
    if (forcedSpeed !== null) speed = forcedSpeed;
    else speed = Math.max(0, speed + accel * dt);
    const lateralAccel = 0.002 * speed * speed;
    const yawRate = 0.002 * speed;
    const linearAccel = accel === 0 && speed === 0 ? 0 : accel;
    // Add train vibration that cancels over time but keeps a moving coast
    // distinguishable from a genuinely stationary wait.
    const vibration = speed > 0 ? 0.6 * Math.sin(2 * Math.PI * 8 * sec) : 0;
    heading += yawRate * dt;
    distance += speed * dt;
    samples.push({
      time: i * 1000 / 60,
      ax: linearAccel, ay: lateralAccel, az: vibration,
      rotationAlpha: yawRate * 180 / Math.PI, rotationBeta: 0, rotationGamma: 0,
      gx: 0, gy: 0, gz: -9.81,
    });
  }
  return { samples, expectedDistance: distance, expectedHeading: heading };
}

function runReconstruction({ dropSensorWindow = false, missingGravityWindow = false, stationaryTimestampGap = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brixton-track-shape-'));
  const output = path.join(directory, 'out');
  const short = syntheticTrip(0), long = syntheticTrip(30);
  if (dropSensorWindow) short.samples.splice(1800, 60);
  if (missingGravityWindow) for (let i = 1800; i < 1860; i++) short.samples[i].gx = null;
  if (stationaryTimestampGap) for (const sample of short.samples) if (sample.time >= 5000) sample.time += 30000;
  for (const [name, label, trip] of [['short', 'left', short], ['long', 'right', long]]) {
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({ examples: [{ label, timestamp: 0, rawMotionData: trip.samples }] }));
  }
  const script = path.resolve('tools/reconstruct-track-shape.mjs');
  const result = spawnSync(process.execPath, [script, path.join(directory, 'short.json'), path.join(directory, 'long.json'), `--out-dir=${output}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const data = JSON.parse(fs.readFileSync(path.join(output, 'track-reconstruction.json'), 'utf8'));
  fs.rmSync(directory, { recursive: true, force: true });
  return { data, short, long };
}

test('stop-aware reconstruction keeps normalized endpoints ordered and finite', () => {
  const { data } = runReconstruction();
  assert.equal(data.trips.length, 2);
  for (const trip of data.trips) {
    assert.equal(trip.points.length, 61);
    assert.deepEqual(trip.points[0], [0, 0]);
    assert.equal(trip.points.at(-1)[0], 1);
    assert.ok(trip.points.every(point => point.every(Number.isFinite)));
  }
});

test('adding a stationary wait does not create estimated track progress', () => {
  const { data } = runReconstruction();
  const [short, long] = data.trips;
  assert.ok(Math.abs(short.stats.lengthM - 300) < 5,
    `known synthetic route length was reconstructed as ${short.stats.lengthM.toFixed(2)} m`);
  const distanceDelta = Math.abs(short.stats.lengthM - long.stats.lengthM);
  assert.ok(distanceDelta < 3, `30-second added dwell changed estimated path length by ${distanceDelta.toFixed(2)} m`);
  assert.ok(short.stats.internalStops >= 1);
  assert.ok(long.stats.internalStops >= 1);
});

test('a missing sensor interval is skipped without inventing a path jump', () => {
  const { data } = runReconstruction({ dropSensorWindow: true });
  const trip = data.trips[0];
  assert.ok(trip.stats.skippedGapCount > 0);
  assert.ok(trip.points.every(point => point.every(Number.isFinite)));
  assert.equal(trip.points.at(-1)[0], 1);
});

test('partially missing gravity is excluded rather than treated as a measured zero', () => {
  const { data } = runReconstruction({ missingGravityWindow: true });
  const trip = data.trips[0];
  assert.ok(trip.stats.validSampleFraction < 0.999);
  assert.ok(trip.points.every(point => point.every(Number.isFinite)));
});

test('a sensor gap while stationary does not move later stop anchors onto moving track', () => {
  const { data } = runReconstruction({ stationaryTimestampGap: true });
  const [gap, addedDwell] = data.trips;
  assert.ok(gap.stats.skippedGapCount > 0);
  assert.ok(Math.abs(gap.stats.lengthM - 300) < 5,
    `a stationary sensor gap changed the known 300 m path to ${gap.stats.lengthM.toFixed(2)} m`);
  assert.ok(Math.abs(gap.stats.lengthM - addedDwell.stats.lengthM) < 3);
  assert.ok(gap.points.every(point => point.every(Number.isFinite)));
});

test('shape research rejects conflicting labels for the same raw journey', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brixton-track-conflict-'));
  try {
    const rawMotionData = syntheticTrip().samples;
    const file = path.join(directory, 'conflict.json');
    fs.writeFileSync(file, JSON.stringify({ examples: ['left', 'right'].map(label => ({ label, timestamp: 0, rawMotionData })) }));
    const result = spawnSync(process.execPath, [path.resolve('tools/reconstruct-track-shape.mjs'), file,
      `--out-dir=${path.join(directory, 'out')}`], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Conflicting labels/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
