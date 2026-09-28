# BrixtonVibes

A mobile-first web app that predicts which of Brixton's two platforms a
Victoria line train is heading for, from your iPhone's motion sensors —
acceleration (m/s²) and rotation rate (°/s) — recorded on the Stockwell →
Brixton run. Built for the tube, but the recorder works anywhere your phone
does.

## Features

- Live scrolling charts of acceleration (X/Y/Z) and rotation rate (α/β/γ)
- iOS 13+ motion-permission flow with a clear visual status pill
- Live sample count, sample rate (Hz), and recording duration
- Zero-friction training loop: **record → stop → label → done**, with each
  labelled trip auto-saved (features + approach profile to localStorage,
  full raw motion to IndexedDB — raw recordings are ~3 MB each and would
  blow localStorage's ~5 MB quota)
- Live platform forecast while recording, from a physics-based fork engine
  calibrated on your own labelled trips, and a final reading when you stop
- Manual JSON backup / restore (save to OneDrive, email, or move to another
  device) as the durable safety net
- Installable PWA with offline support (works with no signal on the tube)
- Safe-area aware layout (notch / Dynamic Island / home indicator),
  landscape support, and battery-friendly sensor + render lifecycle

## Getting started

The DeviceMotion permission API **only works over HTTPS** — opening
`index.html` directly from a file will not work, and neither will plain
HTTP. The easiest free option is GitHub Pages:

1. Push this repository to GitHub.
2. Open **Settings → Pages**.
3. Under *Build and deployment*, choose **Deploy from a branch**, select
   `main` and `/ (root)`, then save.
4. After a minute, your app is live at
   `https://<username>.github.io/<repo-name>/`.
5. Open that URL in Safari on your iPhone. For the full experience, tap
   **Share → Add to Home Screen** to install it as a standalone app.

Any other HTTPS static host (Netlify, Cloudflare Pages, Vercel…) works
just as well.

### Icons

Three PNG icons ship in the repository root (replace them with any square
logo to rebrand):

- `apple-touch-icon.png` — 180×180 (home-screen icon on iOS)
- `icon-192.png` — 192×192
- `icon-512.png` — 512×512

## Using the app

1. **Enable Motion Sensors** — triggers the iOS motion-permission prompt
   (required once per site on iOS 13+).
2. **Start Recording** — charts begin scrolling; the status row shows a
   pulsing red dot, live sample count, rate, and duration. About 75 s into
   the journey a **Live Platform Forecast** card starts updating every
   second (see *Platform prediction* below).
3. **Stop Recording** — the forecast freezes on whatever it showed at that
   instant, and a labelling sheet appears: **← LEFT / RIGHT → / Skip**.
4. Pick the platform you actually arrived at. The trip's features **and**
   full raw motion are saved to localStorage automatically, an internal
   auto-backup is written, and an alert shows the new totals plus an
   estimated accuracy (once there are ≥5 of each side).
5. **Clear** — discards an unlabelled session (asks first).

Maintenance actions live under **Data & tools**: **⬇️ Backup Data** /
**⬆️ Restore Data** (JSON import/export, deduped by recording on restore) and
**🧪 Test Data** (seed 10 fake examples to exercise the flow without real
trips). Past trips are listed in the **Recordings History** panel, where each
can be deleted.

The in-memory recording buffer keeps the most recent **20,000 samples**
(~5 minutes at 60 Hz). Older samples are trimmed and the sample count
notes "(oldest trimmed)" when that happens.

## iOS permission troubleshooting

If you tap **Don't Allow** on the motion prompt, iOS **remembers the
denial** and will not ask again on a normal reload. To get re-prompted:

- Fully quit Safari (swipe it away in the app switcher) and reopen the
  page, **or**
- Clear the site's data: *Settings → Safari → Advanced → Website Data*,
  find the site, and delete it.

Also check *Settings → Safari → Motion & Orientation Access* is enabled
(on older iOS versions this global switch must be on).

If the status says "HTTPS required", you're viewing the page over plain
HTTP or from a local file — see *Getting started* above.

## Raw motion sample format

A backup file (**⬇️ Backup Data**) is a training-set JSON whose examples each
carry a `rawMotionData` array — one object per motion sample, in this shape:

```json
[
  {
    "time": 1718102400123,
    "ax": 0.0213,
    "ay": -0.0045,
    "az": 0.1872,
    "rotationAlpha": 1.25,
    "rotationBeta": -0.4,
    "rotationGamma": 0.02,
    "gx": 0.12,
    "gy": -9.78,
    "gz": 0.63
  }
]
```

- `time` — Unix epoch milliseconds
- `ax`, `ay`, `az` — acceleration **excluding gravity**, in m/s²
  (the charts display these divided by 9.81 to show *g*)
- `rotationAlpha/Beta/Gamma` — rotation rate in °/s
- `gx`, `gy`, `gz` — the OS's gravity estimate in device coordinates
  (accelerationIncludingGravity − acceleration), in m/s². Used by the
  ML features to find world-vertical regardless of phone orientation.
  Older recordings without these fields still load; the
  orientation-invariant features just read as zero for them.

Internally the app timestamps samples with the monotonic
`performance.now()` clock (immune to clock changes mid-recording) and
converts back to epoch milliseconds on export, so the file format is
unchanged from earlier versions.

## Platform prediction

The train must cross the points to reach its platform, and the points sit
upstream of the platform mouth, so the deciding evidence is recorded before
the platform is visible. `fork-engine.js` measures two things about the
approach, both **orientation-invariant** (they cannot learn how you hold
the phone):

- the **turn** — rotation rate projected onto gravity, integrated over the
  last 16 s;
- the **jolt** — how spiky the vibration is (skewness of |acceleration|)
  over the last 14 s.

Each is compared with your own labelled trips, and the two are averaged.

**Only the live call counts.** Once you tap Stop the platform is in view,
so the app never produces an answer after the fact: tapping **Stop**
freezes whatever was on screen the instant before.

- Until the final braking, the rolling reading is shown **provisional**
  (dimmed numbers, dashed outline). It is honestly near a coin-flip until
  the train has crossed the junction, ~12 s before arrival.
- When the final braking begins, the call is **frozen** and shown firm
  ("braking — this is the call"), usually 6–9 s before the train stops.
- If the train brakes to a halt before it has been moving long enough to
  be at the platform, it is almost certainly a signal wait outside
  Brixton: the call is held but not shown as firm ("could be a signal
  stop"). When the train moves off again the call is withdrawn ("moving
  again") and re-made on the final approach. This catches 17 of 20 waits
  in the recorded trips, so the call rarely changes after it firms up.

Measured on 35 real trips (each tested with settings fitted on the
others), the call frozen at Stop is right **89%** of the time, and at every
moment from 10 s before Stop onwards; once firm it changes on 2 trips in
35 (full numbers in `CLAUDE.md`).

1. Record a trip, then label it **left** or **right** on the sheet that
   appears when you stop.
2. With 3+ labelled trips of each side the engine calibrates itself from
   them (at app start, after each label, and after a restore). Until then
   it shows a rough turn-only reading.
3. After each label (from 5+ trips per side), the save alert replays every
   trip through the engine exactly as the screen showed it and reports how
   often the live call was right 12 s before arrival and when you tapped
   Stop. To re-measure on an export:

   ```bash
   node analyze-loocv.mjs victoria-training-YYYY-MM-DD-NLxR.json --trips
   ```

The older k-NN / logistic-regression classifier (`classifier.js`,
`features.js`) no longer makes the predictions you see.

The **🧪 Test Data** button seeds 10 fake examples so the flow can be
tested without real trips. They are marked "Fake" in their notes — delete
them before relying on a backup for analysis.

## Console helpers

The app runs inside an IIFE; its state is exposed for debugging under the
`motionLab` global:

```javascript
motionLab.state.trainSet?.getStats();   // counts and stats
motionLab.state.trainSet.examples[0];   // one stored example
motionLab.state.forkCal;                // the fork engine's calibration
```

## Project structure

```
index.html       App shell and markup
style.css        Mobile-first styles (safe areas, touch targets, states)
app.js           Sensor capture, chart rendering, export, prediction wiring
fork-engine.js   The platform predictor (live reading + final verdict)
features.js      Feature extraction for the fallback classifier
classifier.js    k-NN / logistic fallback, orientation-invariant features only
training-set.js  Labeled training data manager — localStorage + IndexedDB
raw-store.js     IndexedDB store for full raw recordings (quota-proof)
manifest.json    PWA install metadata
sw.js            Service worker — offline app-shell cache (optional)
analyze-loocv.mjs  Offline accuracy check of fork-engine.js (Node)
CLAUDE.md        Project history, findings and decisions
README.md        This file
```

**When you edit any file, bump `CACHE_VERSION` in `sw.js`** (e.g.
`brixtonvibes-v34` → `brixtonvibes-v35`) so returning visitors get the new
version instead of the cached one. If you'd rather not deal with
caching at all, simply delete `sw.js` — the app detects its absence
and runs normally, just without offline support.

## Browser support

- iOS / iPadOS 14+ Safari (primary target, including home-screen
  standalone mode)
- Current Chrome, Edge, Firefox on Android and desktop
- Desktop browsers run the UI but have no motion sensors, and the app
  says so instead of failing silently
