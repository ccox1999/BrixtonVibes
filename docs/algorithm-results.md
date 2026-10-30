# Prediction study — 30 October 2026

The existing route decision survived the new data. This development retains its yaw-plus-vibration decision and braking hold, improves the meaning of its confidence, and suppresses readings after missing sensors or recording interruptions. It does **not** claim a demonstrated increase in branch accuracy or a verified earlier junction prediction.

The baseline is the v5.1 logic shipped on 28 September in repository commit `5800ff2` (service-worker version 38); its older `FORK_ENGINE_VERSION` constant was still 4. The preserved source is not the earlier v4 decision that the historical notes also describe. This development uses engine version 6.

## Dataset and validation

The 30 October export is cumulative: 42 actual journeys, 21 left and 21 right. Its first 35 raw recordings are byte-for-byte identical to the September export after JSON parsing; they are counted once, not as 77 independent journeys. There are seven new journeys, dated 6–28 October (2 left, 5 right), rather than seven journeys made on 30 October. Original exports are unchanged and remain ignored by Git.

All 42 journeys have approximately 60 Hz acceleration, gravity estimates, and rotation rates. Durations range from 90.9 to 161.6 seconds. Several older recordings have repeated/out-of-order millisecond timestamps; the longest sample gap is 358 ms. The new engine skips non-increasing timestamps rather than integrating them twice. This leaves the measured branch results unchanged.

Three comparisons are reproducible:

1. **Outer leave-one-journey-out (42 folds).** Every test journey is excluded from branch fitting and confidence fitting. Confidence fitting itself makes predictions with each training journey omitted, so it also uses an inner journey split. Whole journeys stay together; samples or windows from the test journey never become training examples.
2. **September-to-October holdout.** Fit only the earlier 35 and evaluate the seven new journeys. The previously shipped decision was fixed before these recordings; its accuracy on these seven is a genuinely prospective test. The v6 confidence method was designed during this development, so its chronological comparison is retrospective, not a claim of a prospectively locked confidence model.
3. **August-to-September/October holdout.** Fit the earlier 26; evaluate the later 16. This reproduces the original nine-journey holdout and extends it with October's seven. Both old and new route decisions get 14/16 at Finish.

The existing feature windows and hold thresholds were developed on the older journeys. Leave-one-out refits their calibration, but does not undo that earlier model selection. Treat 42-fold results as development estimates; future untouched journeys remain the stronger test. Three October journeys also came from the same evening, so seven is not a large, fully independent sample.

## Decision accuracy and timing

Nothing shown counts as wrong in the accuracy denominator. Finish means the last live reading; tapping Finish does not trigger a retrospective replacement answer. Seconds before Finish are evaluation anchors from a completed recording, **not independently measured junction-crossing or platform-visibility times**.

| Evaluation | 16 s before Finish | 12 s | 10 s | 8 s | At Finish |
|---|---:|---:|---:|---:|---:|
| Previous engine, 42-fold | 25/42 | 33/42 | 36/42 | 37/42 | 37/42 |
| v6, 42-fold | 25/42 | 33/42 | 36/42 | 37/42 | 37/42 |
| Previous engine, frozen September fit, new seven | 4/7 | 7/7 | 7/7 | 7/7 | 7/7 |
| v6, September-only fitting, new seven | 4/7 | 7/7 | 7/7 | 7/7 | 7/7 |

Final 42-fold accuracy is 88.1%; a rough Wilson 95% interval is 75–95%. Seven out of seven is encouraging, but its corresponding interval is roughly 65–100%, before allowing for same-evening dependence. The majority baseline is 50% over all 42 and 71% over the seven new trips.

The first braking-held firm call appears a median 8.3 seconds before Finish. There are 66 changes of displayed direction across all live journeys (1.57/journey); only two occur after a first firm call (0.048/journey). On the new seven there are ten early changes and no post-firm changes. An early rolling direction remains tentative; it is not a dependable promise.

## Alternatives actually compared

All alternatives use the same causal, re-armable hold and whole-journey calibration. This deliberately small family tests whether one signal or a changed balance improves the established mechanism, rather than searching thousands of features again.

| Rolling score | 42-fold at 16 s | At 12 s | At 10 s | At Finish | New seven at 12 s / Finish |
|---|---:|---:|---:|---:|---:|
| Equal yaw + jolt (retained) | 25 | 33 | 36 | 37 | 7 / 7 |
| Yaw alone | 23 | 30 | 35 | 35 | 6 / 7 |
| Jolt alone | 29 | 33 | 35 | 36 | 7 / 7 |
| 75% yaw, 25% jolt | 24 | 33 | 37 | 36 | 6 / 7 |
| 25% yaw, 75% jolt | 29 | 32 | 35 | 37 | 7 / 7 |

Counts in the middle columns are out of 42. No alternative improves both the useful final reading and the approach checkpoints. Increasing jolt weight improves the 16-second development result but loses later calls and increases post-firm changes. This is insufficient evidence to replace the independently tested equal weighting. The existing gravity projection and acceleration magnitude remain invariant to how the phone's coordinate axes are rotated; moving the phone relative to the train is still a real disturbance and is not removed by that mathematical invariance.

## Confidence: what changed, including the tradeoff

The old engine treated the average of its two standardised feature scores as probability log-odds. That can be confidently wrong on the shared curve before the branch: 30 seconds before Finish, 9 of its 12 readings at 80% or above were wrong.

v6 fits a nonnegative logistic temperature separately for held/early readings, later moving approaches, and braking-held calls. Each training journey receives equal total weight within a state, so long waits do not create dozens of independent training examples. Ridge strength is 1, with a single coefficient per state; no free intercept changes the selected direction. The existing 63-moving-second rule defines the later approach; wall-clock waits do not promote it. A negative/unsupported relationship reduces confidence towards 50%, without reversing the raw direction decision.

Confidence is additionally limited to 55% for early/held readings, 75% for moving approach readings, and 95% for firm readings. These are conservative presentation policies, not precision inferred from the small dataset. The app rounds percentages to five-point steps. A fresh installation or insufficient calibration reports 50% rather than inventing a trained probability. `prediction` is the selected direction even when the rounded probability is 50%.

| 42-fold confidence measure | Previous | v6 |
|---|---:|---:|
| Brier score at Finish (lower is better; 0.25 is an even guess) | 0.126 | 0.091 |
| Five-bin calibration error at Finish | 0.159 | 0.050 |
| Wrong calls among readings ≥80%, at Finish | 1/9 | 1/28 |
| Wrong calls among readings ≥80%, 30 s before Finish | 9/12 | 0/1 |
| Brier score at 12 s before Finish | 0.162 | 0.174 |
| Brier score at 10 s before Finish | 0.125 | 0.138 |
| Whole-live-reading Brier, equal weight per journey | 0.253 | 0.184 |

Confidence improves across the recording and at the final live call, but becomes somewhat **underconfident** in the useful seconds just before the braking hold. This is an explicit tradeoff: it reduces premature confident guesses at the cost of understating some correct late provisional readings. At eight seconds there is still one wrong v6 ≥80% call among 13 such readings, against zero among ten previously. No number here establishes a guarantee. Calibration bins, especially high-confidence subsets, are small.

The table uses unrounded model probabilities. Re-evaluating the exact five-percentage-point values shown by the UI gives a final 42-fold Brier score of **0.0901**, calibration error **0.0488**, and **1/29** high-confidence calls wrong. The journey-weighted whole-live Brier score is **0.1837**. On the chronological seven, the rounded final Brier score is **0.0214**, calibration error **0.1286**, and **0/6** high-confidence calls wrong; the whole-live Brier score is **0.1451**. Rounding therefore preserves the measured improvement, without suggesting single-percentage-point precision.

Across all displayed one-second ticks, old/new high-confidence wrong ticks are 348/640 and 19/296; these repeated ticks are **not independent observations** and are not used to claim a statistical sample size. On the seven-journey chronological holdout, the final Brier score changes from 0.062 to 0.020; early underconfidence remains visible in the machine-readable results.

## New compass evidence

All seven new recordings include compass readings after startup: 46,104 samples. The reported median heading accuracy is 55–89 degrees, and **none** reports accuracy within 20 degrees. Their whole-journey heading changes are similar, approximately −103 to −109 degrees for both routes. This supports a repeatable common movement profile, not surveyed geographical bearings.

A 16-second heading-change feature on the final approach is promising: at Finish−10 s, the two left trips change by −4.10 and −5.13 degrees, while the five right trips change by +1.01 to +4.15 degrees. A threshold fitted with each of the seven trips left out gets 7/7 at the 16-, 12-, and 10-second checkpoints. However, there are only **two left trips**, all older trips lack compass, and phone tilt changes by 2.7–7.2 degrees over the same window. Compass error and phone movement are material uncertainties; relative heading change may be better than absolute heading, but its reliability is not established by the reported absolute accuracy.

This feature is recorded in the reproducible exploratory analysis and is deliberately **not deployed as an early override**. It needs future compass-equipped journeys, including more left trips and varied phone poses, scored with its present window and sign fixed in advance. Claiming a newly validated early predictor from these same seven would be misleading.

## Failure behaviour and reproducibility

Missing/nonfinite acceleration, gravity, or rotation data clear the reading. A sample gap above two seconds breaks the hold and clears the reading until a complete 16-second clean window returns. A gap is not interpreted as a stationary train. Training rejects missing-sensor or interrupted feature windows. A truly stationary, smooth train and a smooth moving train can still be difficult to distinguish; vibration is supporting evidence, not measured speed.

A synthetic constant vertical gyro bias of 0.1 degrees/second shifts the 16-second yaw feature by about 1.6 degrees, rather than accumulating throughout the journey. That is bounded drift, **not correction**: it can still change a borderline branch call. Injecting one second of phone turning at 15 degrees/second changes the feature by over ten degrees. Coordinate invariance does not cancel actual phone movement, which remains a reason for the hands-free recording protocol. Replay now clears both `waiting` and `cleared` states, exactly matching the UI; it cannot keep a stale call when the live interface has withdrawn it.

`fork-engine-baseline.js` preserves the previous engine unchanged. `analyze-development.mjs` compares it with the shipped engine, deduplicates overlapping exports by raw-sample hash, measures compass coverage, and writes `docs/development-metrics.json`. The report contains aggregate/feature summaries, never raw recordings, tokens, or credentials. `analyze-loocv.mjs` accepts multiple exports and prints chronological or journey-held-out live replay results.

Commands executed during this development:

```text
node analyze-development.mjs victoria-training-2026-09-27-19L16R.json victoria-training-2026-10-30-21L21R.json
node analyze-loocv.mjs victoria-training-2026-09-27-19L16R.json victoria-training-2026-10-30-21L21R.json --train-before 2026-09-28
node --test tests/algorithm.test.mjs
```

The ten automated algorithm tests cover coordinate rotation invariance, causal prefix equality, missing sensors, interrupted windows, duplicate timestamps, untrained confidence, bounded constant-bias effects, actual phone-turn disturbances, replay clearing, and cumulative-export deduplication/conflicting labels. Position reconstruction and stop-injection results are documented separately by the track-reference study; this predictor alone does not measure metres, speed, or the actual points-crossing instant.
