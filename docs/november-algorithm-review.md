# November recording impact and algorithm review — 8 November 2026

The new export adds **four journeys, two left and two right**, to the October 42. The established predictor gets **three of these four right** with October-only calibration. Its final development score becomes **40/46 (87.0%)**, compared with 37/42 (88.1%) in October. The reliability fixes in engine v7 preserve those direction results; they do not turn the new miss into a success or establish an earlier prediction.

## What changed in the dataset

All 42 October recordings remain present with identical raw samples. Across the September, October and November cumulative exports there are 46 distinct recordings and 77 repeated copies, not 123 independent journeys. Raw exports were read without rewriting them and remain excluded from public assets.

| New journey | Recording date | Actual platform | Duration | Last live answer with October calibration |
|---|---|---|---:|---|
| example-43 | 4 November | Left | 186.05 s | Left, 80% after UI rounding |
| example-44 | 5 November | Left | 104.316 s | **Right, 60% — wrong** |
| example-45 | 6 November | Right | 92.917 s | Right, 95% |
| example-46 | 7 November | Right | 131.217 s | Right, 95% |

The 186-second journey is longer than any of the previous 42 and includes a long wait. Its final call recovers correctly after movement resumes. The new recordings have no sample gap above 42 ms; three have repeated/backward timestamps (14, 1 and 5 respectively). Heading is present on all but the first sample of each. Median reported heading accuracy is 88.2–89 degrees; example-43 also has 771 samples reporting accuracy within 20 degrees, so it would be incorrect to claim that every new compass sample is poor.

The study first replayed the unchanged v6 code and froze the training membership to the October export. It then repeated the analysis after the correctness fixes. **Every reported direction count below is unchanged by those fixes.** Small probability changes arise from consistent handling of duplicate timestamps. October confidence fitting is frozen before evaluating the four November journeys; the 46-fold results refit on the other 45 and remain development estimates, not a new independent test of earlier feature selection.

## Accuracy and timing

| Evaluation | Finish−16 s | Finish−12 s | Finish−10 s | Finish−8 s | Last live answer |
|---|---:|---:|---:|---:|---:|
| October report, 42-fold development | 25/42 | 33/42 | 36/42 | 37/42 | 37/42 |
| November, 46-fold development | 25/46 | 36/46 | 39/46 | 40/46 | **40/46** |
| New four, October-only fit | **0/4** | 3/4 | 3/4 | 3/4 | **3/4** |

Nothing on screen counts as wrong. At Finish−16 s, two new journeys are blank and two point to the wrong side. Final accuracy on four journeys has considerable uncertainty: one additional success or failure moves it by 25 percentage points. Finish-relative checkpoints are retrospective scoring anchors; they are not independently measured junction-crossing or platform-visibility times. Finish still preserves the answer already on screen and computes no replacement verdict.

The median first firm call over all 46 is 8.318 seconds before Finish. There are two changes of direction after the first firm call across 46 journeys, and none on the four new journeys. Early live readings still change direction: 69 changes across all 46, including five across the new four. Stability after the hold is not a guarantee that the held direction is correct.

The November 5 miss has conflicting evidence at its final held instant. Its gravity-projected turn contributes **+0.841** standardised units towards left; acceleration-magnitude skew contributes **−1.186** towards right. Equal weighting gives −0.172, hence the wrong right prediction at about 59% before rounding. This is a weak disagreement between signals, rather than a missing sensor, failed hold, duplicate-counting artefact, or post-Finish update. Relabelling the journey or forcing the turn signal to win would disguise the actual error.

## Alternatives and confidence

The same small family evaluated in October was rerun, without a fresh feature/window search.

| Score weighting | 46-fold at 12 s | 46-fold at 10 s | 46-fold final | New four final |
|---|---:|---:|---:|---:|
| Equal yaw and jolt, retained | 36 | 39 | **40** | 3 |
| Yaw alone | 34 | 38 | 39 | 4 |
| Jolt alone | 35 | 38 | 39 | 3 |
| 75% yaw / 25% jolt | 37 | 41 | 39 | 4 |
| 25% yaw / 75% jolt | 35 | 38 | 41 | 3 |

Counts in the middle columns are out of 46; the last is out of four. More yaw fixes the November miss but loses overall final accuracy. More jolt gains one development final answer but loses approach accuracy and increases post-firm changes from two to three. Neither establishes a stronger replacement. The equal weighting, calibrated confidence method and hold thresholds remain unchanged.

For the 46-fold final live answer, the calibrated v7 confidence has Brier score **0.0905**, against **0.1248** for the preserved pre-confidence baseline; lower is better. The actual five-point-rounded UI values score **0.0886**. Across each journey's live readings, giving each journey equal weight, the score is **0.1859**, against **0.2443** for the baseline. There is one wrong final answer among 31 unrounded readings at 80% or more; after rounding there is one among 34. These are small subsets, not guarantees. Late moving readings remain somewhat underconfident; no extra tuning on the four new labels was introduced.

## Compass: a useful test, still exploratory

The previous report specified a 16-second trailing heading-change feature. Fitting its direction/threshold only on October's seven compass journeys (two left, five right) gives **3/4 at Finish−16 s and 4/4 at Finish−12 s and −10 s** on the four new journeys. This is more informative than fitting again on all eleven and grading them on that same fit.

The heading changes at Finish−10 s are −6.06 and −7.05 degrees for the new left journeys, and +3.07 and −0.03 for the right journeys. The frozen October threshold is −0.7875 degrees, with more negative changes indicating left. However, the same checkpoint-specific exercise gets only 3/4 eight seconds before Finish and 1/4 at Finish itself; the useful feature still needs a trustworthy live timing rule. Absolute heading accuracy and phone movement remain concerns, and four journeys cannot establish robustness. **No compass override was added.**

## Verified defects corrected

1. **Interrupted evidence could become a later firm call.** During the 16-second recovery period, the hold state could latch onto a window containing missing data, then reveal that old reading when the recovery timer elapsed. The engine now waits for clean evidence before starting a new hold and validates the held window itself. A quiet resumed recording is covered by a focused regression test.
2. **Invalid stale events could rewind the sensor clock.** Sensor validation ran before rejecting old timestamps. A malformed duplicate could reset the last-seen time and invalidate newer evidence. Timestamp rejection now happens first.
3. **Feature calculations contradicted streaming timestamp handling.** Streaming ignored duplicate/backward events, but yaw integration and skew still consumed them. They now ignore them consistently. Artificially inserted extreme duplicates leave both features unchanged.
4. **Incomplete training/read windows were accepted.** A recording with 600 samples could still lack the required 16-second trailing window. Calibration and direct readings now require real coverage and valid sensors; missing data is not a zero-motion example. Empty replay/timeline inputs return no answer.
5. **Invalid chronological dates silently changed the experiment.** A malformed `--train-before` became `NaN`, causing the analyser to run leave-one-out instead of the requested chronological test. It now rejects malformed/impossible dates and refuses a split without enough usable training journeys per side.
6. **Development analysis assumed compass data existed.** Missing approach heading could crash the gravity-angle calculation, and missing heading accuracy could count as accurate through JavaScript coercion. Both are checked explicitly. Unshown probability scores are reported as unavailable, and exact unseen journeys can be selected by membership in the earlier export.
7. **Legacy model APIs could corrupt validated examples.** Extra metadata could replace the validated label/features in both classifiers. Logistic fitting/ranking could also propagate nonfinite or nonnumeric feature values through every probability. Reserved fields are now protected and missing numerical values handled consistently. These models remain legacy compatibility code, not a replacement live predictor; feature version 6 is unchanged.
8. **Malformed private exports could crash later analysis.** Null/scalar examples, non-array raw data, malformed sample entries and nonfinite sample times now produce explicit import errors before hashing/replay. Usable journeys also require a real recording date. Missing sensor axes remain permissible so that the quality checks, rather than invented values, determine whether a prediction is possible.

## Reproduction and checks

The aggregate output is [november-development-metrics.json](november-development-metrics.json). It contains per-journey feature summaries and aggregate scores, not raw recordings. The earlier [October study](algorithm-results.md) remains available for context.

```text
node analyze-development.mjs victoria-training-2026-09-27-19L16R.json victoria-training-2026-10-30-21L21R.json victoria-training-2026-11-08-23L23R.json --holdout-from victoria-training-2026-10-30-21L21R.json --out docs/november-development-metrics.json
node --test tests/algorithm.test.mjs tests/analysis-tools.test.mjs tests/legacy-classifiers.test.mjs
```

All **21 targeted checks pass**: 17 live-engine/data tests, two analysis-tool tests and two legacy-classifier tests. Synthetic tests exercise missing data, duplicates and short windows independently of the private recordings; the real-data replay verifies that the correctness changes preserve the measured branch results. All three original exports also pass the stricter loader unchanged: 46 distinct journeys, 23 left/23 right, with 77 repeated copies removed. Full application, storage, track-view, offline-update and backend checks are reported by the project-wide review. A physical iPhone journey remains necessary to validate real sensor permission, browser suspension and the operating system's OneDrive destination screen.
