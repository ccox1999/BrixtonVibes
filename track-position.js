/* Relative inertial route matching. There is no geographic position or distance
 * measurement in these recordings. Progress means historical moving-profile
 * fraction; intervals express model spread, not surveyed position accuracy. */
export const TRACK_REFERENCE_VERSION = 1;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const quantile = (xs, p) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y), at = (a.length - 1) * p;
  return a[Math.floor(at)] * (1 - at % 1) + a[Math.ceil(at)] * (at % 1);
};

/** The same causal, one-second observations are used in training and live use.
 * Motion and yaw are orientation invariant for a still phone. Phone movement
 * cannot be separated perfectly from train movement and is rejected coarsely. */
export class MotionFrames {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.start = null; this.previous = null; this.bucket = -1;
    this.count = 0; this.square = 0; this.yaws = []; this.vertical = 0;
    this.valid = 0; this.rejected = 0; this.rmsHistory = []; this.elapsed = 0;
  }
  update(s) {
    if (!s || !finite(s.time)) return;
    if (this.previous !== null && s.time <= this.previous) return;
    if (this.start === null) this.start = s.time;
    const bucket = Math.floor((s.time - this.start) / 1000);
    if (this.bucket !== -1 && bucket !== this.bucket) {
      this.flush(s.time, bucket - this.bucket > 1);
    }
    this.bucket = bucket; this.previous = s.time;
    if (![s.ax, s.ay, s.az].every(finite)) { this.rejected++; return; }
    const mag = Math.hypot(s.ax, s.ay, s.az);
    const g = Math.hypot(s.gx, s.gy, s.gz);
    const rotation = Math.hypot(s.rotationAlpha || 0, s.rotationBeta || 0, s.rotationGamma || 0);
    this.count++;
    if (mag > 6 || rotation > 25) { this.rejected++; return; }
    this.valid++; this.square += mag * mag;
    if (finite(g) && g > 5 && g < 15 &&
        [s.rotationAlpha, s.rotationBeta, s.rotationGamma].every(finite)) {
      this.yaws.push(clamp(-(s.rotationBeta * s.gx + s.rotationGamma * s.gy + s.rotationAlpha * s.gz) / g, -12, 12));
      this.vertical += Math.abs((s.ax * s.gx + s.ay * s.gy + s.az * s.gz) / g);
    }
  }
  flush(t, gap = false) {
    const rms = Math.sqrt(this.square / Math.max(1, this.valid));
    const quality = this.valid >= 10 && this.valid / Math.max(1, this.count + this.rejected) > 0.75 && !gap;
    // Dwell samples must not drag the cruise reference down: otherwise a
    // 30-second wait changes which future samples count as movement. Keep a
    // reservoir of plausible movement, rather than elapsed recording seconds.
    const previousCruise = Math.max(0.5, quantile(this.rmsHistory, 0.75));
    if (quality && rms >= Math.max(0.18, previousCruise * 0.35)) this.rmsHistory.push(rms);
    const cruise = Math.max(0.5, quantile(this.rmsHistory, 0.75));
    // An absolute floor prevents a completely still recording becoming its own
    // 'cruise'. The relative threshold follows the established engine's clock.
    const moving = quality && rms >= Math.max(0.18, cruise * 0.6);
    const yawValid = this.yaws.length >= Math.max(8, this.valid * 0.7);
    const frame = { t, seconds: 1, moving, quality, gap, rms,
      yaw: yawValid ? quantile(this.yaws, 0.5) : null,
      features: [yawValid ? quantile(this.yaws, 0.5) : null,
        Math.log(Math.max(0.02, rms) / cruise),
        yawValid ? this.vertical / this.yaws.length / Math.max(rms, 0.05) : null] };
    this.onFrame(frame);
    this.count = 0; this.valid = 0; this.square = 0; this.yaws = []; this.vertical = 0; this.rejected = 0;
  }
}

export function motionFrames(raw) {
  const out = [], reader = new MotionFrames(f => out.push(f));
  for (const s of raw || []) reader.update(s);
  // A partial final second is deliberately excluded, including during training.
  return out;
}

/** Aggregate only: no timestamps, trip IDs, raw samples, or geographic claims. */
export function buildTrackReference(examples, { bins = 61 } = {}) {
  const trips = [];
  for (const e of examples || []) {
    if (!["left", "right"].includes(e.label)) continue;
    const frames = e.frames || motionFrames(e.rawMotionData || e.raw);
    const moving = frames.filter(f => f.moving);
    if (moving.length >= 30) trips.push({ label: e.label, moving });
  }
  if (trips.length < 6) return null;
  const make = (group) => Array.from({ length: bins }, (_, i) => {
    const points = group.map(t => t.moving[Math.round(i / (bins - 1) * (t.moving.length - 1))].features);
    return [0, 1, 2].map(c => {
      const values = points.map(p => p[c]).filter(finite), median = quantile(values, 0.5);
      const mad = quantile(values.map(v => Math.abs(v - median)), 0.5) * 1.4826;
      return { mean: +median.toFixed(4), scale: +Math.max([0.55, 0.25, 0.15][c], mad).toFixed(4), n: values.length };
    });
  });
  const durations = trips.map(t => t.moving.length);
  return { version: TRACK_REFERENCE_VERSION, coordinate: "historical-moving-profile-fraction",
    geometry: "unavailable", junction: { verified: false, progress: null },
    description: "Relative sensor profile, not distance. Any drawn rail geometry is illustrative.",
    tripCount: trips.length, bins, durations: [0.05, 0.25, 0.5, 0.75, 0.95].map(p => quantile(durations, p)),
    common: make(trips), branches: Object.fromEntries(["left", "right"].map(label => {
      const group = trips.filter(t => t.label === label);
      return [label, { tripCount: group.length, profile: group.length >= 3 ? make(group) : make(trips) }];
    })) };
}

function distributionSummary(weights) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0, lower = 0, upper = 1, mean = 0, foundLow = false;
  for (let j = 0; j < weights.length; j++) {
    acc += weights[j] / total; mean += j / (weights.length - 1) * weights[j] / total;
    if (!foundLow && acc >= 0.05) { lower = j / (weights.length - 1); foundLow = true; }
    if (acc >= 0.95) { upper = j / (weights.length - 1); break; }
  }
  // Mean needs the complete distribution, including the upper tail.
  mean = weights.reduce((a, w, j) => a + j / (weights.length - 1) * w / total, 0);
  return { progress: mean, lower, upper };
}

/** Small constrained forward filter (61 states x 2 routes, one update/second).
 * A pause applies neither a transition nor an observation: no elapsed-time
 * route advance. Both branch hypotheses always remain alive. The branch
 * predictor is deliberately not fed back into these sensor likelihoods. */
export class TrackPosition {
  constructor(reference, { observationWeight = 0.06 } = {}) {
    this.reference = reference?.version === TRACK_REFERENCE_VERSION ? reference : null;
    this.observationWeight = observationWeight;
    this.movingSeconds = 0; this.framesSeen = 0; this.gaps = 0; this.orientationLimited = true;
    this.weights = {}; this.last = null; this.started = false;
    const n = this.reference?.bins || 61;
    for (const route of ["left", "right"]) {
      this.weights[route] = Array.from({ length: n }, (_, i) => Math.exp(-i * i / 8));
    }
    this.reader = new MotionFrames(f => this.updateFrame(f));
    this.value = this.snapshot(false, false);
  }
  update(sample) { this.reader.update(sample); return this.value; }
  updateFrame(frame) {
    this.framesSeen++;
    this.orientationLimited = !finite(frame.features?.[0]);
    if (frame.gap || !frame.quality) this.gaps++;
    if (!this.reference || !frame.moving) {
      this.value = this.snapshot(false, frame.quality);
      return this.value;
    }
    this.started = true; this.movingSeconds++;
    const ref = this.reference, n = ref.bins;
    const nominal = clamp((n - 1) / ref.durations[2], 0.3, 1.5);
    const step2 = Math.max(0.05, nominal - 0.85), step1 = nominal - 2 * step2;
    const transition = [1 - step1 - step2, step1, step2];
    const speedSpread = Math.max(0.10, (ref.durations[4] - ref.durations[0]) / ref.durations[2]);
    for (const route of ["left", "right"]) {
      const before = this.weights[route], after = new Array(n).fill(0);
      for (let j = 0; j < n; j++) for (let d = 0; d <= 2; d++) after[Math.min(n - 1, j + d)] += before[j] * transition[d];
      const profile = ref.branches[route].profile;
      for (let j = 0; j < n; j++) {
        let mismatch = 0;
        for (let c = 0; c < 3; c++) {
          if (!finite(frame.features[c]) || !profile[j][c].n) continue;
          const r = (frame.features[c] - profile[j][c].mean) / profile[j][c].scale;
          mismatch += Math.min(9, r * r) * [1, 0.5, 0.25][c];
        }
        // Weak broad movement-clock prior prevents repeated/similar curves
        // jumping to a distant route segment. It is empirical, not a speed bound.
        const expected = this.movingSeconds / ref.durations[2];
        const width = 0.15 + expected * speedSpread;
        const prior = Math.exp(-0.05 * ((j / (n - 1) - expected) / width) ** 2);
        after[j] *= Math.exp(-this.observationWeight * mismatch) * prior;
      }
      const total = after.reduce((a, b) => a + b, 0) || 1;
      this.weights[route] = after.map(w => w / total);
    }
    this.value = this.snapshot(true, frame.quality);
    return this.value;
  }
  snapshot(moving, quality) {
    if (!this.reference) return { progress: null, lower: 0, upper: 1, moving,
      state: "unavailable", quality: "no-reference", hypotheses: {},
      junction: { verified: false, progress: null }, model: "relative-motion-profile" };
    const hypotheses = {};
    for (const route of ["left", "right"]) {
      const s = distributionSummary(this.weights[route]);
      // Empirical duration spread and a 15-point uncertainty floor deliberately
      // override a sharply peaked fit: no independent position labels exist.
      const lowerClock = this.movingSeconds / this.reference.durations[4];
      const upperClock = this.movingSeconds / this.reference.durations[0];
      const extra = Math.min(0.2, this.gaps * 0.01 + (this.orientationLimited ? 0.05 : 0));
      hypotheses[route] = { progress: Math.min(0.98, s.progress),
        lower: clamp(Math.min(s.lower, s.progress - 0.15, lowerClock - 0.05) - extra, 0, 1),
        upper: clamp(Math.max(s.upper, s.progress + 0.15, upperClock + 0.05) + extra, 0, 1) };
    }
    const progress = (hypotheses.left.progress + hypotheses.right.progress) / 2;
    return { progress: this.framesSeen >= 8 && this.movingSeconds >= 3 ? progress : null,
      lower: Math.min(hypotheses.left.lower, hypotheses.right.lower),
      upper: Math.max(hypotheses.left.upper, hypotheses.right.upper),
      moving, movingSeconds: this.movingSeconds,
      state: this.framesSeen < 8 ? "learning-motion" : moving ? "matching" : this.started ? "paused-or-slow" : "waiting-for-motion",
      quality: quality && !this.orientationLimited ? "relative-estimate" : "limited-sensors", hypotheses,
      junction: { verified: false, progress: null }, model: "relative-motion-profile" };
  }
}
