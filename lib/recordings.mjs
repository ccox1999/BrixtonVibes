/** Private recording input. Never emits raw samples into public build files. */
import fs from 'node:fs';
import crypto from 'node:crypto';

export function recordingFingerprint(example) {
  return crypto.createHash('sha256').update(JSON.stringify(example.rawMotionData)).digest('hex');
}

export function loadRecordings(paths) {
  const byRaw = new Map();
  let duplicates = 0;
  for (const path of paths) {
    const data = JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.examples)) {
      throw new Error(`Invalid recording export ${path}: examples must be an array.`);
    }
    for (let index = 0; index < data.examples.length; index++) {
      const example = data.examples[index], location = `export ${path}, example ${index + 1}`;
      if (!example || typeof example !== 'object' || Array.isArray(example)) {
        throw new Error(`Invalid recording ${location}: expected an object.`);
      }
      const raw = example.rawMotionData;
      if (raw != null && !Array.isArray(raw)) {
        throw new Error(`Invalid recording ${location}: rawMotionData must be an array when present.`);
      }
      // Missing axes remain valid input: the engine must see unavailable
      // sensors and withdraw its answer. Invalid rows/times cannot be replayed
      // safely, so reject them before hashing or any downstream analysis.
      for (let i = 0; i < (raw?.length || 0); i++) {
        const sample = raw[i];
        if (!sample || typeof sample !== 'object' || Array.isArray(sample) || !Number.isFinite(sample.time)) {
          throw new Error(`Invalid recording ${location}, sample ${i + 1}: expected an object with finite numeric time.`);
        }
      }
      if (!['left', 'right'].includes(example.label) || !raw || raw.length < 600) continue;
      if (/^\s*(fake|synthetic)\b/i.test(example.notes || '')) continue;
      if (!Number.isFinite(example.timestamp) || !Number.isFinite(new Date(example.timestamp).getTime())) {
        throw new Error(`Invalid recording ${location}: timestamp must be a finite date in milliseconds.`);
      }
      const key = recordingFingerprint(example);
      const existing = byRaw.get(key);
      if (existing) {
        if (existing.label !== example.label) throw new Error(`Conflicting labels for duplicate recording ${example.id}`);
        duplicates++;
      } else byRaw.set(key, { ...example, fingerprint: key });
    }
  }
  const examples = [...byRaw.values()].sort((a, b) => a.timestamp - b.timestamp);
  return { examples, duplicates };
}

export function inventory(examples) {
  return examples.map(e => {
    const raw = e.rawMotionData;
    let nonIncreasingTime = 0, maxGapMs = 0;
    for (let i = 1; i < raw.length; i++) {
      const dt = raw[i].time - raw[i - 1].time;
      if (dt <= 0) nonIncreasingTime++;
      maxGapMs = Math.max(maxGapMs, dt);
    }
    const compass = raw.filter(s => Number.isFinite(s.heading));
    const accuracy = compass.map(s => s.headingAccuracy).filter(Number.isFinite).sort((a,b) => a-b);
    return { id: e.id, label: e.label, date: new Date(e.timestamp).toISOString().slice(0,10), samples: raw.length,
      durationSec: (raw.at(-1).time - raw[0].time) / 1000, compassSamples: compass.length,
      compassMedianAccuracyDeg: accuracy.length ? accuracy[Math.floor(accuracy.length / 2)] : null,
      maxGapMs, nonIncreasingTime };
  });
}
