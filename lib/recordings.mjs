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
    for (const example of data.examples || []) {
      if (!['left', 'right'].includes(example.label) || !Array.isArray(example.rawMotionData) || example.rawMotionData.length < 600) continue;
      if (/^\s*(fake|synthetic)\b/i.test(example.notes || '')) continue;
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
