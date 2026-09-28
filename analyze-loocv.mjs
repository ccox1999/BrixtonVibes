/* ============================================================
   analyze-loocv.mjs — how good is the LIVE call, really?
   ------------------------------------------------------------
   Replays every labelled trip in a training export through the SHIPPED
   engine (fork-engine.js replayDisplay: every sample through ForkEngine,
   one verdict per second, the app's display rules) and scores what was
   ON SCREEN at fixed times before Stop (the end of the recording).

   Only the live call counts: tapping Stop freezes whatever was on screen,
   and there is no post-Stop verdict. Nothing on screen counts as WRONG.
   "firm" = the frozen call (phase "firm"); before the freeze the screen
   shows a provisional rolling reading, and a freeze too early in the
   journey to be the platform (phase "held", probably a signal wait) is
   shown but not firm.

   Usage (Node 18+):
     node analyze-loocv.mjs <export.json>
         leave-one-out: each trip scored with calibration from the others
     node analyze-loocv.mjs <export.json> --train-before 2026-09-01
         prospective: calibrate on trips before the date, score the rest
     add --trips to print one row per trip
   ============================================================ */

import fs from "node:fs";
import { calibrate, replayDisplay, shownAt } from "./fork-engine.js";

const LEADS = [30, 24, 20, 16, 12, 10, 8, 6, 4, 2, 0];
// Targets from the 2026-09-28 goal.
const T_STOP = 0.8;          // right at the instant of Stop (the frozen number)
const T_RANGE = 0.8;         // right at every lead from 10 s to 0 s
const T_FLIPS = 0.2;         // changes of the shown side after the first firm call

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

function score(trip, cal) {
  const tl = replayDisplay(trip.raw, cal);
  const at = {};
  for (const L of LEADS) at[L] = shownAt(tl, L);
  // Changes of the shown side after the first firm call (blank spells are
  // skipped: firm L -> blank -> R counts as one change).
  let firmSince = null, prev = null, flips = 0;
  const end = tl[tl.length - 1].t;
  for (const r of tl) {
    if (!r.shown) continue;
    if (firmSince === null) {
      if (r.shown.phase === "firm") { firmSince = (end - r.t) / 1000; prev = r.shown.prediction; }
      continue;
    }
    if (r.shown.prediction !== prev) flips++;
    prev = r.shown.prediction;
  }
  return { trip, at, flips, firstFirmLead: firmSince };
}

function report(title, rows) {
  const n = rows.length;
  const pct = (c) => `${String(Math.round((100 * c) / n)).padStart(3)}%`;
  const right = (L) => rows.filter((r) => r.at[L] && r.at[L].prediction === r.trip.label).length;
  const firmRight = (L) => rows.filter((r) => r.at[L] && r.at[L].phase === "firm" && r.at[L].prediction === r.trip.label).length;
  const blank = (L) => rows.filter((r) => !r.at[L]).length;
  const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / n;

  console.log(`\n== ${title}  (n=${n}: ${rows.filter((r) => r.trip.label === "left").length}L/${rows.filter((r) => r.trip.label === "right").length}R)`);
  console.log("  s before Stop     " + LEADS.map((L) => String(L).padStart(6)).join(""));
  console.log("  right on screen   " + LEADS.map((L) => pct(right(L)).padStart(6)).join(""));
  console.log("  (count)           " + LEADS.map((L) => `${right(L)}/${n}`.padStart(6)).join(""));
  console.log("  right AND firm    " + LEADS.map((L) => pct(firmRight(L)).padStart(6)).join(""));
  console.log("  nothing shown     " + LEADS.map((L) => String(blank(L)).padStart(6)).join(""));

  const stop = right(0) / n;
  const worst = Math.min(...[10, 8, 6, 4, 2, 0].map((L) => right(L) / n));
  const flips = mean((r) => r.flips);
  const firmLeads = rows.map((r) => r.firstFirmLead).filter((x) => x !== null).sort((a, b) => a - b);
  const mark = (ok) => (ok ? "PASS" : "FAIL");
  console.log(`  ${mark(stop >= T_STOP)}  frozen at Stop: ${Math.round(100 * stop)}% right (target >= ${100 * T_STOP}%)`);
  console.log(`  ${mark(worst >= T_RANGE)}  worst point from 10 s to Stop: ${Math.round(100 * worst)}% (target >= ${100 * T_RANGE}%)`);
  console.log(`  ${mark(flips <= T_FLIPS)}  changes of mind after the first firm call: ${flips.toFixed(2)}/trip (target <= ${T_FLIPS})`);
  console.log(`        a firm call appeared on ${firmLeads.length}/${n} trips` +
    (firmLeads.length ? `, first at a median ${firmLeads[Math.floor(firmLeads.length / 2)].toFixed(0)} s before Stop` : ""));
}

function printTrips(rows) {
  console.log("\n  trip          label  " + LEADS.map((L) => String(L).padStart(3)).join("") + "   first firm   changes");
  for (const r of rows) {
    const cells = LEADS.map((L) => {
      const s = r.at[L];
      if (!s) return "  .";
      const ok = s.prediction === r.trip.label;
      return s.phase === "firm" ? (ok ? "  F" : "  X") : (ok ? "  +" : "  x");
    }).join("");
    const ff = r.firstFirmLead === null ? "       -" : `${r.firstFirmLead.toFixed(0).padStart(6)} s`;
    console.log(`  ${String(r.trip.id).padEnd(13)} ${r.trip.label.padEnd(5)} ${cells}   ${ff}   ${r.flips}`);
  }
  console.log("  (F firm+right, X firm+wrong, + provisional+right, x provisional+wrong, . nothing shown)");
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
