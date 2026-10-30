import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildTrackReference, motionFrames, TrackPosition } from '../track-position.js';

const files = process.argv.slice(2).filter(x => !x.startsWith('--'));
if (!files.length) throw new Error('Pass one or more private victoria-training exports. Optional --build writes aggregate reference.');
const seen = new Set(), examples = [], snapshots = [];
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  let added = 0;
  for (const e of data.examples || []) {
    if (!['left', 'right'].includes(e.label) || !e.rawMotionData?.length || /fake/i.test(e.notes || '')) continue;
    const hash = crypto.createHash('sha256').update(JSON.stringify(e.rawMotionData)).digest('hex');
    if (!seen.has(hash)) { seen.add(hash); examples.push(e); added++; }
  }
  snapshots.push({ file: file.split(/[\\/]/).at(-1), count: data.examples.length, uniqueAdded: added });
}
for (const e of examples) e.frames = motionFrames(e.rawMotionData);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const methods = ['moving-clock', 'unconstrained-nearest', 'filter-0', 'filter-0.06', 'filter-0.15'];
const records = Object.fromEntries(methods.map(m => [m, []]));
const durations = [], gapCounts = [], deadReckoning = [];
let pauseMaxDrift = 0, pauseMovingClockDrift = 0;
let maximumForwardCorrection = 0, maximumBackwardCorrection = 0;
let rawPauseMaxDrift = 0, rawPauseWarmupAdvance = 0, rawPauseEndDifference = 0;
for (let index = 0; index < examples.length; index++) {
  const test = examples[index], train = examples.filter((_, i) => i !== index), reference = buildTrackReference(train);
  const movingTotal = test.frames.filter(f => f.moving).length;
  const rawTracker = new TrackPosition(reference), rawBaseline = new TrackPosition(reference);
  const insertAt = Math.floor(test.rawMotionData.length / 2), stopSample = test.rawMotionData[insertAt];
  let startStop = null, settledStop = null;
  for (let i = 0; i < test.rawMotionData.length; i++) {
    const s = test.rawMotionData[i];
    rawBaseline.update(s);
    if (i === insertAt) {
      startStop = rawTracker.value.progress;
      for (let ms = 0; ms < 30000; ms += 1000 / 60) {
        rawTracker.update({ ...s, time: stopSample.time + ms, ax: 0, ay: 0, az: 0, rotationAlpha: 0, rotationBeta: 0, rotationGamma: 0 });
        if (ms >= 2000 && settledStop === null) settledStop = rawTracker.value.progress;
      }
      rawPauseMaxDrift = Math.max(rawPauseMaxDrift, Math.abs(rawTracker.value.progress - settledStop));
      rawPauseWarmupAdvance = Math.max(rawPauseWarmupAdvance, Math.abs(settledStop - startStop));
    }
    rawTracker.update(i >= insertAt ? { ...s, time: s.time + 30000 } : s);
  }
  rawPauseEndDifference = Math.max(rawPauseEndDifference, Math.abs(rawTracker.value.progress - rawBaseline.value.progress));
  const matchers = Object.fromEntries([0, 0.06, 0.15].map(w => [w, new TrackPosition(reference, { observationWeight: w })]));
  const values = Object.fromEntries(methods.map(m => [m, []]));
  let moving = 0;
  let previousProgress = null;
  for (const frame of test.frames) {
    if (frame.moving) moving++;
    const truthProxy = moving / movingTotal;
    if (frame.moving && moving >= 8) {
      values['moving-clock'].push({ error: Math.abs(Math.min(.98, moving / reference.durations[2]) - truthProxy) });
      // A plausible competing approach: best matching isolated signature with
      // no ordering constraints. Repeated curves can alias to distant places.
      let best = Infinity, at = 0;
      for (let j = 0; j < reference.bins; j++) {
        let error = 0;
        for (let c = 0; c < 3; c++) if (frame.features[c] !== null) error += Math.min(9, ((frame.features[c] - reference.common[j][c].mean) / reference.common[j][c].scale) ** 2);
        if (error < best) { best = error; at = j; }
      }
      values['unconstrained-nearest'].push({ error: Math.abs(at / (reference.bins - 1) - truthProxy) });
    }
    for (const weight of [0, .06, .15]) {
      const value = matchers[weight].updateFrame(frame);
      if (weight === .06 && value.progress !== null) {
        if (previousProgress !== null) {
          maximumForwardCorrection = Math.max(maximumForwardCorrection, value.progress - previousProgress);
          maximumBackwardCorrection = Math.max(maximumBackwardCorrection, previousProgress - value.progress);
        }
        previousProgress = value.progress;
      }
      if (frame.moving && moving >= 8) values[`filter-${weight}`].push({ error: Math.abs(value.progress - truthProxy), covered: value.lower <= truthProxy && value.upper >= truthProxy, width: value.upper - value.lower });
    }
    // Insert 30 seconds of truly still data at each real moving observation;
    // test it on a clone-free independent matcher at the midpoint below.
    if (moving === Math.floor(movingTotal / 2) && frame.moving) {
      const matcher = matchers[.06], before = matcher.value.progress;
      for (let s = 0; s < 30; s++) matcher.updateFrame({ ...frame, moving: false, rms: 0, yaw: 0, features: [0, -4, 0] });
      pauseMaxDrift = Math.max(pauseMaxDrift, Math.abs(matcher.value.progress - before));
      pauseMovingClockDrift = Math.max(pauseMovingClockDrift, 30 / reference.durations[2]);
    }
  }
  for (const method of methods) {
    const v = values[method];
    records[method].push({ error: mean(v.map(x => x.error)), coverage: v[0]?.covered === undefined ? null : mean(v.map(x => +x.covered)), width: v[0]?.width === undefined ? null : mean(v.map(x => x.width)) });
  }
  durations.push({ elapsed: (test.rawMotionData.at(-1).time - test.rawMotionData[0].time) / 1000, moving: movingTotal });
  gapCounts.push(test.frames.filter(f => !f.quality).length);
  // Deliberately basic integration diagnostic: best fixed horizontal phone
  // direction (PCA), no known initial speed or velocity observations. It tests
  // identifiability, not an endorsed position algorithm.
  let xx = 0, xy = 0, yy = 0, prior = null, velocity = 0, distance = 0;
  const raw = test.rawMotionData;
  for (const s of raw) { xx += s.ax * s.ax; xy += s.ax * s.ay; yy += s.ay * s.ay; }
  const angle = .5 * Math.atan2(2 * xy, xx - yy), ux = Math.cos(angle), uy = Math.sin(angle);
  for (const s of raw) {
    const dt = prior === null ? 0 : Math.min(.1, Math.max(0, (s.time - prior) / 1000)); prior = s.time;
    velocity += (s.ax * ux + s.ay * uy) * dt; distance += velocity * dt;
  }
  deadReckoning.push({ distance, finalVelocity: velocity });
}
const chronologicalTrain = examples.filter(e => e.timestamp < Date.parse('2026-09-28'));
const chronologicalTest = examples.filter(e => e.timestamp >= Date.parse('2026-09-28'));
const chronologicalReference = buildTrackReference(chronologicalTrain);
const chronologicalRows = chronologicalTest.map(e => {
  const movingTotal = e.frames.filter(f => f.moving).length, tracker = new TrackPosition(chronologicalReference);
  const errors = [], clockErrors = [];
  let moving = 0;
  for (const f of e.frames) {
    const v = tracker.updateFrame(f);
    if (f.moving) moving++;
    if (f.moving && moving >= 8) {
      errors.push(Math.abs(v.progress - moving / movingTotal));
      clockErrors.push(Math.abs(Math.min(.98, moving / chronologicalReference.durations[2]) - moving / movingTotal));
    }
  }
  return { match: mean(errors), clock: mean(clockErrors) };
});
const result = { generatedBy: 'node tools/analyze-track.mjs <snapshots> --build', trips: examples.length,
  validation: 'Leave-one-journey-out; proxy target is completed-journey moving-time fraction, NOT independently measured physical position.',
  snapshots,
  methods: Object.fromEntries(methods.map(m => [m, {
    meanAbsoluteProxyError: mean(records[m].map(x => x.error)),
    meanIntervalCoverageOfProxy: records[m][0].coverage === null ? null : mean(records[m].map(x => x.coverage)),
    meanIntervalWidth: records[m][0].width === null ? null : mean(records[m].map(x => x.width))
  }])),
  durations: { elapsedMin: Math.min(...durations.map(x => x.elapsed)), elapsedMax: Math.max(...durations.map(x => x.elapsed)), movingMin: Math.min(...durations.map(x => x.moving)), movingMax: Math.max(...durations.map(x => x.moving)) },
  inserted30sStops: { trips: examples.length, maximumProgressDrift: pauseMaxDrift, elapsedClockMaximumDrift: pauseMovingClockDrift },
  sampleLevelInserted30sStops: { trips: examples.length, maximumProgressDriftAfter2sSettling: rawPauseMaxDrift,
    maximumAdvanceDuringFirst2s: rawPauseWarmupAdvance, maximumEndProgressDifference: rawPauseEndDifference,
    caveat: 'First partial one-second observation can still include preceding movement. Boundary mixtures can slightly change movement classification after restarting; quiet dwell itself is excluded from cruise estimation.' },
  chronological: { train: chronologicalTrain.length, test: chronologicalTest.length, cutoff: '2026-09-28',
    meanAbsoluteProxyError: mean(chronologicalRows.map(x => x.match)), movingClockMeanAbsoluteProxyError: mean(chronologicalRows.map(x => x.clock)),
    caveat: 'Filter was developed after seeing these recordings; this split excludes test journeys from its reference, not from engineering decisions.' },
  largestOneSecondCorrection: { forward: maximumForwardCorrection, backward: maximumBackwardCorrection },
  invalidFrameCount: gapCounts.reduce((a, b) => a + b, 0),
  naivePhonePlaneIntegration: { caveat: 'Uncorrected phone x/y PCA, arbitrary sign, assumes zero initial speed. A failure demonstration, not a track reconstruction.', distanceMin: Math.min(...deadReckoning.map(x => x.distance)), distanceMax: Math.max(...deadReckoning.map(x => x.distance)), finalVelocityMin: Math.min(...deadReckoning.map(x => x.finalVelocity)), finalVelocityMax: Math.max(...deadReckoning.map(x => x.finalVelocity)) }
};
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes('--build')) {
  const reference = buildTrackReference(examples);
  fs.writeFileSync('track-reference.js', `// Generated aggregate; contains no raw trip samples or timestamps.\nexport const TRACK_REFERENCE = ${JSON.stringify(reference)};\n`);
  fs.writeFileSync('docs/track-validation.json', JSON.stringify(result, null, 2) + '\n');
}
