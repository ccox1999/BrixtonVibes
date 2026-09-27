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

export const FORK_ENGINE_VERSION = 3;

// Windows are relative to the arrival instant, in seconds before it.
export const WIN_FINAL = [26.0, 10.0];
export const WIN_EARLY = [22.0, 16.0];

/* ------------------------------------------------------------
   v4 LIVE PATH — rolling turn + jolt reading, held once braking starts.
   ------------------------------------------------------------
   WHY v3 WAS REPLACED. Nine trips recorded after the v3 constants were
   fixed (examples 27-35, 5L/4R, 2026-09-08..27) are the first genuinely
   prospective test of this file. Calibrated on the 26 older trips only:
       junction kurtosis (v3 live), arrival-10 s   4/9   AUC 0.55 = chance
       |a| skew SKEW_FINAL (post-Stop)             6/9   (25/26 on the old)
       yaw WIN_FINAL                               8/9   AUC 0.85 (0.80 old)
   The recordings did not change — same 60 Hz, |g|, carry pose, and every
   trip still ends 2-3 s after the halt. What changed is that 3 of the 4
   new right trips have skew 0.22-0.32, squarely in left territory: the
   jolt that marked right arrivals weakened, the turn itself did not.
   Perfect separation from a scan of 8316 features over 26 trips was, in
   hindsight, too good to last.

   THE READING. A TRAILING window needs no arrival estimate. Read 10 s
   before Stop, [t-16, t] IS the validated yaw window [arr-26, arr-10] and
   [t-14, t] the skew window [arr-24, arr-10]. calibrate() fits each one's
   sign / median-midpoint threshold / pooled spread on the user's own
   trips at exactly that lead (LIVE_CAL_LEAD), and the two z-scores are
   averaged with equal weight. They are independent physics — the turn
   and the jolt — so one of them drifting cannot flip the call on its own.

   THE HOLD. A rolling window is best ~10 s out and then slides past the
   junction into the S-bend's swing-back, where yaw INVERTS (AUC 0.35 over
   [arr-12, arr-6]; 0.00 on the new trips). So once vibration stays below
   BRAKE_FRAC x cruise for BRAKE_HOLD s — the final braking, 7-11 s before
   Stop on an ordinary trip — the reading taken as the decline BEGAN is
   held. Unlike the old one-shot braking latch this re-arms: vibration
   back at HOLD_RESUME x cruise for HOLD_RESUME_SEC means the train moved
   off again (a Brixton pre-platform hold), and the hold is released. The
   5 s matters: the halt + Stop-tap disturbance lasts ~2-3 s and released
   a 3 s version on 4/35 trips; a genuine restart lasts 20 s or more.

   MEASURED, streamed through this class (analyze-loocv.mjs), LOOCV over
   35 trips (19L/16R), calibration refit per fold, silence = wrong:
       arrival-   30   20   16   12   10    8    6    4    2    0 s
       v3 (was)   40   54   71   74   74   71   69   60   71   74 %
       v4         20   43   63   71   83   77   74   69   74   66 %
   Prospective, calibrated on the old 26 only, arrival-10 s: v3 4/9, v4
   8/9. The whole lead-10 family that was tried (3 yaw x 3 skew windows
   and 4 pairings) scores best-of-family permutation p = 0.0015 (2000
   shuffles), so the signal is not an artefact of trying several.

   HONEST LIMITS.
   - Before ~12 s out the junction has not been crossed, so there is
     nothing to read. Earlier readings are near chance and flip ~1.3
     times per trip between arrival-30 and arrival-10. They are labelled
     provisional; hiding them instead was the rejected v2 behaviour.
   - After a long pre-platform hold the cruise median includes the
     stationary time, so the final braking can fail to look quiet enough
     and the hold never re-engages (the last seconds then decay as the
     window passes the junction). Not fixed: that means redesigning the
     braking detector on the same 35 trips it would be judged on.
   - Shown confidence is conservative (mean 69% at arrival-10 s against
     83% accuracy) and deliberately uncapped.
   - Accuracy dips again in the last few seconds (66% at the Stop tap) on
     trips where the hold did not engage or re-engage. Tapping Stop
     replaces it with the post-Stop verdict.
   - The post-Stop verdict is unchanged (skew, 31/35 LOOCV) though it
     scored 6/9 prospectively. Yaw scored 8/9 there but 28/35 overall;
     nine trips cannot tell those apart, so it was left alone.

   TRIED FROM THE 2026-09-27 OVERHAUL PROMPT, REJECTED (same harness,
   arrival-10 s, LOOCV / prospective):
       skew first, no braking gate, [t-20, t]           74% / 5/9
       adaptive [t-30, t] -> [t-22, t-8] on braking     63% / 6/9
       ... plus hysteresis (lock 65%, switch 70%)       57% / 3/9
       live recordingComplete=true in makeLivePrediction: no effect — that
       call feeds only the kNN fallback, which never runs while this
       engine answers. Confidence caps change the number shown, never the
       side, so they cannot cause (or cure) a wrong call or a flip.
   ------------------------------------------------------------ */
export const LIVE_YAW_TRAIL = 16.0;   // s; = WIN_FINAL when read 10 s out
export const LIVE_SKEW_TRAIL = 14.0;  // s; = [arr-24, arr-10] when read 10 s out
export const LIVE_CAL_LEAD = 10.0;    // s before Stop the live reading is fitted at
const HOLD_RESUME = 1.0;              // x cruise vibration = moving again
const HOLD_RESUME_SEC = 5.0;          // s it must last to release a hold

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

   PROSPECTIVE RESULT (2026-09-27): 6/9 on the nine trips recorded after
   that date — 3 of the 4 new right trips fell in the left range. Still
   the post-Stop verdict (31/35 LOOCV over all trips), no longer trusted
   as ground truth for the live path. See the v4 note.
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

/* ------------------------------------------------------------
   v3 LIVE PATH — junction-anchored kurtosis. RETIRED 2026-09-27: at
   chance (AUC 0.55, 4/9) on the nine trips recorded after it shipped.
   Kept for the record and because detectJunction/magKurtosis are still
   exported; the live path no longer calls them. See the v4 note.
   ------------------------------------------------------------
   THE OBJECTIVE IS EARLY PREDICTION. The user does not want an accurate
   answer once Stop is pressed; by then the platform is visible and the
   answer is worthless. Only a reading available WELL BEFORE arrival
   counts, which means SILENCE IS A FAILURE, not an abstention.

   Scored that way — correct out of ALL 26 trips, a trip with no reading
   yet counting as wrong — the arrival-anchored trailing window is poor,
   because it waits for braking and is still silent on most trips when it
   matters:
       arrival-16 s   8 correct, 16 silent  -> 31%
       arrival-12 s  10 correct, 15 silent  -> 38%
       arrival-8 s   14 correct,  9 silent  -> 54%
   Its headline "91% at arrival-12 s" was computed only over the 11 trips
   where it had anything to say.

   Anchoring on the junction instead removes the wait entirely. Detect the
   crossing, read a window ending at it, and how long the train then takes
   to reach the platform stops mattering — which is the point, because
   that duration varies hugely (Brixton holds trains for the platform to
   clear) and is what forced the braking gate in the first place.

   DETECTOR: argmax of trailing-smoothed |d|a|/dt| over [JUNCTION_ARM, now].
   Causal at every instant; it settles on its final position by
   arrival-43 s on all 26 trips.
   FEATURE: kurtosis of |a| over [det-10, det]  (WIN_JUNCTION).

   Skew was tried here first, purely because it won in the
   arrival-anchored frame, and scores only 65-73%. Kurtosis — peakedness,
   i.e. heavy tails — is the right description of an impulsive jolt.

   VERIFICATION (the checks that exposed an earlier 96% as an orientation
   leak): labels well interleaved in time (runs z=+1.64); chronological
   split 100%; trips 8 and 10 minutes apart on the same evening track the
   platform, not the session (21 Jul R 8.9 / L 3.2 / R 10.4; 19 Aug
   R 11.4 / L 3.5); neighbouring windows 88-96%; and windows shifted OFF
   the detection collapse to 0-50% while those containing it hold 88-96%
   — direct evidence the anchor is real. Best-of-scan p=0.0002 over 144
   features, so the size of the search is paid for.

   HONEST LIMITS. Offline this scored 96% from arrival-12 s; streamed
   through this class it is 81-85%. |d|a|/dt| is sample-rate dependent, so
   the detector's argmax shifts with the preprocessing chain and the
   offline figure does not transfer — binning to 20 Hz to match the
   analysis made it worse (65%), not better. 81-85% ON EVERY TRIP is
   nevertheless far better against the actual objective than 91% on 40% of
   them. The classes also overlap slightly here (left tops at 6.56, right
   starts at 5.94), unlike the cleanly separated skew feature, and none of
   this is validated prospectively.
   ------------------------------------------------------------ */
export const JUNCTION_ARM = 45.0;   // s; detection may look from here
export const JERK_SMOOTH = 3.0;     // s, trailing mean on |d|a|/dt|
export const WIN_JUNCTION = [10.0, 0.0];   // kurtosis window, rel. to detection

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
 * Kurtosis of |a| over [backHi, backLo] seconds before `endT`.
 * The v3 live signal; see the WIN_JUNCTION note. Like magSkew this uses a
 * vector MAGNITUDE, so it is invariant to device orientation and to any
 * relabelling of the axes.
 *
 * @returns {number|null} kurtosis, or null if the window is too sparse
 */
export function magKurtosis(samples, endT, backHi, backLo) {
  if (!samples || samples.length < 2) return null;
  const hi = endT - backHi * 1000;
  const lo = endT - backLo * 1000;

  let loIdx = 0, hiIdx = samples.length - 1, start = samples.length;
  while (loIdx <= hiIdx) {
    const mid = (loIdx + hiIdx) >> 1;
    if (samples[mid].time >= hi) { start = mid; hiIdx = mid - 1; }
    else loIdx = mid + 1;
  }

  const mags = [];
  let sum = 0;
  for (let i = start; i < samples.length; i++) {
    const s = samples[i];
    if (s.time > lo) break;
    const m = Math.hypot(s.ax || 0, s.ay || 0, s.az || 0);
    mags.push(m);
    sum += m;
  }
  const n = mags.length;
  if (n < 64) return null;               // too sparse for a 4th moment

  const mean = sum / n;
  let s2 = 0, s4 = 0;
  for (let i = 0; i < n; i++) {
    const d = mags[i] - mean;
    const d2 = d * d;
    s2 += d2;
    s4 += d2 * d2;
  }
  const varr = s2 / n;
  if (varr < 1e-18) return null;
  return (s4 / n) / (varr * varr);
}

/**
 * Locate the junction: the instant of peak impulsiveness after
 * JUNCTION_ARM. Strictly causal — it only ever reads samples at or before
 * `endT`, so the live path and the completed-recording path compute the
 * same thing from the same data.
 *
 * The smoothing is a TRAILING mean, deliberately. An earlier version used
 * a centred one, which reads samples from the future; that inflated the
 * apparent accuracy and could not be reproduced live.
 *
 * NOTE: this differences the raw samples. Binning |a| to a fixed 20 Hz
 * grid first (to match the offline analysis exactly) was tried and made
 * the streamed accuracy WORSE — 65% against 85% at arrival-12 s. Do not
 * "fix" this by adding decimation.
 *
 * @param {Array} samples  motion samples
 * @param {number} endT    look no later than this instant, ms
 * @returns {number|null}  timestamp of the detected crossing, ms
 */
export function detectJunction(samples, endT) {
  if (!samples || samples.length < 2) return null;
  const t0 = samples[0].time;
  const from = t0 + JUNCTION_ARM * 1000;
  if (endT <= from) return null;

  let prevMag = null, prevT = null;
  const win = [];              // {t, j} within JERK_SMOOTH
  let winSum = 0;
  let bestVal = -Infinity, bestT = null;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.time > endT) break;
    const m = Math.hypot(s.ax || 0, s.ay || 0, s.az || 0);
    if (prevMag !== null) {
      const dt = (s.time - prevT) / 1000;
      if (dt > 0) {
        const j = Math.abs(m - prevMag) / dt;
        win.push({ t: s.time, j });
        winSum += j;
        while (win.length && win[0].t < s.time - JERK_SMOOTH * 1000) {
          winSum -= win.shift().j;
        }
        if (s.time >= from && win.length) {
          const avg = winSum / win.length;
          if (avg > bestVal) { bestVal = avg; bestT = s.time; }
        }
      }
    }
    prevMag = m;
    prevT = s.time;
  }
  return bestT;
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
 * Also fits the v4 live reading (liveYaw / liveSkew): each trip's
 * TRAILING windows read LIVE_CAL_LEAD s before its own Stop — exactly what
 * the live windows read at that lead. See the v4 note.
 *
 * @param {Array} examples  training examples with rawMotionData + label
 * @returns {object} calibration, or DEFAULT_CAL if there is not enough data
 */
export function calibrate(examples) {
  const L = [], R = [];
  const SL = [], SR = [];       // v2 skew values, per class
  const YL = [], YR = [];       // v4 live yaw, per class
  const LSL = [], LSR = [];     // v4 live skew, per class
  for (const ex of examples || []) {
    const raw = ex.rawMotionData;
    if (!raw || raw.length < 600) continue;
    const end = raw[raw.length - 1].time;         // user stops at arrival
    const left = ex.label === "left";
    const v = yawIntegral(raw, end, WIN_FINAL[0], WIN_FINAL[1]);
    const sk = magSkew(raw, end, SKEW_FINAL[0], SKEW_FINAL[1]);
    (left ? L : R).push(v);
    if (sk !== null) (left ? SL : SR).push(sk);

    const cut = end - LIVE_CAL_LEAD * 1000;
    (left ? YL : YR).push(yawIntegral(raw, cut, LIVE_YAW_TRAIL, 0));
    const ls = magSkew(raw, cut, LIVE_SKEW_TRAIL, 0);
    if (ls !== null) (left ? LSL : LSR).push(ls);
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

  // v4 live reading. Both parts or neither: the reading is their average.
  if (YL.length >= 3 && YR.length >= 3 && LSL.length >= 3 && LSR.length >= 3) {
    out.liveYaw = fitLive(YL, YR);
    out.liveSkew = fitLive(LSL, LSR);
  }
  return out;
}

/**
 * Sign / threshold / spread for one v4 live signal, oriented so that
 * sign * (x - thr) / sd > 0 means LEFT. Median midpoint for the reason
 * given at the skew threshold: robust to the long right-hand tail.
 */
function fitLive(L, R) {
  const mL = median(L), mR = median(R);
  return {
    sign: mL >= mR ? 1 : -1,
    thr: (mL + mR) / 2,
    sd: Math.sqrt(0.5 * (variance(L) + variance(R))) || 1,
  };
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
    this.rmsSamples = []; // 1 Hz, for the running cruise level
    this.rmsNext = 0;
    this.cruise = null;   // median of rmsSamples, refreshed at 1 Hz
    this.armed = false;
    // v4 braking hold — see the v4 note. Vibration energy falls with
    // speed, which is orientation-invariant and needs no heading reference.
    this.lowSince = null;   // ms, start of the current below-BRAKE_FRAC run
    this.highSince = null;  // ms, start of the current back-at-cruise run
    this.lowStartZ = null;  // live reading as that low run began
    this.lastZ = null;      // most recent live reading
    this.held = null;       // held reading, or null when live
    this.braking = false;   // true while a hold is engaged
  }

  /**
   * @param {object} s   one motion sample
   * @param {Array} all  the full sample buffer (for window integrals)
   * @returns {object} {phase, pLeft, prediction, elapsed, armed, braking}
   *   phase: "waiting" | "provisional" (rolling reading) | "held" (braking
   *   hold) | "early" (v1 yaw fallback before there is a calibration)
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

    // vibration RMS over a trailing window, and the running cruise level
    const amag = Math.hypot(...acc);
    this.vib.push({ t, mag: amag });
    while (this.vib.length && this.vib[0].t < t - VIB_WIN * 1000) this.vib.shift();
    const vals = this.vib.map((v) => v.mag);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const rms = Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length);
    if (elapsed >= this.rmsNext && elapsed >= 5) {
      this.rmsSamples.push(rms);
      this.rmsNext = elapsed + 1;
      // Sorted once a second here rather than on every sample.
      if (this.rmsSamples.length >= 10 && elapsed >= WARMUP) this.cruise = median(this.rmsSamples);
    }

    if (!this.armed && elapsed >= AUTO_ARM_AT) this.armed = true;

    // v4 braking hold. Engage: vibration below BRAKE_FRAC x cruise for
    // BRAKE_HOLD s, holding the reading from when the decline BEGAN (the
    // trailing window then still covers the junction). Release: back at
    // HOLD_RESUME x cruise for HOLD_RESUME_SEC — the train moved off again,
    // so that was a pre-platform hold, not the final approach.
    //
    // There is deliberately no live ARRIVAL detector any more. The old one
    // (quiet for 1.5 s after MIN_JOURNEY) almost never fired because the
    // user taps Stop within ~1 s of the halt, and could fire on a Brixton
    // pre-platform hold. finalVerdict() owns the arrival once Stop is tapped.
    const ratio = this.cruise ? rms / this.cruise : 1;
    if (this.armed && this.cruise && ratio < BRAKE_FRAC) {
      if (this.lowSince === null) { this.lowSince = t; this.lowStartZ = this.lastZ; }
    } else {
      this.lowSince = null;
    }
    if (this.cruise && ratio >= HOLD_RESUME) {
      if (this.highSince === null) this.highSince = t;
    } else {
      this.highSince = null;
    }
    if (this.held !== null && this.highSince !== null &&
        t - this.highSince >= HOLD_RESUME_SEC * 1000) {
      this.held = null;
    }
    if (this.held === null && this.lowSince !== null && this.lowStartZ !== null &&
        t - this.lowSince >= BRAKE_HOLD * 1000) {
      this.held = this.lowStartZ;
    }
    this.braking = this.held !== null;

    // ---- verdict
    // The state machine above must see every sample, but the window integral
    // is O(window) and only worth running once per UI update — callers feeding
    // a backlog pass computeVerdict=false for all but the last sample.
    if (!computeVerdict) return null;

    let phase = "waiting", score = 0, p = 0.5;
    const c = this.cal;
    if (this.armed && c.liveYaw && c.liveSkew) {
      // v4. The reading is refreshed even while held, so a released hold
      // (or the next low run) starts from a current value, not a stale one.
      const z = this.liveReading(all, t);
      if (z !== null) this.lastZ = z;
      if (this.held !== null) { phase = "held"; score = this.held; }
      else if (z !== null) { phase = "provisional"; score = z; }
      // The average of two z-scores, used directly as log-odds. No cap:
      // measured, it is if anything under-confident (see the v4 note).
      if (phase !== "waiting") p = logistic(score, 0, 1, 1);
    } else if (this.armed) {
      // No live calibration yet (fewer than 3 labelled trips per side).
      // Fall back to the v1 yaw reading so a fresh install still shows
      // something, with its known flicker.
      phase = "early";
      score = yawIntegral(all, t, WIN_EARLY[0] - WIN_EARLY[1], 0);
      p = logistic(score, c.thrEarly, c.scaleEarly, c.sign);
      p = Math.min(Math.max(p, 0.15), 0.85);   // provisional, cap confidence
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

  /**
   * v4 live reading at instant t: the equal-weight mean of the trailing
   * yaw and skew z-scores, each oriented so that positive = LEFT.
   * @returns {number|null} null if the skew window is too sparse
   */
  liveReading(all, t) {
    const { liveYaw: y, liveSkew: k } = this.cal;
    const sk = magSkew(all, t, LIVE_SKEW_TRAIL, 0);
    if (sk === null) return null;
    const yw = yawIntegral(all, t, LIVE_YAW_TRAIL, 0);
    return 0.5 * (y.sign * (yw - y.thr) / y.sd + k.sign * (sk - k.thr) / k.sd);
  }
}
