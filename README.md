# BrixtonVibes

A hands-free Victoria line platform forecast for Stockwell → Brixton. The app
runs as a static site on GitHub Pages, including offline recording. The **Save to OneDrive** button uses the iPhone system sheet and existing
OneDrive account, with no new signup, server, card details, or running laptop.

## October development results

The October export contains **42 unique journeys, 21 left / 21 right**:
September's 35 plus seven new journeys. Original recordings remain private and
unchanged. Development used deduplicated whole-journey replay, leave-one-journey-out
validation, and chronological splits.

The previous branch rule remains strongest overall. Its final live reading is
correct on **37/42 (88.1%)** in development validation, and **7/7** new journeys
using calibration frozen on September. At 16 seconds before Finish it is only
25/42 correct; this cycle does **not** demonstrate a reliable earlier prediction.
The new confidence fitting improves final Brier score from 0.126 to 0.091
(lower is better), with some underconfidence before the braking hold.
Full comparisons, rejected alternatives, compass findings, timing and sample-size
limits are in [the prediction study](docs/algorithm-results.md).

## Recording on an iPhone

1. Open over HTTPS; enable motion sensors before boarding.
2. At Stockwell, start recording and put the phone down. Keep the app visible.
   Direction, relative progress, and status update automatically; no swiping or
   touching is needed during the journey.
3. Tap **Finish recording** at Brixton. This preserves exactly the prediction
   already on screen. Raw samples save locally **before** the label sheet.
4. Label left/right, or skip. Both choices preserve the recording. Tap **Save to
   OneDrive**, choose OneDrive in the system sheet and confirm the save. Settings
   provide older recordings, training backups, and unfinished-trip recovery.

Only the most likely platform and its probability appear. Probabilities use
five-point steps rather than decimal precision. Early values are explicitly
tentative. New installations show 50% until sufficient real labelled journeys
are restored or collected; the bundled position reference is separate. Missing sensors or interrupted data suppress a route reading rather
than invoking the retired classifier. Phone movement remains contamination;
mathematical orientation invariance cannot remove actual handling.

The app keeps a recovery draft every five seconds and at visibility changes.
The former six-minute raw-buffer truncation has been removed. A crash can lose
samples since the last successful draft. Failed local saves are visible and
offer retry/download after Finish; starting another trip cannot overwrite an
unsaved recording. Browser storage can still be evicted, so retain external backups.

Keep the screen visible: iOS may suspend sensors when the app is hidden or the
phone locks. Screen Wake Lock is requested where supported; it is optional.
The target is current iOS Safari / home-screen mode (iOS 16.4+ recommended).
Desktop Edge checks do not replace a physical iPhone test.

## What the track view means

The perspective SVG is lightweight and has no interactive camera. Its marker
uses incoming sensor data matched to an aggregate historical movement profile;
it is not an elapsed-time animation. Pauses hold progress, and both route
hypotheses remain possible until a branch prediction firms up.

**Progress is a relative movement fraction, not distance.** Broad intervals
reflect uncertain alignment. The drawing's curves, scale, and split position are
illustrative: neither these recordings nor the checked TfL API provide surveyed
crossover geometry or independent junction times. No kilometres, speed, tunnel
radii, or geographical coordinates are invented.

Matching modestly improves error against an internal movement-progress proxy
(4.25 versus 4.36 percentage points), which cannot establish real physical
position accuracy. Inserted 30-second stops produce no drift after settling,
with small boundary effects. [Track methods and results](docs/track-reference.md)
explain reconstruction limits and alternatives.

## OneDrive without new accounts, cards, or a laptop

[Save to OneDrive instructions and limits](docs/onedrive-button.md) describe the
current implementation. A prepared real recording file is handed directly to
OneDrive through iOS's system share/save screen. It does not require downloading
and moving files manually, an Azure directory, Cloudflare hosting, a subscription,
or keeping this laptop on. It works on the existing public GitHub Pages app.

**The system sheet still requires destination selection and save confirmation.**
This is button-driven saving, not silent automatic upload. The browser cannot
force OneDrive as the destination or confirm that its upload completed. It says
Handed to the system and retains the local copy after success, cancellation or
failure. The OneDrive app / Files provider must be installed and signed in.

The journal runs in native-only mode and makes no backend/auth requests. No
Microsoft access token, refresh token, client secret or drive write permission
enters the website. Each visitor only sees their own phone's destinations.

The earlier optional Cloudflare/Microsoft backend remains as reference code,
but is not deployed or being set up. This personal Microsoft account lacks a
registration directory; Microsoft's card-verification requirement conflicts
with the user's explicit constraints. No Azure signup or laptop relay was created.
Actual iOS/OneDrive delivery still needs a physical phone test.

## Code boundaries

| File | Responsibility |
| --- | --- |
| `fork-engine.js` | Causal branch decision, hold/re-arm state, calibrated confidence, sensor quality |
| `fork-engine-baseline.js` | Unchanged pre-development comparison |
| `track-position.js` | Causal movement frames, relative matching, two position hypotheses |
| `track-reference.js` | Generated robust aggregate; no raw journeys |
| `track-view.js` | Illustrative perspective SVG, markers and uncertainty |
| `onedrive-sync.js` | Durable recording journal; native-only mode makes no backend calls |
| `native-save.js` | Prepared file handoff to the iPhone system sheet |
| `onedrive-worker/` | Optional, inactive backend reference; no deployment required |
| `app.js` | Sensor capture, app lifecycle and interface orchestration |
| `training-set.js`, `raw-store.js` | Existing labelled dataset storage, import/export |
| `features.js`, `classifier.js` | Legacy feature compatibility; classifier is not a live fallback |

Existing storage names `victoria-line-training-set` and `motion-lab-raw` remain
unchanged. The independent journal uses `brixtonvibes-recording-outbox`.
Bump `CACHE_VERSION` in `sw.js` whenever app assets change. API and authentication
responses bypass the service worker; shell modules stay within one cache version.

## Reproducing checks

Development dependencies are locked; the root workspace includes the small
backend package. The following were executed here (they are developer references,
not steps required to use the app):

```text
npm install
npm test
npm run test:browser
node analyze-development.mjs victoria-training-2026-09-27-19L16R.json victoria-training-2026-10-30-21L21R.json
node tools/analyze-track.mjs victoria-training-2026-09-27-19L16R.json victoria-training-2026-10-30-21L21R.json --build
node onedrive-worker/build-assets.mjs
```

The Node tests cover inference causality, phone-axis rotation, missing sensors,
gaps, stops/restarts, deduplication, durable saving, network/session failures,
owner restrictions, CSRF, encryption, signed-token validation and upload revisions.
The browser check replays a real journey through the app, inspects five mobile
viewports, tests reload recovery and offline startup, and writes screenshots to
ignored `test-results/`. Private raw files are necessary for the replay/analysis,
but not the small synthetic unit tests. The cloud static builder copies an
explicit allowlist and excludes raw exports and server configuration.
