# What the track reference means

The recordings support a repeatable **relative movement profile**, not a
geographic reconstruction. `track-reference.js` contains robust aggregates of
46 unique journeys (23 left / 23 right), pooled across routes and separately for left/right. Its
61 positions run from the beginning to the end of each journey's detected
moving observations. A displayed 60% means approximately 60% through this
historical motion profile. It does **not** mean 60% of the track's metres.

There are no GPS fixes, surveyed rail coordinates, labelled junction-crossing
times, measured initial velocities, or independent position observations in
these exports. Accordingly, the model does not assign the junction a position,
reconstruct tunnel radii, report metres, estimate a physical speed, or certify
that a particular profile peak is the points. The `common` array is the pooled
profile, not proof that all of that physical track is shared. The two branch
arrays describe whole-journey signatures; their names do not locate the fork.
Any drawn track shape and split location must be labelled illustrative.

## Method and alternatives

`MotionFrames` applies the same causal extraction in reference construction and
live operation. It forms one-second observations: median gravity-projected yaw
rate, vibration relative to a causal cruise estimate, and vertical vibration
fraction. iOS already supplies acceleration excluding gravity; the supplied
gravity vector gives the world-vertical projection. Strong handling motion,
missing accelerometer fields, sparsely populated seconds and large gaps are
rejected. A usable second must span at least 750 ms, with no observed gap over
250 ms; a short burst is not a full second of movement. Handling samples count
once in the quality fraction. Null gyroscope/gravity components omit those
channels rather than becoming measured zeroes. This is coarse
rejection: slow phone rotation remains inseparable from train turning.

A cruise reservoir excludes very quiet observations, so a long dwell cannot
lower the movement threshold. Moving observations exceed both an absolute
floor and 60% of the cruise vibration. This measures motion evidence, not
wheel speed: sufficiently smooth crawling may be treated as paused. Reference
positions contain channel medians and median absolute deviations, with noise
floors rather than an assumption that each narrow curve is exactly repeatable.

We compared a movement clock, unconstrained nearest-signature matching and a
small monotone forward sequence filter. The latter is similar to constrained
dynamic time warping, but maintains a probability distribution over possible
positions rather than choosing one complete path. It advances 0–2 reference
cells per moving observation; robust sensor likelihoods make small corrections
to a broad historical moving-time prior. It keeps **two independent route
hypotheses** and never forces one away using the direction predictor. The
pooled position is their mean, with an interval enclosing both hypotheses.

No transition and no sensor likelihood is applied during detected pauses.
Recording time alone never advances the estimate. Missing observations widen
uncertainty. An interval floor of ±15 percentage points and empirical journey
duration spread prevent a sharply peaked fit from suggesting surveyed accuracy.
These are conservative model intervals, **not calibrated 90% geographic
confidence intervals**. The marker never claims 100% arrival based on sensors.
The model uses neither the live journey's future nor its Finish tap.

Unconstrained matching was rejected because similar vibration/turn signatures
appear at many positions. Uncorrected acceleration integration was also
rejected: an explicitly naive phone-plane integration gives signed displacements
from −2,099 to +2,120 m and ending velocities from −34.8 to +33.4 m/s despite
these journeys ending at a halt. This is a failure diagnostic, not a set of
track measurements. Fixing a bias or assuming an initial speed cannot restore
the missing ground truth; a fixed phone heading is also not available.

## Validation and limits

`docs/track-validation.json` records reproducible results. Historical exports
are deduplicated by full raw-content hash: September has 35 journeys; October
contains the identical 35 plus 7, and November retains those 42 and adds four,
giving 46 unique journeys. Across all three exports, 77 duplicate copies are
excluded. The same loader rejects contradictory labels in all analysis tools.

The target below is the completed journey's normalized moving-time fraction,
used **only for scoring**. It is a useful internal alignment check, but it is
defined using this movement detector. It cannot establish physical position
accuracy or validate the detector's distinction between crawling and stopping.
Errors are averaged within each held-out journey, then across journeys.

| Method, leave one journey out | Mean absolute error against motion-fraction proxy |
| --- | ---: |
| Movement clock | 4.08 percentage points |
| Unconstrained nearest signature | 23.48 points |
| Forward filter, no sensor likelihood | 4.29 points |
| Forward filter, weak likelihood (shipped) | 3.96 points |
| Forward filter, stronger likelihood | 4.00 points |

The improvement over the simple clock is small. Do not describe this as a
substantially more accurate geographic locator. Broad displayed intervals cover
99.85% of this proxy, with a mean width of 32.1 points. That reflects deliberate
uncertainty, rather than proof of excellent physical calibration.

Building the reference on September's 35 and evaluating the 11 later journeys
gives 3.47 points for matching versus 3.98 for the clock. Keeping the October
42-journey reference separate from November's four gives 4.49 versus 4.51 points
with corrected observation handling. The completely unchanged October code and
bundled reference gave 4.54 versus 4.55 points on those four. The matching benefit
is small in every comparison. Sensor-quality corrections were developed during
this review, so the corrected results are reference holdouts, not an untouched
prospective test of those corrections.

Inserting 30 seconds of quiet raw sensor samples into every journey produces
zero progress drift after a two-second settling allowance. One partial second
can still contain prior motion: maximum initial advance is 1.44 points. The
largest eventual difference after resuming is 1.13 points. Tests that insert
already-classified stationary frames give exactly zero advance, including
multiple stops. An elapsed-time clock would incorrectly advance up to 37 points
over the same wait. Natural replay's largest one-second advance is 1.73 points;
no backward corrections occurred. These simulations test behaviour, not whether
all real signal stops have been correctly identified.

The reference is intentionally **not used to strengthen branch confidence or
declare the junction crossed**. No independent junction or position labels
exist to validate that feedback, and it could reinforce a wrong branch guess.

An additional speed-aware inertial shape reconstruction experiment, including
per-trip traces and branch medians, is documented in
[track-shape-reconstruction.md](track-shape-reconstruction.md). Its distance
scale failed the station-endpoint check, so it is not the live position model.

## External geometry investigated

TfL's [official API documentation](https://tfl.gov.uk/info-for/open-data-users/api-documentation)
offers geocoded station locations. On 30 October 2026 we also checked its
[Victoria route sequence](https://api.tfl.gov.uk/Line/victoria/Route/Sequence/inbound?serviceTypes=Regular&excludeCrowding=true):
the returned polyline has 16 points, all exactly station coordinates, including
Stockwell and Brixton. It gives no intermediate points between those stations
and no surveyed platform crossover geometry. Connecting those points would
invent a straight tunnel, so this geometry is not used. No verified, suitably
licensed tunnel/crossover geometry was obtained in this development cycle.

## Rebuilding and using it

The following scripts are run by the developer, not required on the phone:

```
node tools/analyze-track.mjs victoria-training-2026-09-27-19L16R.json victoria-training-2026-10-30-21L21R.json victoria-training-2026-11-08-23L23R.json --build
node tools/check-tfl-reference.mjs
node --test tests/track-position.test.mjs
```

The build writes aggregates to `track-reference.js` and validation statistics to
`docs/track-validation.json`. Private raw exports remain untouched and ignored
by Git. Do not replace the preserved raw exports with processed profiles.

Browser use is `new TrackPosition(reference)` followed by `update(rawSample)`.
`buildTrackReference(examples)` can generate an updated reference from local
labelled recordings, off the sensor hot path. The generated reference is small
and requires no network, rendering library or server. Motion capture, position
matching, branch prediction and drawing stay separate.
