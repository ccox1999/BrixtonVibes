# Development verification — 8 November 2026

The current app uses native iPhone file sharing on the existing GitHub Pages
site. No Azure subscription, Cloudflare app/database, or laptop relay is needed
or has been created. The earlier backend dry-run is an inactive optional design.

| Check | Result |
| --- | --- |
| Automated algorithm, position, import, journal, native save, build and security tests | 82 passed, none failed |
| Edge application replay and failure checks | 39 passed, none failed |
| Real v38 → v43 offline installation migration | 19 passed, none failed |
| Real IndexedDB migration and interrupted transaction | Passed; legacy samples preserved, no partial write |
| iPhone-sized viewports | 320×568, 375×667, 390×664, 390×844, 430×932 |
| Visual inspection | Screenshots inspected and refined; Finish/save status remain visible during capture |
| Optional Cloudflare Worker dry-run | Historical October check only; not rerun or deployed in this review |
| Optional cloud static asset boundary | Explicit allowlist; no private recording exports copied |
| Source formatting/whitespace check | Passed |
| Source syntax checks | 29 app, backend and tool files passed |
| Dependency advisory audit | Zero known vulnerabilities |

The browser test replays a real November journey into the same causal update
function used by live capture, with one-second updates. It accelerates delivery;
it does not claim to exercise real iPhone hardware. Separate synthetic
DeviceMotionEvents test absent sensor fields. Checks include exactly one route
probability, position uncertainty, no invented junction location, settings hidden
while recording, unchanged direction/probability at Finish, saving before labels,
Skip/reload recovery, unfinished draft recovery, storage failures, overwrite
prevention, successful save retry and offline app startup.

The expanded checks cover stale compass expiry, an unanswered optional compass
permission, keyboard focus/Escape in the label sheet, preserved emergency
downloads when local storage fails, deferred calibration after Finish, late
wake-lock release and preventing approximate progress from rounding to 100%.
The full sequence is available as `npm run verify`; failure stops later stages.

Native-save checks exercise real file contents and a real browser click, with
only the OS share destination mocked. They confirm the share call happens while
the user gesture is active, the full raw JSON is attached, cancellation allows
retry, the local copy survives, no cloud success is claimed, and a saved file
is prepared again after reload. A native-only test confirms there are zero
backend/authentication requests.

`tools/test-update.mjs` installs the actual old v38 code in an isolated browser
profile before serving the current release. It verifies that migration through
the dedicated update page reaches the real track SVG, labels and raw samples
survive, active old/current recordings keep running across worker changes, idle
updates reload safely, an explicitly applied post-Finish update preserves the
completed recording, and offline startup remains functional. This tests the
previously missed old-installation path, rather than only fresh browsers.

The journal browser test migrates a real IndexedDB v1 fixture with 22,000 samples
to v2, confirms compact metadata, and aborts the second store write deliberately:
neither the raw row nor metadata commits partially. A separate 42-journey archive
test verifies periodic saving does not reread historical raw samples.

Prediction, relative-track and experimental shape analyses were rerun against
the September, October and November exports. Details and honest limits live in
[the November prediction study](november-algorithm-review.md),
[project review](november-review.md) and [track study](track-reference.md).
Original exports were not rewritten. The prior engine remains available in
`fork-engine-baseline.js` for future comparison.

Still unverified: physical iOS Safari/home-screen sensor recording and actual
OneDrive share-target delivery. The [current OneDrive button guide](onedrive-button.md)
documents this distinction. Desktop tests do not establish those external
outcomes. The earlier Microsoft/Cloudflare backend remains inactive; its account
setup is superseded by the user's no-signup/no-card/no-laptop constraints.
