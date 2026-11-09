# Project review — 8 November 2026

The November export adds four real journeys. The established predictor gets
three right with calibration frozen on October. The review fixes verified
correctness, storage and interface problems; it does not establish a better
early prediction. The changes make up app release **43**, prediction
engine **7**, with feature compatibility version **6** retained.

## Recording impact

| Check | Result |
| --- | --- |
| Distinct journeys | 46: 23 left / 23 right |
| Newly recorded journeys | Four: two per platform; 4–7 November |
| Prior October recordings | All 42 retained with identical raw samples |
| Duplicate copies across the three cumulative exports | 77 excluded |
| New four, October calibration frozen | 3/4 at Finish; the 5 November left trip is wrong |
| All 46, each journey omitted from its own calibration | 40/46 (87.0%) at Finish; 36/46 at 12 s; 25/46 at 16 s |
| New four at 16 s before Finish | 0/4: two blank, two wrong |

The unchanged engine was evaluated first, then the corrected engine. Reported
direction counts are unchanged. The new miss has turn evidence pointing left
and stronger jolt evidence pointing right. Weight changes that fix it lose
accuracy elsewhere, so the established decision rule remains in place.
Confidence fitting and hold thresholds were not retuned on these four labels.

The four new journeys all record compass readings, but their median reported
accuracy is approximately ±89 degrees. The October-only compass threshold does
get 4/4 at retrospective 12- and 10-second checkpoints, then deteriorates closer
to Finish. That is a useful research result, with no validated live trigger and
only four new journeys. Compass therefore remains recorded evidence, without a
prediction override. [Full prediction findings and metrics](november-algorithm-review.md).

## Correctness and reliability fixes

| Area | Verified problem | Resulting behaviour |
| --- | --- | --- |
| Prediction after interruption | Braking could latch a contaminated window during recovery, revealing it later | New holds wait for clean evidence; the actual held window is checked |
| Sensor timestamps | Stale malformed events could rewind the clock; features counted timestamps rejected by streaming | Old events are ignored consistently; duplicate extremes do not change features |
| Calibration/read coverage | Short recordings and incomplete trailing windows could look usable | Incomplete evidence produces no calibrated reading |
| Relative position | Missing gravity became zero; rejected handling samples counted twice; short bursts looked like full seconds | Explicit component checks, correct quality fraction and time coverage |
| Experimental shape | Missing whole seconds compressed the frame list and shifted later stop assumptions | Real bucket timestamps place stop assumptions at the observed times |
| Recording journal | Concurrent patches could overwrite each other's changes | The read and write both serialize, preserving both edits and revision order |
| Browser databases | Closed/failed openings could be cached indefinitely; blocked opening could hang | Connections are invalidated and failed openings can retry; late connections close |
| Deletion | Raw samples were removed before label removal was safely saved | Metadata removal must succeed before raw samples can be deleted |
| Import/restore | Damaged rows and colliding IDs could break history; repeated imports could replace healthy raw | Malformed/conflicting imports are checked; raw repair requires confirmed absence |
| Storage full | A labels-only fallback could appear to be a complete raw save | Incomplete preservation reports failure and retains raw in memory for rescue |
| Startup/calibration | Another caller could see half-loaded history; late calibration could change an active journey | Initialization is shared and active journeys keep one calibration; deferred fitting runs after Finish |
| Compass/permissions | Stalled orientation values repeated as fresh; optional unanswered permission could block motion | Stale readings expire; granted motion can proceed independently |
| Screen wake lock | A late grant could keep the screen awake after Finish | Late grants are released |
| Legacy models | Metadata could overwrite validated labels/features; nonnumeric values poisoned fitting | Reserved fields are protected and finite-number handling is consistent |

The experimental reconstruction defect was independently reproduced: adding
only a 30-second sensor gap while stationary changed a known 299.84 m synthetic
path to 182.05 m. The corrected timing passes the known 300 m route check and
agrees with the added-dwell version within 3 m. These are engineering tests
using known clean inputs, not proof of distance accuracy on phone recordings.

## App UI

The recording view retains one platform probability and visible Finish/save
status across the five tested phone sizes. The label sheet now has a named
dialog, contained keyboard focus and Escape-to-skip. History no longer silently
hides recordings after the first 30; loading older history cannot replace the
only rescue copy of an unsaved current journey. Emergency recovery offers a
download when the native share screen is unavailable.

Missing/failed prediction evidence clears an old answer. Finish still preserves
the exact live platform and probability, and saves raw data before requesting a
label. Displayed relative progress stops at 95% on its five-point scale, so the
internal 98% cap no longer rounds to an apparent confirmed arrival. Its broad
range remains visible, and the drawing remains explicitly illustrative.

## Track reference and research

The bundled reference now contains aggregates from 46 journeys. With each
journey excluded from its own reference, relative matching scores **3.96
percentage points** of error against an internal moving-fraction proxy, versus
**4.08** for a simple moving-time clock. The unchanged October implementation
and reference scored 4.54 versus 4.55 on the new four alone. The benefit is small,
and none of these numbers measures geographic position accuracy.

Inserted 30-second stationary waits show no drift after settling. Experimental
whole-journey shapes remain weak at choosing a platform: 24/46 for gyro plus
inferred speed, 27/46 for double-integrated acceleration. They remain outside
live prediction and position tracking. Individual derived traces remain in the
ignored local results folder. [Track method and current validation](track-reference.md),
[shape-reconstruction update](track-shape-reconstruction.md).

## Backend and publication boundary

Native-only mode rejects backend connection/disconnection calls. The inactive
optional backend now requires explicit upload acknowledgement before marking a
revision delivered, respects HTTP-date retry instructions, validates raw sample
structure, and encodes large encrypted payloads without exhausting JavaScript's
argument limit. Existing identity, owner, session, CSRF, encryption, upload
restriction and revision-race checks remain covered with simulated services.

The public asset builder cleans its verified output directory, including stale
nested files, then copies an explicit allowlist. Missing required modules fail
the build. A regression test plants fake private files and checks that none
survive. The private exports, credentials and per-journey reconstruction files
are excluded. No external accounts or additional hosting were created; app
release 43 deploys from `main` through the existing GitHub Pages site.

## Verification and limits

`npm run verify` runs unit/backend tests, the real-journey browser replay,
IndexedDB migration/atomic-write checks, old-installation updates and the public
asset build in sequence, stopping on failure. The browser test uses real local
storage and file bytes; only the operating system's share destination is mocked.
The upgrade test starts from the actual old v38 source and verifies release 43,
recording preservation and offline startup. Five viewports from 320×568 to
430×932 were checked; the smallest and normal phone screenshots were inspected.
The dependency audit reports zero known vulnerabilities.

Final check counts and remaining hardware limitations are recorded in
[verification.md](verification.md). Physical iPhone sensors, operating-system
suspension and actual delivery to OneDrive still require a real phone. The
optional backend has not been deployed or tested against a real Microsoft
account. Existing user work was retained; this review does not claim that every
possible defect has been eliminated.
