# Development verification — 30 October 2026

The current app uses native iPhone file sharing on the existing GitHub Pages
site. No Azure subscription, Cloudflare app/database, or laptop relay is needed
or has been created. The earlier backend dry-run is an inactive optional design.

| Check | Result |
| --- | --- |
| Automated algorithm, position, journal, native save and security tests | 40 passed, none failed |
| Edge application replay and failure checks | 27 passed, none failed |
| Real IndexedDB migration and interrupted transaction | Passed; legacy samples preserved, no partial write |
| iPhone-sized viewports | 320×568, 375×667, 390×664, 390×844, 430×932 |
| Visual inspection | Screenshots inspected and refined; Finish/save status remain visible during capture |
| Cloudflare Worker dry-run | Passed with Wrangler 4.156.0; server bundle 48.82 KiB, 13.55 KiB compressed |
| Optional cloud static asset boundary | Explicit allowlist; no private recording exports copied |
| Source formatting/whitespace check | Passed |

The browser test replays a real October journey into the same causal update
function used by live capture, with one-second updates. It accelerates delivery;
it does not claim to exercise real iPhone hardware. Separate synthetic
DeviceMotionEvents test absent sensor fields. Checks include exactly one route
probability, position uncertainty, no invented junction location, settings hidden
while recording, unchanged direction/probability at Finish, saving before labels,
Skip/reload recovery, unfinished draft recovery, storage failures, overwrite
prevention, successful save retry and offline app startup.

Native-save checks exercise real file contents and a real browser click, with
only the OS share destination mocked. They confirm the share call happens while
the user gesture is active, the full raw JSON is attached, cancellation allows
retry, the local copy survives, no cloud success is claimed, and a saved file
is prepared again after reload. A native-only test confirms there are zero
backend/authentication requests.

The journal browser test migrates a real IndexedDB v1 fixture with 22,000 samples
to v2, confirms compact metadata, and aborts the second store write deliberately:
neither the raw row nor metadata commits partially. A separate 42-journey archive
test verifies periodic saving does not reread historical raw samples.

Both comparative analysis scripts were rerun against the September and October
exports after implementation. Details and honest limits live in
[the prediction study](algorithm-results.md) and [track study](track-reference.md).
Original exports were not rewritten. The prior engine remains available in
`fork-engine-baseline.js` for future comparison.

Still unverified: physical iOS Safari/home-screen sensor recording and actual
OneDrive share-target delivery. The [current OneDrive button guide](onedrive-button.md)
documents this distinction. Desktop tests do not establish those external
outcomes. The earlier Microsoft/Cloudflare backend remains inactive; its account
setup is superseded by the user's no-signup/no-card/no-laptop constraints.
