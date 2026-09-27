/* ============================================================
   analyze-loocv.mjs — how good is the LIVE fork prediction, really?
   ------------------------------------------------------------
   Replays every labelled trip in a training export through the SHIPPED
   ForkEngine class (./fork-engine.js), sample by sample, with a verdict
   once per second of sample time — the cadence of makeLivePrediction().
   The display is emulated too: the app only repaints the podium on a
   non-"waiting" verdict, so what is on screen at any instant is the last
   non-waiting verdict, or nothing.

   Scored at fixed times before Stop (the end of the recording). A trip
   with nothing on screen counts as WRONG — for an early warning, silence
   is a failure — and silent counts are printed separately.

   Only the streamed number counts. Offline windows and causal detectors
   for the same event have disagreed before (see fork-engine.js).

   Usage (Node 18+):
     node analyze-loocv.mjs <export.json>
         leave-one-out: each trip scored with calibration from the others
     node analyze-loocv.mjs <export.json> --train-before 2026-09-01
         prospective: calibrate on trips before the date, score the rest
     add --trips to print one row per trip
   ============================================================ */

import fs from "node:fs";
import { calibrate, finalVerdict, ForkEngine } from "./fork-engine.js";

const LEADS = [30, 24, 20, 16, 12, 10, 8, 6, 4, 2, 0];
const TARGET_LEAD = 10;      // the overhaul brief: >=80% at 10 s before Stop
const TARGET_ACC = 0.8;
const TARGET_FLIPS = 1.0;    // mean flips of the shown side, [end-30, end-10]

function parseArgs(argv) {
  const out = { file: null, trainBefore: null, trips: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--train-before") out.trainBefore = Date.parse(argv[++i]);
    else if (argv[i] === "--trips") out.trips = true;
    else out.file = argv[i];
  }
  if (!out.file) {
    console.error("usage: node analyze-loocv.mjs <export.json> [--train-before YYYY-MM-DD] [--trips]");
    process.exit(2);
  }
  return out;
}

function loadTrips(file) {
  // PowerShell-written copies carry a BOM, which JSON.parse rejects.
  const d = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  return (d.examples || [])
    .filter((e) => (e.label === "left" || e.label === "right") && e.rawMotionData?.length >= 600)
    .map((e) => ({ id: e.id, label: e.label, timestamp: e.timestamp, raw: e.rawMotionData }));
}

/** Replay one trip; returns the per-second timeline of what is on screen. */
function stream(raw, engine) {
  let nextTick = raw[0].time + 1000;
  let shown = null;
  const tl = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const tick = s.time >= nextTick || i === raw.length - 1;
    // Non-tick samples get no buffer: the state machine must never read it.
    const v = engine.update(s, tick ? raw.slice(0, i + 1) : null, tick);
    if (!tick) continue;
    while (nextTick <= s.time) nextTick += 1000;
    if (v && v.phase !== "waiting") shown = { pLeft: v.pLeft, prediction: v.prediction, phase: v.phase };
    tl.push({ t: s.time, shown });
  }
  return tl;
}

function score(trip, cal) {
  const tl = stream(trip.raw, new ForkEngine(cal));
  const end = trip.raw[trip.raw.length - 1].time;
  const at = {};
  for (const L of LEADS) {
    let rec = null;
    for (const r of tl) { if (r.t <= end - L * 1000) rec = r; else break; }
    at[L] = rec && rec.shown;
  }
  const flips = (lo, hi) => {
    let n = 0, prev = null;
    for (const r of tl) {
      if (r.t < lo || r.t > hi || !r.shown) continue;
      if (prev !== null && r.shown.prediction !== prev) n++;
      prev = r.shown.prediction;
    }
    return n;
  };
  const held = tl.filter((r) => r.shown && r.shown.phase === "held");
  const fv = finalVerdict(trip.raw, cal);
  return {
    trip, at,
    flips30to10: flips(end - 30000, end - 10000),
    flipsAll: flips(-Infinity, Infinity),
    heldLead: held.length ? (end - held[held.length - 1].t) / 1000 : null,
    finalPrediction: fv ? fv.prediction : null,
  };
}

function report(title, rows) {
  const n = rows.length;
  const pct = (c) => `${String(Math.round((100 * c) / n)).padStart(3)}%`;
  const right = (L) => rows.filter((r) => r.at[L] && r.at[L].prediction === r.trip.label).length;
  const silent = (L) => rows.filter((r) => !r.at[L]).length;
  const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / n;

  console.log(`\n== ${title}  (n=${n}: ${rows.filter((r) => r.trip.label === "left").length}L/${rows.filter((r) => r.trip.label === "right").length}R)`);
  console.log("  s before Stop " + LEADS.map((L) => String(L).padStart(6)).join(""));
  console.log("  correct       " + LEADS.map((L) => pct(right(L)).padStart(6)).join(""));
  console.log("  (count)       " + LEADS.map((L) => `${right(L)}/${n}`.padStart(6)).join(""));
  console.log("  silent        " + LEADS.map((L) => String(silent(L)).padStart(6)).join(""));

  const acc = right(TARGET_LEAD) / n;
  const flips = mean((r) => r.flips30to10);
  const shownAt = rows.filter((r) => r.at[TARGET_LEAD]);
  const conf = shownAt.reduce((a, r) => a + Math.max(r.at[TARGET_LEAD].pLeft, 1 - r.at[TARGET_LEAD].pLeft), 0) / (shownAt.length || 1);
  const agree = shownAt.filter((r) => r.at[TARGET_LEAD].prediction === r.finalPrediction).length;
  const fin = rows.filter((r) => r.finalPrediction === r.trip.label).length;
  const mark = (ok) => (ok ? "PASS" : "FAIL");
  console.log(`  ${mark(acc >= TARGET_ACC)}  ${Math.round(100 * acc)}% correct ${TARGET_LEAD} s before Stop (target >= ${100 * TARGET_ACC}%)`);
  console.log(`  ${mark(flips <= TARGET_FLIPS)}  ${flips.toFixed(2)} flips/trip between 30 and 10 s out (target <= ${TARGET_FLIPS}); whole trip ${mean((r) => r.flipsAll).toFixed(2)}`);
  console.log(`        shown confidence ${TARGET_LEAD} s out: mean ${Math.round(100 * conf)}% (vs ${Math.round(100 * acc)}% actually correct)`);
  console.log(`        agrees with the post-Stop verdict ${TARGET_LEAD} s out: ${agree}/${n}`);
  console.log(`        post-Stop verdict correct: ${fin}/${n} (${Math.round((100 * fin) / n)}%)`);
}

function printTrips(rows) {
  console.log("\n  trip          label  " + LEADS.map((L) => String(L).padStart(3)).join("") + "   last held   post-Stop");
  for (const r of rows) {
    const cells = LEADS.map((L) => (!r.at[L] ? "  ." : r.at[L].prediction === r.trip.label ? "  +" : "  x")).join("");
    const held = r.heldLead === null ? "      -" : `${r.heldLead.toFixed(0).padStart(4)} s`;
    console.log(`  ${String(r.trip.id).padEnd(13)} ${r.trip.label.padEnd(5)} ${cells}   ${held}   ${r.finalPrediction === r.trip.label ? "right" : "WRONG"}`);
  }
  console.log("  (+ correct, x wrong, . nothing shown; 'last held' = seconds before Stop the final hold was on screen)");
}

const args = parseArgs(process.argv.slice(2));
const trips = loadTrips(args.file);
const asExamples = (ts) => ts.map((t) => ({ label: t.label, rawMotionData: t.raw }));

let rows, title;
if (args.trainBefore) {
  const train = trips.filter((t) => t.timestamp < args.trainBefore);
  const test = trips.filter((t) => t.timestamp >= args.trainBefore);
  const cal = calibrate(asExamples(train));
  rows = test.map((t) => score(t, cal));
  title = `PROSPECTIVE: calibrated on ${train.length} trips before ${new Date(args.trainBefore).toISOString().slice(0, 10)}, scored on ${test.length} after`;
} else {
  rows = trips.map((t) => score(t, calibrate(asExamples(trips.filter((o) => o !== t)))));
  title = "LEAVE-ONE-OUT: each trip scored with calibration from all the others";
}
report(title, rows);
if (args.trips) printTrips(rows);
