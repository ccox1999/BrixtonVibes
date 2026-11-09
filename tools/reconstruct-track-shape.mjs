/* Offline research tool. Builds per-journey, stop-constrained inertial traces
 * and a robust relative-shape overlay. These are hypotheses, not surveyed
 * coordinates; see docs/track-shape-reconstruction.md. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { motionFrames } from '../track-position.js';
import { loadRecordings } from '../lib/recordings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const outputArg = args.find(x => x.startsWith('--out-dir='))?.slice('--out-dir='.length);
const inputs = args.filter(x => !x.startsWith('--'));
if (!inputs.length) throw new Error('Pass private victoria-training JSON exports as arguments.');
const { examples } = loadRecordings(inputs.map(file => path.resolve(file)));
if (!examples.length) throw new Error('No usable real labelled journeys were found in the input exports.');

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => Math.hypot(...a);
const qnorm = q => { const m = Math.hypot(...q) || 1; return q.map(x => x / m); };
const qmul = (a, b) => [
  a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],
  a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
  a[0]*b[2]-a[1]*b[3]+a[2]*b[0]-a[3]*b[1],
  a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0],
];
const qrot = (q, v) => {
  const u = q.slice(1), uv = cross(u, v), uuv = cross(u, uv);
  return v.map((x, i) => x + 2 * (q[0] * uv[i] + uuv[i]));
};
const qalign = (from, to) => {
  const d = dot(from, to);
  if (d < -0.99999) return [0, 1, 0, 0];
  return qnorm([1 + d, ...cross(from, to)]);
};
const median = xs => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const quantile = (xs, p) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.round((a.length - 1) * p)];
};

function traceFor(example) {
  const raw = example.rawMotionData;
  const frames = motionFrames(raw);
  const frameOffset = raw[0].time;
  const quietBins = frames.map((f, i) => ({ i, quiet: f.quality && !f.moving }));
  const runs = [];
  for (let i = 0; i < quietBins.length;) {
    if (!quietBins[i].quiet) { i++; continue; }
    let j = i + 1;
    while (j < quietBins.length && quietBins[j].quiet) j++;
    if (j - i >= 6) runs.push({ start: i, end: j - 1, center: (i + j - 1) / 2 });
    i = j;
  }
  const sampleAt = time => {
    const index = raw.findIndex(s => s.time >= time);
    return Math.max(0, Math.min(raw.length - 1, index < 0 ? raw.length - 1 : index));
  };
  const anchorRows = [{ index: 0, runId: null }];
  for (const [runId, run] of runs.entries()) {
    // Bracket each long quiet interval at both ends. The train's position is
    // held through the dwell, and the dwell duration must not dilute a bias
    // correction applied to the moving segment before or after it.
    // Frame arrays omit unobserved seconds. Their indexes are not elapsed
    // time: use the real bucket boundaries or gaps shift stops onto movement.
    anchorRows.push({ index: sampleAt(frames[run.start].startTime), runId });
    anchorRows.push({ index: sampleAt(frames[run.end].endTime), runId });
  }
  anchorRows.push({ index: raw.length - 1, runId: null });
  const anchors = [];
  for (const row of anchorRows.sort((a, b) => a.index - b.index)) {
    const previousAnchor = anchors.at(-1);
    if (previousAnchor?.index === row.index) {
      if (row.runId !== null) previousAnchor.runId = row.runId;
    } else anchors.push({ ...row });
  }

  const yawOf = sample => {
    const g = [sample.gx, sample.gy, sample.gz], magnitude = norm(g);
    if (![...g, sample.rotationAlpha, sample.rotationBeta, sample.rotationGamma].every(Number.isFinite) || magnitude < 5 || magnitude > 15) return null;
    return dot([sample.rotationBeta, sample.rotationGamma, sample.rotationAlpha], g.map(x => -x / magnitude)) * Math.PI / 180;
  };
  // Find an actual low-motion opening window for gyro calibration. A long
  // quiet-looking interval later in the trip could be smooth travel, and the
  // button press itself can rotate the phone.
  let gyroBiasWindowSecond = null, gyroBiasSamples = [];
  for (let second = 0; second < Math.min(15, Math.floor((raw.at(-1).time - frameOffset) / 1000)); second++) {
    const window = raw.filter(s => s.time >= frameOffset + second * 1000 && s.time < frameOffset + (second + 1) * 1000);
    if (window.length < 40) continue;
    const accelRms = Math.sqrt(window.reduce((sum, s) => sum + s.ax*s.ax + s.ay*s.ay + s.az*s.az, 0) / window.length);
    const gyroRms = Math.sqrt(window.reduce((sum, s) => sum + s.rotationAlpha*s.rotationAlpha + s.rotationBeta*s.rotationBeta + s.rotationGamma*s.rotationGamma, 0) / window.length);
    if (accelRms < 0.25 && gyroRms < 3) {
      gyroBiasWindowSecond = second;
      gyroBiasSamples = window.map(yawOf).filter(Number.isFinite);
      break;
    }
  }
  const gyroYawBias = gyroBiasSamples.length >= 20 ? median(gyroBiasSamples) : 0;
  let theta = 0, previous = null, validCount = 0, largeGaps = 0;
  const rows = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i], g = [s.gx, s.gy, s.gz], gm = norm(g);
    if (![s.time, s.ax, s.ay, s.az, ...g, s.rotationAlpha, s.rotationBeta, s.rotationGamma].every(Number.isFinite) || gm < 5 || gm > 15) {
      rows.push(null); previous = null; continue;
    }
    const up = g.map(x => -x / gm);
    const omega = [s.rotationBeta, s.rotationGamma, s.rotationAlpha];
    const yaw = dot(omega, up) * Math.PI / 180 - gyroYawBias;
    let dt = 0;
    if (previous) {
      dt = (s.time - previous.time) / 1000;
      if (dt > 0.1 || dt <= 0) { largeGaps++; dt = 0; }
      theta += (previous.yaw + yaw) * 0.5 * dt;
    }
    const qYaw = [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)];
    const q = qmul(qYaw, qalign(up, [0, 0, 1]));
    rows.push({ time: s.time, a: qrot(q, [s.ax, s.ay, s.az]), yaw, theta, dt, index: i, velocity: [0, 0, 0], speed: 0 });
    validCount++;
    previous = { time: s.time, yaw };
  }

  // At rest, device linear acceleration should average to zero. A robust
  // component-wise median in the opening half-second estimates per-trip bias.
  const initialRows = rows.filter(r => r && r.time <= frameOffset + 500);
  const startAccelBias = [0, 1, 2].map(c => median(initialRows.map(r => r.a[c])));

  // Stationary intervals constrain velocity to zero without moving position.
  // Their centers are anchors; start and end are treated as at rest for this
  // candidate model and are separately flagged if the opening samples are busy.
  const path = [{ x: 0, y: 0, time: raw[0].time }];
  let px = 0, py = 0, totalLength = 0, correctionMagnitudes = [];
  for (let seg = 0; seg < anchors.length - 1; seg++) {
    const left = anchors[seg], right = anchors[seg + 1];
    const first = left.index, last = right.index;
    if (left.runId !== null && left.runId === right.runId) {
      path.push({ x: px, y: py, time: raw[last].time });
      continue;
    }
    const usable = rows.slice(first, last + 1).filter(Boolean);
    if (usable.length < 2) continue;
    let iv = [0, 0, 0], duration = 0;
    for (let k = 1; k < usable.length; k++) {
      const dt = usable[k].dt;
      for (let c = 0; c < 3; c++) iv[c] += ((usable[k - 1].a[c] - startAccelBias[c]) + (usable[k].a[c] - startAccelBias[c])) * 0.5 * dt;
      duration += dt;
    }
    const bias = iv.map(v => v / Math.max(duration, 1e-6));
    correctionMagnitudes.push(norm(bias));
    let v = [0, 0, 0], accumulated = 0;
    usable[0].velocity = [0, 0, 0]; usable[0].speed = 0;
    for (let k = 1; k < usable.length; k++) {
      const a0 = usable[k - 1].a.map((x, c) => x - startAccelBias[c] - bias[c]);
      const a1 = usable[k].a.map((x, c) => x - startAccelBias[c] - bias[c]);
      const dt = usable[k].dt;
      const nextV = v.map((x, c) => x + (a0[c] + a1[c]) * 0.5 * dt);
      const dx = (v[0] + nextV[0]) * 0.5 * dt, dy = (v[1] + nextV[1]) * 0.5 * dt;
      px += dx; py += dy; accumulated += Math.hypot(dx, dy); v = nextV;
      usable[k].velocity = [...v]; usable[k].speed = norm(v);
      if (usable[k].index % 12 === 0) path.push({ x: px, y: py, time: usable[k].time });
    }
    // The end velocity is zero by construction; do not carry noise across a dwell.
    totalLength += accumulated;
    path.push({ x: px, y: py, time: raw[last].time });
  }

  // Spatial curve from the kinematic relation kappa = yawRate / speed.
  // Equivalently: dHeading = gyroYaw * dt and ds = estimatedSpeed * dt.
  // This uses the gyro for direction and acceleration-derived velocity only
  // for distance, avoiding double-integration of lateral acceleration.
  for (const run of runs) {
    for (let index = run.start; index <= run.end; index++) {
      const first = sampleAt(frames[index].startTime), last = sampleAt(frames[index].endTime);
      for (let i = first; i <= last; i++) if (rows[i]) { rows[i].velocity = [0, 0, 0]; rows[i].speed = 0; }
    }
  }
  const courseOffsets = rows.filter(r => r && r.speed > 1.5 && r.time <= frameOffset + 30000)
    .map(r => Math.atan2(r.velocity[1], r.velocity[0]) - r.theta);
  const headingOffset = courseOffsets.length
    ? Math.atan2(courseOffsets.reduce((a, x) => a + Math.sin(x), 0), courseOffsets.reduce((a, x) => a + Math.cos(x), 0))
    : 0;
  const curvePath = [{ x: 0, y: 0, time: raw[0].time }];
  let cx = 0, cy = 0, curveLength = 0, priorCurve = null;
  for (const row of rows) {
    if (!row) { priorCurve = null; continue; }
    if (priorCurve && row.dt > 0) {
      const ds = (priorCurve.speed + row.speed) * 0.5 * row.dt;
      const angle = (priorCurve.theta + row.theta) * 0.5 + headingOffset;
      cx += ds * Math.cos(angle); cy += ds * Math.sin(angle); curveLength += ds;
      if (row.index % 12 === 0) curvePath.push({ x: cx, y: cy, time: row.time });
    }
    priorCurve = row;
  }
  curvePath.push({ x: cx, y: cy, time: raw.at(-1).time });

  const end = path.at(-1) || { x: 0, y: 0 };
  const chordAngle = Math.atan2(end.y, end.x);
  const c = Math.cos(chordAngle), s = Math.sin(chordAngle);
  let oriented = path.map(p => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c }));
  if (oriented.at(-1).x < 0) oriented = oriented.map(p => ({ x: -p.x, y: -p.y }));
  const length = totalLength;
  const resampled = resample(oriented, 61, length);
  const curveEnd = curvePath.at(-1) || { x: 0, y: 0 };
  const curveAngle = Math.atan2(curveEnd.y, curveEnd.x);
  const cc = Math.cos(curveAngle), cs = Math.sin(curveAngle);
  let curveOriented = curvePath.map(p => ({ x: p.x * cc + p.y * cs, y: -p.x * cs + p.y * cc }));
  if (curveOriented.at(-1).x < 0) curveOriented = curveOriented.map(p => ({ x: -p.x, y: -p.y }));
  const curvatureResampled = resample(curveOriented, 61, curveLength);
  const firstSeconds = raw.filter(s => s.time <= raw[0].time + 1000);
  const firstRms = Math.sqrt(firstSeconds.reduce((sum, s) => sum + s.ax*s.ax + s.ay*s.ay + s.az*s.az, 0) / Math.max(firstSeconds.length, 1));
  return {
    label: example.label, points: curvatureResampled, directIntegrationPoints: resampled,
    stats: { lengthM: curveLength, directIntegrationLengthM: length, endpointM: Math.hypot(curveEnd.x, curveEnd.y), netHeadingDeg: theta * 180 / Math.PI,
      internalStops: runs.length, accelerationCorrectionMedian: median(correctionMagnitudes),
      firstSecondAccelerationRms: firstRms, firstSecondLooksStationary: firstRms < 0.25,
      gyroBiasDegPerSec: gyroYawBias * 180 / Math.PI, gyroBiasWindowSecond,
      startAccelBiasMps2: norm(startAccelBias),
      skippedGapCount: largeGaps, validSampleFraction: validCount / raw.length },
  };
}

function resample(points, bins, pathLength) {
  if (!points.length || !(pathLength > 0)) return Array.from({ length: bins }, () => [0, 0]);
  const clean = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  const distances = [0];
  for (let i = 1; i < clean.length; i++) distances.push(distances.at(-1) + Math.hypot(clean[i].x - clean[i - 1].x, clean[i].y - clean[i - 1].y));
  if (distances.at(-1) <= 0) return Array.from({ length: bins }, () => [0, 0]);
  return Array.from({ length: bins }, (_, n) => {
    const target = distances.at(-1) * n / (bins - 1);
    let i = 1; while (i < distances.length - 1 && distances[i] < target) i++;
    const f = (target - distances[i - 1]) / Math.max(1e-9, distances[i] - distances[i - 1]);
    const x = clean[i - 1].x + (clean[i].x - clean[i - 1].x) * f;
    const y = clean[i - 1].y + (clean[i].y - clean[i - 1].y) * f;
    // Horizontal coordinate is the monotonic arc-progress parameter, not the
    // noisy integrated east/west coordinate. This keeps the display ordered
    // even when a single-trip dead-reckoned trace loops or briefly doubles back.
    return [n / (bins - 1), y / pathLength];
  });
}

const traces = examples.map(traceFor);
const byLabel = Object.fromEntries(['left', 'right'].map(label => [label, traces.filter(t => t.label === label)]));
const robustMean = (group, key = 'points') => Array.from({ length: 61 }, (_, i) => [
  median(group.map(t => t[key][i][0])), median(group.map(t => t[key][i][1]))]);
const summary = Object.fromEntries(['left', 'right', 'all'].map(label => {
  const group = label === 'all' ? traces : byLabel[label];
  const lengths = group.map(t => t.stats.lengthM);
  const directLengths = group.map(t => t.stats.directIntegrationLengthM);
  return [label, { trips: group.length, pathLengthP10MedianP90: [quantile(lengths, .1), median(lengths), quantile(lengths, .9)],
    strapdownPathLengthP10MedianP90: [quantile(directLengths, .1), median(directLengths), quantile(directLengths, .9)],
    startStationaryCount: group.filter(t => t.stats.firstSecondLooksStationary).length,
    correctionMedian: median(group.map(t => t.stats.accelerationCorrectionMedian)),
    medianNetHeadingDeg: median(group.map(t => t.stats.netHeadingDeg)), shape: robustMean(group),
    directShape: robustMean(group, 'directIntegrationPoints') }];
}));
const compareShape = key => {
  const distance = (trip, peers) => median(trip[key].map((point, i) =>
    Math.abs(point[1] - median(peers.map(peer => peer[key][i][1])))));
  let correct = 0;
  traces.forEach((trip, i) => {
    const left = traces.filter((peer, j) => peer.label === 'left' && j !== i);
    const right = traces.filter((peer, j) => peer.label === 'right' && j !== i);
    if ((distance(trip, left) <= distance(trip, right) ? 'left' : 'right') === trip.label) correct++;
  });
  const residuals = Object.fromEntries(['left', 'right'].map(label => {
    const group = traces.filter(t => t.label === label);
    return [label, median(group.map(trip => distance(trip, group.filter(peer => peer !== trip)))) * 100];
  }));
  const leftMedian = robustMean(byLabel.left, key), rightMedian = robustMean(byLabel.right, key);
  return { leaveOneJourneyOutBranchNearestAccuracy: correct / traces.length, correct, total: traces.length,
    balancedChance: 0.5, medianWithinBranchLeaveOneOutLateralResidualPctPathLength: residuals,
    branchDifference: [10, 20, 30, 40, 50].map(i => ({ progress: i / 60,
      leftMinusRightLateralPctPathLength: (leftMedian[i][1] - rightMedian[i][1]) * 100 })) };
};
const shapeConsistency = { gyroCurvature: compareShape('points'), doubleIntegratedAcceleration: compareShape('directIntegrationPoints') };
const outputDir = outputArg ? path.resolve(outputArg) : path.join(root, 'test-results');
fs.mkdirSync(outputDir, { recursive: true });
const compact = { version: 1, trips: traces.map(t => ({ label: t.label, points: t.points,
  directIntegrationPoints: t.directIntegrationPoints, stats: t.stats })), summary,
  shapeConsistency,
  method: 'Gravity-aligned accelerometer integration with gyro yaw bias estimated from a low-motion opening window; zero-speed start/end and ≥6-second low-motion anchors; per-segment acceleration bias correction. Compared direct double-integration against gyro curvature kappa=yawRate/speed; each trace rotated to its endpoint chord and normalized by inferred length; pointwise medians.',
  caveat: 'No geographic coordinates or measured distances. Start/end rest and detected low-motion runs are assumptions; endpoint speed is forced to zero. Relative shape is exploratory and not a surveyed railway map.' };
fs.writeFileSync(path.join(outputDir, 'track-reconstruction.json'), JSON.stringify(compact));

const W = 1500, H = 850;
const panels = [
  { x: 90, y: 140, w: 620, h: 520, key: 'points', median: 'shape', title: 'Gyro curvature + estimated speed' },
  { x: 790, y: 140, w: 620, h: 520, key: 'directIntegrationPoints', median: 'directShape', title: 'Double-integrated acceleration' },
];
const allPoints = traces.flatMap(t => [...t.points, ...t.directIntegrationPoints]);
const yExtent = Math.max(0.08, quantile(allPoints.map(p => Math.abs(p[1])), .98)) * 1.12;
const yMin = -yExtent, yMax = yExtent;
const colors = { left: '#4bb8ff', right: '#ff9f50' };
const panelSvg = panel => {
  const sx = x => panel.x + x * panel.w;
  const sy = y => panel.y + panel.h - (y - yMin) / (yMax - yMin) * panel.h;
  const pathOf = points => points.map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');
  const axes = [];
  for (let p = 0; p <= 1.0001; p += .2) axes.push(`<line x1="${sx(p)}" y1="${panel.y}" x2="${sx(p)}" y2="${panel.y + panel.h}" stroke="#34404d"/><text x="${sx(p)}" y="${panel.y + panel.h + 24}" text-anchor="middle">${Math.round(p*100)}%</text>`);
  for (let y = Math.ceil(yMin * 20) / 20; y <= yMax; y += .05) axes.push(`<line x1="${panel.x}" y1="${sy(y)}" x2="${panel.x+panel.w}" y2="${sy(y)}" stroke="#26313c"/><text x="${panel.x-10}" y="${sy(y)+4}" text-anchor="end">${(y*100).toFixed(0)}%</text>`);
  const paths = traces.map(t => `<path d="${pathOf(t[panel.key])}" fill="none" stroke="${colors[t.label]}" stroke-opacity="0.15" stroke-width="1.2"/>`).join('');
  const averages = ['left','right'].map(label => `<path d="${pathOf(summary[label][panel.median])}" fill="none" stroke="${colors[label]}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
  return `<text x="${panel.x+panel.w/2}" y="${panel.y-22}" text-anchor="middle" class="panelTitle">${panel.title}</text>${axes.join('')}<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(0)}" stroke="#6c7a89" stroke-dasharray="5 5"/>${paths}${averages}<text x="${panel.x+panel.w/2}" y="${panel.y+panel.h+51}" text-anchor="middle" class="label">Inferred distance progress (normalized)</text>`;
};
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="#0c1118"/><style>text{font-family:system-ui,-apple-system,Segoe UI,sans-serif;fill:#dce6f1} .small{font-size:13px;fill:#b7c2cf}.label{font-size:14px}.title{font-size:25px;font-weight:700}.sub{font-size:14px;fill:#a9b7c7}.panelTitle{font-size:18px;font-weight:650}</style>
<text x="55" y="45" class="title">${traces.length} journeys: individual path attempts and average shapes</text>
<text x="55" y="72" class="sub">Faint lines are individual recordings; solid lines are branch medians. Each trace is rotated and normalized to its own inferred distance.</text>
${panels.map(panelSvg).join('')}
<text x="30" y="${panels[0].y+panels[0].h/2}" transform="rotate(-90 30 ${panels[0].y+panels[0].h/2})" text-anchor="middle" class="label">Sideways offset (% of each estimated path length)</text>
<line x1="630" y1="105" x2="660" y2="105" stroke="${colors.left}" stroke-width="4"/><text x="668" y="110" class="small">Left median</text><line x1="790" y1="105" x2="820" y2="105" stroke="${colors.right}" stroke-width="4"/><text x="828" y="110" class="small">Right median</text>
<text x="60" y="785" class="small">Median inferred length: ${Math.round(summary.all.pathLengthP10MedianP90[1])} m (gyro + speed), ${Math.round(summary.all.strapdownPathLengthP10MedianP90[1])} m (direct); station-point chord is 1,169 m, so neither scale is valid.</text>
<text x="60" y="810" class="small">Exploratory shape only: starts/stops assumed; endpoint speed forced to zero; no verified track position or junction label. This is not a surveyed map.</text>
</svg>`;
fs.writeFileSync(path.join(outputDir, 'track-reconstruction.svg'), svg);
console.log(JSON.stringify({ uniqueTrips: traces.length, summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, { trips: v.trips, pathLengthP10MedianP90: v.pathLengthP10MedianP90.map(x => +x.toFixed(1)), startStationaryCount: v.startStationaryCount, correctionMedian: +v.correctionMedian.toFixed(4), medianNetHeadingDeg: +v.medianNetHeadingDeg.toFixed(2) }])), svg: path.join(outputDir, 'track-reconstruction.svg'), json: path.join(outputDir, 'track-reconstruction.json') }, null, 2));
