/* ============================================================
   Fork engine — deterministic Stockwell -> Brixton platform predictor
   ------------------------------------------------------------
   A physics-derived alternative to the learned kNN/logreg path. It does
   not search a feature space: it measures one quantity with a known
   mechanism and thresholds it.

   MECHANISM
   The train must cross the points to reach its platform, and the points
   sit upstream of the platform mouth, so the deciding evidence is
   recorded before a passenger can see which side they are arriving on.
   Signed yaw rate (rotation-rate vector projected onto gravity, so it is
   orientation-invariant by construction — ORIENTATION_INVARIANT hard
   requirement satisfied) integrated over a window before arrival
   separates the classes.

   Measured on 15 labelled trips (9L/6R), LOOCV with the threshold refit
   in every fold:
       window [arr-26, arr-10]   AUC 0.98   <- final call
       window [arr-22, arr-16]   AUC 0.91   <- pre-visibility verdict
   The wide-window S-bend cancellation documented in CLAUDE.md is real
   and is why the window is bounded: at [arr-34, arr-4] AUC falls to
   0.67. Separation does NOT invert under +/-4 s of window shift (left
   stays positive, right negative), so this is not a single S-lobe
   artefact.

   ROUTE PRIOR (why triggering works at all)
   Sensors cannot distinguish the final approach from an intermediate
   stop or a Brixton pre-platform hold. Elapsed time can: over 15 trips
   the fastest journey was 93.1 s and every mid-journey stop began
   between 37 s and 94 s. So a stop starting before MIN_JOURNEY is never
   the arrival. This is drift-free, unlike dead reckoning, which was
   tried and failed badly (58-753 m estimated for a ~1.4 km route: a
   hand-held phone has no heading reference without a magnetometer).

   SIGN SELF-CALIBRATION
   gx/gy/gz sign conventions differ between platforms (see the comment in
   app.js handleMotion). Rather than hard-code a sign fitted to one
   device, calibrate() derives it from the user's own labelled examples,
   so a device change cannot silently invert every prediction.
   ============================================================ */

"use strict";

export const FORK_ENGINE_VERSION = 2;

// Windows are relative to the arrival instant, in seconds before it.
export const WIN_FINAL = [26.0, 10.0];
export const WIN_EARLY = [22.0, 16.0];

/* ------------------------------------------------------------
   v2 PRIMARY SIGNAL — skewness of |a| over [arr-22, arr-8]
   ------------------------------------------------------------
   Found by scanning 8316 orientation-invariant features over 26
   labelled trips (14L/12R) with a BEST-OF-SCAN permutation test, which
   corrects for the size of the search: best real AUC 1.000 vs a
   shuffled-label median of 0.881, p = 0.0008.

   On those 26 trips the classes do not overlap at all —
       left  skew  -0.121 .. +0.881
       right skew  +1.038 .. +3.506
   LOOCV 25/26 (96%), against a 54% always-left baseline. The previous
   yaw-integral rule scored ~70% on the same trips when re-evaluated
   honestly, so this replaces it as the primary signal; yaw is kept as
   the fallback.

   MECHANISM. Positive skew means occasional sharp spikes rather than
   steady shaking. One platform is reached straight through the
   junction; the other diverges across the switch and crossing nose,
   which produces exactly that impulsive jolt. This retro-confirms the
   "rights looked rougher" observation in CLAUDE.md that never
   previously reached significance.

   WHY IT CANNOT LEARN CARRY ORIENTATION. |a| is a vector MAGNITUDE, so
   it is unchanged by any rotation of the device or any relabelling of
   its axes — the ORIENTATION_INVARIANT hard requirement is satisfied by
   construction, more strongly than for the gravity-projected features.
   Confirmed empirically: on two evenings the user made trips to
   different platforms 8 and 10 minutes apart (same phone, same pocket)
   and the feature tracked the platform, not the session.

   The window ENDS 8 s before the recording does, so the end-of-approach
   disturbance cannot contribute. That disturbance is measured, not
   assumed: vibration falls to 0.24 x cruise 7 s before the end and then
   rises to 0.93 x at 2 s and 1.32 x at 1 s, on 20 of 26 trips. It is the
   halt itself, the brakes, surrounding passengers, and the Stop tap
   together — not the user handling the phone, who reports keeping it
   still. Either way the fix is the same: end the window before it.

   HONEST LIMITS. n=26 and the window was chosen by the scan; the
   best-of-scan p-value, a chronological split (85%) and the smooth
   accuracy plateau over neighbouring windows all support it, but this
   has NOT yet been validated prospectively on trips recorded after
   2026-08-26. Treat the first several new trips as the real test.
   ------------------------------------------------------------ */
export const SKEW_FINAL = [22.0, 8.0];

// Live, arrival is unknown, so the window trails the current instant.
// Accuracy by true time-before-arrival, STREAMED through this class
// (an earlier note here quoted 96% at 8 s and 4 s; those came from an
// offline port that resampled to a uniform grid and did not reproduce):
//   30 s: 56%   24 s: 67%   20 s: 89%   16 s: 80%
//   12 s: 91%   8 s: 82%    4 s: 65%    0 s: 77%
// Two properties matter and both are load-bearing:
//  - it is INVERTED early (31% at 24 s out on the offline measure), which
//    is why the live path stays silent until braking is detected;
//  - it dips in the last ~5 s because the end-of-approach disturbance
//    enters the window. Vibration falls to 0.24 x cruise at 7 s out then
//    rises to 0.93 x at 2 s and 1.32 x at 1 s on 20/26 trips — the halt,
//    the brakes, people standing, and the Stop tap together. That is
//    precisely why SKEW_FINAL ends 8 s early, and the final verdict is
//    therefore unaffected by the dip.
// Attempts to damp the dip (EMA smoothing; freezing on a relative rise;
// freezing on an absolute rise with a minimum-readings guard) ALL fired
// too early and cut accuracy at arrival-12 s from 91% to 45-55%, because
// they lock in the inverted early readings. See the P_SMOOTH note below.
export const SKEW_TRAIL = 20.0;

// Route prior, Stockwell -> Brixton. See header.
export const MIN_JOURNEY = 85.0;   // s; a stop before this is never arrival
export const AUTO_ARM_AT = 75.0;   // s; final approach becomes plausible

const GRAV_TAU = 5.0;              // s, gravity lowpass
const VIB_WIN = 2.0;               // s, vibration RMS window
const BRAKE_TAU = 2.0;             // s, horizontal-accel lowpass
const WARMUP = 15.0;               // s before adaptive thresholds are trusted
const BRAKE_FRAC = 0.55;           // vibration RMS below this x cruise = slowing
const BRAKE_HOLD = 3.0;            // s it must hold before the gate opens

/* ------------------------------------------------------------
   JUNCTION-ANCHORED EARLY VERDICT — TRIED AND REVERTED, do not re-add
   without re-reading this.
   ------------------------------------------------------------
   The idea: detect the junction by the JOLT of crossing the pointwork
   (peak smoothed |d|a|/dt|) rather than by its turn or by braking, then
   read the skew over a window anchored on that detection. Offline it
   looked good — the jerk detector fired 26/26 with sd 14.6 s (vs 21.3 s
   for a yaw peak, 24-32 s for braking) and [det-14, det] scored 81%
   (p=0.003), [det-10, det] 77% (p=0.014).

   It FAILED when streamed through this class. A causal EMA-plus-confirm
   detector is not the offline global-argmax that was measured: it fired
   on only 14/26 trips and at arrival-16.9 s rather than arrival-27 s, so
   it read [arr-31, arr-17] — not the window that scored 81%. Worse, on
   trips where braking never triggers, that weaker verdict persisted to
   the end and dropped live accuracy at arrival-4 s from 92% to 65%,
   with flips rising from 0.58 to 1.04.

   AND THE 77-81% ITSELF WAS AN ARTEFACT. It came from smoothing the jerk
   with a CENTRED boxcar (np.convolve mode='same'), which reads samples
   from the future. Redone with a trailing filter — the only kind this
   class can compute — the detector's scatter goes from sd 14.6 s to
   24-28 s and the accuracy at [det-10, det] falls to:
       argmax deferred to braking      65%  p=0.20
       argmax deferred to braking+10s  65%  p=0.18
       argmax over the whole recording 73%  p=0.05
   Five detector variants were tried in all (yaw peak 62%, braking onset
   23%, jerk EMA+turnover, jerk onset, deferred argmax 65-73%). None
   approaches the 96% of the arrival-anchored SKEW_FINAL window.

   Root cause, which is worth remembering: the junction is DETECTABLE but
   not LOCALISABLE. Every causal detector finds an event on every trip
   and places it within a +/-24 s band, and a window anchored that
   loosely cannot line up across trips. The arrival instant is the only
   reference precise enough — which is why finalVerdict(), which legally
   knows it, is the accurate path and the live one is not.

   KURTOSIS, not skew, is the right statistic in this frame — and it also
   failed. Carrying |a|-skew into the junction-anchored frame because it
   won in the arrival-anchored one was a mistake; re-scanning within the
   frame found kurtosis of |a| over [det-10, det] at LOOCV 96%, p=0.0002
   best-of-scan over 144 features. It passed every check that exposed an
   earlier 96% as an orientation leak: labels interleaved in time (runs
   z=+1.64), chronological split 100%, same-evening trips 8 and 10 minutes
   apart tracking the platform not the session, an 88-96% plateau over
   neighbouring windows, and — the strongest evidence the anchor is real —
   windows that CONTAIN the detection scoring 88-96% while windows shifted
   off it collapse to 0-50%. Offline it gave 73/69/81/92/96/96/96/96% at
   arrival-30/24/20/16/12/8/4/0 s with 0.12 flips: never silent,
   monotonically improving, no dip at the stop. Everything the live path
   is supposed to do.

   Streamed through this class it gave 57-85%, with the arrival-4 s dip
   still present. Two implementations were tried: differencing raw ~60 Hz
   samples (85% at arrival-12 s) and binning to 20 Hz first to match the
   analysis exactly (65%). Neither reproduced 96%.

   THE REAL LESSON, and the reason this is recorded at length: |d|a|/dt|
   is strongly sample-rate dependent, so the detector's argmax moves with
   the preprocessing chain, and a feature anchored on it inherits that
   fragility. A 96% that survives only one exact chain is not a 96%. By
   contrast the arrival-anchored SKEW_FINAL window reproduced 25/26 in
   this class on the first attempt, from a completely independent Python
   implementation. That robustness is itself evidence, and is why skew
   ships and kurtosis does not.

   The lesson is the one this file already records elsewhere: an offline
   window and a causal detector for the same event are different
   measurements, and only the streamed number counts.
   ------------------------------------------------------------ */

// Defaults from the 15-trip fit; calibrate() overrides scale/threshold/sign.
const DEFAULT_CAL = { sign: 1, thrEarly: 0.255, scaleEarly: 1.27,
                      thrFinal: 0.0, scaleFinal: 1.9 };

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/**
 * Signed yaw integrated over [t_hi, t_lo] seconds before `endT`.
 * Orientation-invariant: the rotation vector is projected onto the
 * device's own gravity estimate, so how the phone is held cancels.
 *
 * @param {Array} samples  motion samples: {time(ms), ax,ay,az, gx,gy,gz,
 *                         rotationAlpha,rotationBeta,rotationGamma}
 * @param {number} endT    reference instant, ms
 * @param {number} backHi  window start, seconds before endT (larger)
 * @param {number} backLo  window end,   seconds before endT (smaller)
 * @returns {number} degrees; positive = one side, negative = the other
 */
export function yawIntegral(samples, endT, backHi, backLo) {
  if (!samples || samples.length < 2) return 0;
  const hi = endT - backHi * 1000;
  const lo = endT - backLo * 1000;

  // Gravity must be tracked from before the window so the lowpass has
  // settled; start the filter GRAV_TAU*3 earlier than the window.
  const warm = hi - GRAV_TAU * 3000;
  let g = null, prevT = null, prevYaw = 0, acc = 0;

  // Binary-search the start rather than scanning from 0: this runs on the
  // sensor thread ~1x/second against a buffer that grows to ~9000 samples.
  let loIdx = 0, hiIdx = samples.length - 1, start = samples.length;
  while (loIdx <= hiIdx) {
    const mid = (loIdx + hiIdx) >> 1;
    if (samples[mid].time >= warm) { start = mid; hiIdx = mid - 1; }
    else loIdx = mid + 1;
  }

  for (let i = start; i < samples.length; i++) {
    const s = samples[i];
    if (s.time > lo) break;

    const gv = [s.gx || 0, s.gy || 0, s.gz || 0];
    if (!g) {
      g = gv.slice();
      prevT = s.time;
    }
    const dt = Math.max((s.time - prevT) / 1000, 0);
    const a = Math.min(dt / GRAV_TAU, 1);
    for (let k = 0; k < 3; k++) g[k] += a * (gv[k] - g[k]);

    const gn = Math.hypot(g[0], g[1], g[2]) || 1;
    // W3C devicemotion axes: beta about x, gamma about y, alpha about z.
    const yaw = ((s.rotationBeta || 0) * g[0] +
                 (s.rotationGamma || 0) * g[1] +
                 (s.rotationAlpha || 0) * g[2]) / gn;

    if (s.time >= hi && prevT !== null && dt > 0) {
      acc += 0.5 * (yaw + prevYaw) * dt;   // trapezoid
    }
    prevT = s.time;
    prevYaw = yaw;
  }
  // Negated so that positive = LEFT under the reference device's sign
  // convention; calibrate() can flip this per device.
  return -acc;
}

/**
 * Skewness of |a| (acceleration MAGNITUDE) over [backHi, backLo] seconds
 * before `endT`. This is the v2 primary signal; see the SKEW_FINAL note.
 *
 * |a| is a magnitude, so this is invariant to device orientation and to
 * any relabelling of the device axes — no gravity projection needed.
 *
 * @param {Array} samples  motion samples with ax/ay/az
 * @param {number} endT    reference instant, ms
 * @param {number} backHi  window start, seconds before endT (larger)
 * @param {number} backLo  window end,   seconds before endT (smaller)
 * @returns {number|null}  skewness, or null if the window is too sparse
 */
export function magSkew(samples, endT, backHi, backLo) {
  if (!samples || samples.length < 2) return null;
  const hi = endT - backHi * 1000;
  const lo = endT - backLo * 1000;

  // Binary-search the window start: this runs on the sensor thread once
  // per UI update against a buffer that grows to ~9000 samples.
  let loIdx = 0, hiIdx = samples.length - 1, start = samples.length;
  while (loIdx <= hiIdx) {
    const mid = (loIdx + hiIdx) >> 1;
    if (samples[mid].time >= hi) { start = mid; hiIdx = mid - 1; }
    else loIdx = mid + 1;
  }

  let n = 0, sum = 0, sumSq = 0, sumCu = 0;
  const mags = [];
  for (let i = start; i < samples.length; i++) {
    const s = samples[i];
    if (s.time > lo) break;
    const m = Math.hypot(s.ax || 0, s.ay || 0, s.az || 0);
    mags.push(m);
    sum += m;
    n++;
  }
  if (n < 64) return null;                 // too sparse to trust a 3rd moment

  const mean = sum / n;
  for (let i = 0; i < n; i++) {
    const d = mags[i] - mean;
    sumSq += d * d;
    sumCu += d * d * d;
  }
  const sd = Math.sqrt(sumSq / n);
  if (sd < 1e-9) return null;
  return (sumCu / n) / (sd * sd * sd);
}

/**
 * Derive sign and scale from the user's own labelled examples, so a
 * device whose gravity axes are reported with the opposite sign cannot
 * silently invert every prediction.
 *
 * Also fits the v2 skew threshold. The skew feature does not have the
 * axis-sign ambiguity that forced self-calibration for yaw, but fitting
 * its threshold to the user's own trips still matters: the absolute skew
 * level depends on the phone's sampling rate and on how much the handset
 * is damped by a pocket versus a bare hand.
 *
 * @param {Array} examples  training examples with rawMotionData + label
 * @returns {object} calibration, or DEFAULT_CAL if there is not enough data
 */
export function calibrate(examples) {
  const L = [], R = [];
  const SL = [], SR = [];       // v2 skew values, per class
  for (const ex of examples || []) {
    const raw = ex.rawMotionData;
    if (!raw || raw.length < 600) continue;
    const end = raw[raw.length - 1].time;         // user stops at arrival
    const v = yawIntegral(raw, end, WIN_FINAL[0], WIN_FINAL[1]);
    const sk = magSkew(raw, end, SKEW_FINAL[0], SKEW_FINAL[1]);
    (ex.label === "left" ? L : R).push(v);
    if (sk !== null) (ex.label === "left" ? SL : SR).push(sk);
  }
  if (L.length < 3 || R.length < 3) return { ...DEFAULT_CAL, n: L.length + R.length };

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mL = mean(L), mR = mean(R);
  const sd = Math.sqrt(0.5 * (variance(L) + variance(R))) || 1;
  const sign = mL >= mR ? 1 : -1;                 // self-calibrating
  const out = {
    sign,
    thrFinal: (mL + mR) / 2,
    scaleFinal: Math.max(sd, 0.4),
    thrEarly: DEFAULT_CAL.thrEarly * sign,
    scaleEarly: DEFAULT_CAL.scaleEarly,
    n: L.length + R.length,
    separation: Math.abs(mL - mR) / sd,
  };

  // v2 skew calibration. Same convention as the yaw path: signSkew is
  // chosen so that a HIGHER sign*(x - thr) means LEFT, which lets both
  // signals share logistic() and the p>0.5 test.
  if (SL.length >= 3 && SR.length >= 3) {
    // MEDIAN midpoint, not mean. The classes separate cleanly, so the
    // threshold sits in an empty gap and the only question is how stable
    // its placement is. Measured by LOOCV over the 26 trips:
    //   midpoint of means   92%   (p=0.0003)
    //   midpoint of the gap 96%   (p=0.0003) but keyed to the 2 extreme trips
    //   best split on train 96%   (p=0.0397)
    //   MEDIAN midpoint     96%   (p=0.0003)  <- chosen
    // Medians ignore the right tail (skew runs to +3.5 on some right
    // trips), so one unusually violent crossing cannot drag the boundary.
    const sL = median(SL), sR = median(SR);
    const ssd = Math.sqrt(0.5 * (variance(SL) + variance(SR))) || 1;
    out.signSkew = sL >= sR ? 1 : -1;
    out.thrSkew = (sL + sR) / 2;
    out.scaleSkew = Math.max(ssd, 0.15);
    out.separationSkew = Math.abs(sL - sR) / ssd;
    out.nSkew = SL.length + SR.length;
  }
  return out;
}

function variance(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
}

function logistic(x, thr, scale, sign) {
  return 1 / (1 + Math.exp(-(sign * (x - thr)) / scale));
}

/**
 * Authoritative verdict for a COMPLETED recording.
 *
 * Only valid once the user has tapped Stop, because it trusts the
 * recording's own endpoint as the arrival instant — the user's protocol is
 * to stop within ~1 s of the train halting at Brixton. A live, in-progress
 * recording genuinely cannot know it has arrived (see the arrival-detection
 * note in ForkEngine.update), which is the same live/complete split the
 * app's `recordingComplete` flag already encodes.
 *
 * @param {Array} samples  full recording
 * @param {object} cal     calibration from calibrate()
 * @returns {object|null}  {score, pLeft, prediction} or null if too short
 */
export function finalVerdict(samples, cal) {
  const c = cal || DEFAULT_CAL;
  if (!samples || samples.length < 2) return null;
  const end = samples[samples.length - 1].time;
  const durSec = (end - samples[0].time) / 1000;
  if (durSec < WIN_FINAL[0]) return null;          // not enough approach

  // v2 primary: |a| skew over [arr-22, arr-8]. LOOCV 96% on 26 trips vs
  // ~70% for the yaw integral on the same trips. Needs a calibration
  // fitted from the user's own labelled data (see calibrate); until that
  // exists we fall back to the yaw rule rather than guess an absolute
  // skew threshold, which depends on sample rate and handset damping.
  if (c.thrSkew !== undefined && durSec >= SKEW_FINAL[0]) {
    const sk = magSkew(samples, end, SKEW_FINAL[0], SKEW_FINAL[1]);
    if (sk !== null) {
      const p = logistic(sk, c.thrSkew, c.scaleSkew, c.signSkew);
      return {
        score: sk,
        signal: "mag-skew",
        pLeft: p,
        pRight: 1 - p,
        prediction: p > 0.5 ? "left" : "right",
        shortJourney: durSec < MIN_JOURNEY,
      };
    }
  }

  const score = yawIntegral(samples, end, WIN_FINAL[0], WIN_FINAL[1]);
  const p = logistic(score, c.thrFinal, c.scaleFinal, c.sign);
  return {
    score,
    signal: "yaw-integral",
    pLeft: p,
    pRight: 1 - p,
    prediction: p > 0.5 ? "left" : "right",
    shortJourney: durSec < MIN_JOURNEY,            // caller may want to warn
  };
}

/**
 * Streaming predictor. Feed it samples as they arrive; ask it for the
 * current verdict. All state is causal — nothing looks ahead.
 */
export class ForkEngine {
  constructor(cal) {
    this.cal = cal || DEFAULT_CAL;
    this.t0 = null;
    this.tLast = null;
    this.g = null;
    this.aH = [0, 0, 0];
    this.vib = [];        // {t, mag}
    this.rmsSamples = []; // 1 Hz, for the adaptive quiet threshold
    this.rmsNext = 0;
    this.armed = false;
    this.quietStart = null;
    this.arrivalAt = null;   // ms, confirmed arrival instant
    // v2: the trailing skew reading is INVERTED early in the approach
    // (31% at 24 s out), so it is only shown once the train is slowing.
    // Vibration energy falls with speed, which is orientation-invariant
    // and needs no heading reference.
    this.braking = false;
    this.brakeRun = 0;
  }

  /**
   * @param {object} s   one motion sample
   * @param {Array} all  the full sample buffer (for window integrals)
   * @returns {object} {phase, pLeft, prediction, elapsed, armed}
   */
  update(s, all, computeVerdict = true) {
    const t = s.time;
    if (this.t0 === null) { this.t0 = t; this.tLast = t; }
    const dt = Math.max((t - this.tLast) / 1000, 0);
    this.tLast = t;
    const elapsed = (t - this.t0) / 1000;

    // gravity + horizontal acceleration
    const gv = [s.gx || 0, s.gy || 0, s.gz || 0];
    if (!this.g) this.g = gv.slice();
    const ag = Math.min(dt / GRAV_TAU, 1);
    for (let k = 0; k < 3; k++) this.g[k] += ag * (gv[k] - this.g[k]);
    const gn = Math.hypot(...this.g) || 1;
    const ghat = this.g.map((c) => c / gn);
    const acc = [s.ax || 0, s.ay || 0, s.az || 0];
    const adg = acc[0] * ghat[0] + acc[1] * ghat[1] + acc[2] * ghat[2];
    const ah = acc.map((a, i) => a - adg * ghat[i]);
    const ab = Math.min(dt / BRAKE_TAU, 1);
    for (let k = 0; k < 3; k++) this.aH[k] += ab * (ah[k] - this.aH[k]);

    // vibration RMS over a trailing window -> quiet detection
    const amag = Math.hypot(...acc);
    this.vib.push({ t, mag: amag });
    while (this.vib.length && this.vib[0].t < t - VIB_WIN * 1000) this.vib.shift();
    const vals = this.vib.map((v) => v.mag);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const rms = Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length);
    if (elapsed >= this.rmsNext && elapsed >= 5) {
      this.rmsSamples.push(rms);
      this.rmsNext = elapsed + 1;
    }
    const med = (this.rmsSamples.length && elapsed >= WARMUP) ? median(this.rmsSamples) : 0.25;
    const quietThr = Math.min(Math.max(0.45 * med, 0.04), 0.15);

    if (!this.armed && elapsed >= AUTO_ARM_AT) this.armed = true;

    // Braking gate: vibration RMS sustained below BRAKE_FRAC of the
    // cruising median. Latches once set — the approach does not un-brake.
    if (!this.braking && this.rmsSamples.length >= 10 && elapsed >= WARMUP) {
      if (rms < BRAKE_FRAC * median(this.rmsSamples)) {
        this.brakeRun += dt;
        if (this.brakeRun >= BRAKE_HOLD) this.braking = true;
      } else {
        this.brakeRun = 0;
      }
    }

    // Arrival detection, ONLY once the route prior says the destination is
    // reachable: before MIN_JOURNEY a quiet stretch is a signal halt or a
    // Brixton pre-platform hold, never the arrival.
    //
    // NOTE: this rarely fires live, and that is expected. The user stops the
    // recording within ~1 s of the train halting, so a long stationary dwell
    // never exists — the same constraint that forced the app's own anchor
    // away from requiring stillness (CLAUDE.md, v5). The authoritative answer
    // therefore comes from finalVerdict() once recording is complete; this
    // path only helps when the user happens to leave it running.
    if (rms < quietThr) {
      if (this.quietStart === null) this.quietStart = t;
      const qDur = (t - this.quietStart) / 1000;
      const qElapsed = (this.quietStart - this.t0) / 1000;
      if (qDur >= 1.5 && qElapsed >= MIN_JOURNEY && this.arrivalAt === null) {
        this.arrivalAt = this.quietStart;
      }
    } else {
      this.quietStart = null;
      // motion resumed: whatever that quiet was, it was not the arrival
      this.arrivalAt = null;
    }

    // ---- verdict
    // The state machine above must see every sample, but the window integral
    // is O(window) and only worth running once per UI update — callers feeding
    // a backlog pass computeVerdict=false for all but the last sample.
    if (!computeVerdict) return null;

    let phase, score, p;
    if (this.arrivalAt !== null) {
      phase = "final";
      score = yawIntegral(all, this.arrivalAt, WIN_FINAL[0], WIN_FINAL[1]);
      p = logistic(score, this.cal.thrFinal, this.cal.scaleFinal, this.cal.sign);
    } else if (this.armed && this.braking && this.cal.thrSkew !== undefined) {
      // v2 live path: |a| skew over a trailing SKEW_TRAIL window.
      //
      // v1 integrated yaw over [t-6, t]. That is a 6 s window, and it
      // coincides with the validated [arr-22, arr-16] window at exactly
      // ONE instant — every other second it thresholded a short, noisy
      // segment that had never been validated. That is what made the
      // displayed answer swing left/right several times per approach.
      //
      // The trailing skew window is 20 s, so it is far better averaged.
      // Measured accuracy by true time-before-arrival:
      //   24 s: 31%   20 s: 73%   16 s: 85%   12 s: 77%   8 s: 96%
      // It is INVERTED at 24 s out, before braking begins — which is why
      // this branch also requires `braking`. Showing a reading during the
      // inverted zone is worse than showing nothing.
      phase = "early";
      // A LAGGED window [t-22, t-8] was tried, so that the live reading
      // would converge exactly onto the final verdict at the arrival
      // instant. It does (96% at arrival-0 s) but is much worse where the
      // live display actually earns its keep — 55% at arrival-12 s and
      // 70% at arrival-16 s, with flips up from 0.96 to 1.35. Tapping
      // Stop yields the 96% final verdict regardless, so the live path is
      // optimised for EARLY accuracy instead, which this plain trailing
      // window gives: 91% at arrival-12 s, 82% at arrival-8 s.
      const sk = magSkew(all, t, SKEW_TRAIL, 0);
      if (sk === null) {
        phase = "waiting";
        score = 0;
        p = 0.5;
      } else {
        score = sk;
        p = logistic(sk, this.cal.thrSkew, this.cal.scaleSkew, this.cal.signSkew);
        p = Math.min(Math.max(p, 0.10), 0.90);  // provisional, cap confidence
        // Deliberately NO smoothing, freezing or holding here. All three
        // were tried to make the display settle and all three fired while
        // the reading was still inverted, cutting accuracy at arrival-12 s
        // from 91% to 45-55%. The 20 s window is already an average; the
        // remaining flicker is the honest cost of not knowing where the
        // arrival is. See the SKEW_TRAIL note.
      }
    } else if (this.armed && this.cal.thrSkew === undefined) {
      // No skew calibration yet (fewer than 3 labelled trips per side).
      // Fall back to the v1 yaw reading so a fresh install still shows
      // something, with its known flicker.
      phase = "early";
      score = yawIntegral(all, t, WIN_EARLY[0] - WIN_EARLY[1], 0);
      p = logistic(score, this.cal.thrEarly, this.cal.scaleEarly, this.cal.sign);
      p = Math.min(Math.max(p, 0.15), 0.85);   // provisional, cap confidence
    } else {
      phase = "waiting";
      score = 0;
      p = 0.5;
    }
    return {
      phase,
      score,
      pLeft: p,
      pRight: 1 - p,
      prediction: p > 0.5 ? "left" : "right",
      elapsed,
      armed: this.armed,
      braking: this.braking,
    };
  }
}
