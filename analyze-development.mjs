/** Reproducible whole-journey experiments. Raw recordings remain local. */
import fs from 'node:fs';
import { loadRecordings, inventory } from './lib/recordings.mjs';
import * as baseline from './fork-engine-baseline.js';
import * as current from './fork-engine.js';

const args = process.argv.slice(2);
const paths = [];
let holdoutFrom = null, outputPath = 'docs/development-metrics.json';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--holdout-from' || args[i] === '--out') {
    const option = args[i], value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a path.`);
    if (option === '--holdout-from') holdoutFrom = value;
    else outputPath = value;
  } else if (args[i].startsWith('--')) throw new Error(`Unknown option ${args[i]}`);
  else paths.push(args[i]);
}
if (!paths.length) throw new Error('Supply one or more private recording exports.');
const { examples, duplicates } = loadRecordings(paths);
const leads = [30, 20, 16, 12, 10, 8, 0];
const cutoff = Date.parse('2026-09-28');
const trainingFingerprints = holdoutFrom ? new Set(loadRecordings([holdoutFrom]).examples.map(e => e.fingerprint)) : null;
if (trainingFingerprints && [...trainingFingerprints].some(key => !examples.some(e => e.fingerprint === key))) {
  throw new Error('The holdout training export contains journeys absent from the supplied evaluation exports.');
}
const old = examples.filter(e => trainingFingerprints ? trainingFingerprints.has(e.fingerprint) : e.timestamp < cutoff);
const newTrips = examples.filter(e => trainingFingerprints ? !trainingFingerprints.has(e.fingerprint) : e.timestamp >= cutoff);
if (!old.length || !newTrips.length) throw new Error('The chronological comparison needs both training and unseen journeys.');

// Deliberately small, mechanism-based family, chosen before inspecting results.
const variants = [
  { name: 'baseline equal yaw+jolt', yaw: .5 },
  { name: 'yaw only', yaw: 1 },
  { name: 'jolt only', yaw: 0 },
  { name: '75% yaw + 25% jolt', yaw: .75 },
  { name: '25% yaw + 75% jolt', yaw: .25 },
  { name: `shipped v${current.FORK_ENGINE_VERSION} phase-calibrated confidence`, yaw: .5, calibrated: true },
];

const sigmoid = z => 1 / (1 + Math.exp(-z));
const logit = p => Math.log(p / (1 - p));

function weightedCalibration(train, variant) {
  const cal = (variant.calibrated ? current : baseline).calibrate(train);
  if (cal.liveYaw && cal.liveSkew) {
    cal.liveYaw = { ...cal.liveYaw, sd: variant.yaw ? cal.liveYaw.sd / (2 * variant.yaw) : Infinity };
    cal.liveSkew = { ...cal.liveSkew, sd: variant.yaw < 1 ? cal.liveSkew.sd / (2 * (1-variant.yaw)) : Infinity };
  }
  return cal;
}

function evaluate(trainFor, test, variant) {
  const rows = [];
  for (const trip of test) {
    const train = trainFor(trip);
    const timeline = (variant.calibrated ? current : baseline).replayDisplay(trip.rawMotionData, weightedCalibration(train, variant));
    const at = Object.fromEntries(leads.map(lead => [lead, baseline.shownAt(timeline, lead)]));
    let prev = null, firm = false, flips = 0, allFlips = 0, firstFirmLead = null;
    const end = timeline.at(-1).t;
    for (const row of timeline) {
      if (!row.shown) continue;
      if (prev && prev !== row.shown.prediction) { allFlips++; if (firm) flips++; }
      if (row.shown.phase === 'firm' && !firm) { firm = true; firstFirmLead = (end-row.t)/1000; }
      prev = row.shown.prediction;
    }
    let stableCorrectLead = null;
    for (let i = timeline.length-1; i >= 0; i--) {
      if (timeline[i].shown?.prediction !== trip.label) break;
      stableCorrectLead = (end-timeline[i].t)/1000;
    }
    rows.push({ id: trip.id, label: trip.label, at, flips, allFlips, firstFirmLead, stableCorrectLead, timeline });
  }
  return rows;
}

function metrics(rows, lead) {
  const count = rows.length;
  const observations = rows.map(r => ({ label: r.label, shown: r.at[lead] })).filter(x => x.shown);
  let brier = 0, logLoss = 0, high = 0, highWrong = 0, ece = 0;
  for (const { label, shown: s } of observations) {
    const y = label === 'left' ? 1 : 0, p = Math.max(.0001, Math.min(.9999, s.pLeft));
    brier += (p-y)**2;
    logLoss -= y*Math.log(p)+(1-y)*Math.log(1-p);
    if (Math.max(p,1-p) >= .8) { high++; if (s.prediction !== label) highWrong++; }
  }
  for (let bin=0; bin<5; bin++) {
    const group = observations.filter(x => Math.min(4, Math.floor(Math.max(x.shown.pLeft, 1-x.shown.pLeft)*5)) === bin);
    if (!group.length) continue;
    const confidence = group.reduce((sum,x) => sum+Math.max(x.shown.pLeft,1-x.shown.pLeft),0)/group.length;
    const accuracy = group.filter(x=>x.shown.prediction===x.label).length/group.length;
    ece += group.length/observations.length*Math.abs(confidence-accuracy);
  }
  return { correct: observations.filter(x=>x.shown.prediction===x.label).length, count, shown: observations.length,
    accuracy: count ? observations.filter(x=>x.shown.prediction===x.label).length/count : null,
    brier: observations.length ? brier/observations.length : null, logLoss: observations.length ? logLoss/observations.length : null, ece: observations.length ? ece : null,
    highConfidence: high, highConfidenceWrong: highWrong, falseConfidenceRate: high ? highWrong/high : null };
}

function summary(rows) {
  const median = xs => { const x=xs.filter(Number.isFinite).sort((a,b)=>a-b); return x.length?x[Math.floor(x.length/2)]:null; };
  const liveMetrics=rs=>{
    const live=rs.map(r=>{
    const seen=r.timeline.filter(x=>x.shown), high=seen.filter(x=>Math.max(x.shown.pLeft,1-x.shown.pLeft)>=.8);
    return { brier:seen.length ? seen.reduce((sum,x)=>sum+(x.shown.pLeft-(r.label==='left'?1:0))**2,0)/seen.length : null,
      high:high.length, highWrong:high.filter(x=>x.shown.prediction!==r.label).length };
    });
    const withReadings=live.filter(r=>r.brier!==null);
    return {journeysWithReadings:withReadings.length,journeyWeightedBrier:withReadings.length ? withReadings.reduce((sum,r)=>sum+r.brier,0)/withReadings.length : null,
      highConfidenceTicks:live.reduce((sum,r)=>sum+r.high,0),highConfidenceWrongTicks:live.reduce((sum,r)=>sum+r.highWrong,0)};
  };
  const roundShown=s=>{
    if(!s)return null;
    const probability=s.prediction==='left'?s.pLeft:1-s.pLeft;
    const rounded=Math.round(probability*20)/20;
    return {...s,pLeft:s.prediction==='left'?rounded:1-rounded};
  };
  const rounded=rows.map(r=>({...r,at:Object.fromEntries(Object.entries(r.at).map(([lead,s])=>[lead,roundShown(s)])),
    timeline:r.timeline.map(x=>({...x,shown:roundShown(x.shown)}))}));
  return { n: rows.length, leads: Object.fromEntries(leads.map(lead=>[lead,metrics(rows,lead)])),
    live:liveMetrics(rows),rounded5:{finish:metrics(rounded,0),live:liveMetrics(rounded)},
    postFirmFlips: rows.reduce((sum,r)=>sum+r.flips,0), allFlips: rows.reduce((sum,r)=>sum+r.allFlips,0),
    medianFirstFirmLead: median(rows.map(r=>r.firstFirmLead)), medianStableCorrectLead: median(rows.map(r=>r.stableCorrectLead)),
    stableCorrectCount: rows.filter(r=>r.stableCorrectLead!==null).length };
}

const result = { generated: new Date().toISOString(), n: examples.length, duplicates,
  holdout:{trainingExport:holdoutFrom,trainingCount:old.length,testCount:newTrips.length,testIds:newTrips.map(e=>e.id),
    note:'Training membership is fixed by the earlier export when supplied; repeated cumulative journeys never become unseen tests.'},
  inventory: inventory(examples), compass: [], variants: [] };
for (const e of examples.filter(e=>e.timestamp>=cutoff)) {
  const raw=e.rawMotionData, end=raw.at(-1).time;
  const values=raw.filter(s=>Number.isFinite(s.heading));
  const sumChange=rows=>rows.slice(1).reduce((sum,s,i)=>sum+((s.heading-rows[i].heading+540)%360)-180,0);
  const approach=values.filter(s=>s.time>=end-26000 && s.time<=end-10000);
  const g=(s)=>[s.gx,s.gy,s.gz];
  const angle=(a,b)=>a && b && a.every(Number.isFinite) && b.every(Number.isFinite) && Math.hypot(...a)>0 && Math.hypot(...b)>0
    ? Math.acos(Math.max(-1,Math.min(1,a.reduce((sum,x,i)=>sum+x*b[i],0)/(Math.hypot(...a)*Math.hypot(...b)))))*180/Math.PI : null;
  result.compass.push({id:e.id,label:e.label,valid:values.length,accurateWithin20Deg:values.filter(s=>Number.isFinite(s.headingAccuracy) && s.headingAccuracy>=0 && s.headingAccuracy<=20).length,
    wholeJourneyHeadingChangeDeg:sumChange(values),approachHeadingChangeDeg:sumChange(approach),
    approachYawDeg:baseline.yawIntegral(raw,end,26,10),approachPhoneTiltChangeDeg:angle(approach.length ? g(approach[0]) : null,approach.length ? g(approach.at(-1)) : null) });
}
result.compassExploratoryLOJO=[];
const compassTrips=examples.filter(e=>e.rawMotionData.some(s=>Number.isFinite(s.heading)));
const compassFeature=(e,lead)=>{
  const end=e.rawMotionData.at(-1).time-lead*1000;
  const rows=e.rawMotionData.filter(s=>Number.isFinite(s.heading) && s.time>=end-16000 && s.time<=end);
  if(rows.length<2 || rows.at(-1).time-rows[0].time<15000) return null;
  return rows.slice(1).reduce((sum,s,i)=>sum+((s.heading-rows[i].heading+540)%360)-180,0);
};
const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b),n=s.length;return !n ? null : n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2;};
result.compassFrozenHoldout=[];
for(const lead of leads) {
  const values=compassTrips.map(e=>compassFeature(e,lead));
  let correct=0;
  for(let i=0;i<compassTrips.length;i++) {
    const L=values.filter((_,j)=>j!==i && compassTrips[j].label==='left'),R=values.filter((_,j)=>j!==i && compassTrips[j].label==='right');
    const l=median(L),r=median(R),prediction=values[i]!==null && l!==null && r!==null ? ((l>=r?1:-1)*(values[i]-(l+r)/2)>0?'left':'right') : null;
    if(prediction===compassTrips[i].label)correct++;
  }
  result.compassExploratoryLOJO.push({lead,correct,n:compassTrips.length,note:'Exploratory journey-held-out fit on the available compass recordings; phone tilt/heading reliability remains unestablished.'});
  const L=old.filter(e=>e.label==='left').map(e=>compassFeature(e,lead)),R=old.filter(e=>e.label==='right').map(e=>compassFeature(e,lead));
  const l=median(L),r=median(R);
  const predictions=newTrips.map(e=>{const value=compassFeature(e,lead);return {id:e.id,label:e.label,value,
    prediction:value!==null && l!==null && r!==null ? ((l>=r?1:-1)*(value-(l+r)/2)>0?'left':'right') : null};});
  result.compassFrozenHoldout.push({lead,trainingLeft:L.filter(Number.isFinite).length,trainingRight:R.filter(Number.isFinite).length,
    threshold:l!==null && r!==null ? (l+r)/2 : null,sign:l!==null && r!==null ? (l>=r?1:-1) : null,
    correct:predictions.filter(e=>e.prediction===e.label).length,n:predictions.length,predictions,
    note:'Exact established 16-second trailing heading-change feature. Fit only the earlier export; missing window coverage produces no answer. Not a deployed override.'});
}
result.holdoutSignalDiagnostics=[];
const frozenCalibration=current.calibrate(old);
if(frozenCalibration.liveYaw && frozenCalibration.liveSkew) {
  for(const trip of newTrips) {
    const engine=new current.ForkEngine(frozenCalibration),raw=trip.rawMotionData;
    let next=raw[0].time+1000;
    for(let i=0;i<raw.length;i++) {
      const sample=raw[i],tick=sample.time>=next || i===raw.length-1;
      engine.update(sample,raw,tick);
      if(tick) while(next<=sample.time) next+=1000;
    }
    const at=engine.readAt ?? raw.at(-1).time;
    const yaw=current.yawIntegral(raw,at,16,0),skew=current.magSkew(raw,at,14,0);
    const y=frozenCalibration.liveYaw,k=frozenCalibration.liveSkew;
    result.holdoutSignalDiagnostics.push({id:trip.id,label:trip.label,
      heldSecondsBeforeFinish:engine.readAt===null ? null : (raw.at(-1).time-at)/1000,yaw,skew,
      standardizedYaw:y.sign*(yaw-y.thr)/y.sd,standardizedSkew:skew===null ? null : k.sign*(skew-k.thr)/k.sd,
      note:'Components of the last causal held reading using only the earlier export for calibration; no alternative rule selected from this journey.'});
  }
}
for (const variant of variants) {
  const loo = evaluate(t => examples.filter(e=>e!==t), examples, variant);
  const chronological = evaluate(()=>old,newTrips,variant);
  const olderChronological = evaluate(()=>examples.filter(e=>e.timestamp<Date.parse('2026-09-01')),examples.filter(e=>e.timestamp>=Date.parse('2026-09-01')),variant);
  const item = { ...variant, loo: summary(loo), chronological: summary(chronological), sinceSeptember: summary(olderChronological),
    holdoutJourneys:chronological.map(({id,label,at,flips,firstFirmLead,stableCorrectLead})=>({id,label,at,flips,firstFirmLead,stableCorrectLead})) };
  result.variants.push(item);
  console.log(variant.name, JSON.stringify({loo:item.loo,chronological:item.chronological}));
}
fs.writeFileSync(outputPath, JSON.stringify(result,null,2)+'\n');
console.log(`Wrote aggregate metrics for ${examples.length} distinct journeys; ${duplicates} duplicate exports excluded.`);
