import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForkEngine, yawIntegral, magSkew, liveReadingAt, replayDisplay } from '../fork-engine.js';
import { loadRecordings } from '../lib/recordings.mjs';

const cal={liveYaw:{sign:1,thr:0,sd:1},liveSkew:{sign:-1,thr:1,sd:1},
  probability:{firm:{slope:2,journeys:20},approach:{slope:1,journeys:20},tentative:{slope:0,journeys:20}}};
function samples(n=6000) {
  return Array.from({length:n},(_,i)=>({time:i*20,ax:.1*Math.sin(i*.4),ay:.08*Math.cos(i*.31),az:.05*Math.cos(i*.7),
    gx:.2,gy:-3,gz:-9.3,rotationAlpha:.5*Math.sin(i*.002),rotationBeta:.1,rotationGamma:.2}));
}

test('yaw and vibration features are invariant to rotating the phone axes',()=>{
  const raw=samples(2000),rotated=raw.map(s=>({...s,ax:-s.ay,ay:s.ax,gx:-s.gy,gy:s.gx,rotationBeta:-s.rotationGamma,rotationGamma:s.rotationBeta}));
  assert.ok(Math.abs(yawIntegral(raw,39980,16,0)-yawIntegral(rotated,39980,16,0))<1e-10);
  assert.ok(Math.abs(magSkew(raw,39980,14,0)-magSkew(rotated,39980,14,0))<1e-10);
});

test('reading is causal even when replay is given the complete recording',()=>{
  const raw=samples(),t=85000,prefix=raw.filter(s=>s.time<=t);
  assert.equal(liveReadingAt(raw,t,cal),liveReadingAt(prefix,t,cal));
});

test('missing rotation or gravity clears a call instead of claiming zero motion',()=>{
  const e=new ForkEngine(cal),raw=samples();
  for(const s of raw.slice(0,4000))e.update(s,raw,false);
  let v=e.update({...raw[4000],rotationAlpha:null},raw,true);
  assert.equal(v.phase,'cleared');assert.equal(v.prediction,null);assert.equal(v.dataQuality,'missing-sensors');
  v=e.update(raw[4001],raw,true);
  assert.equal(v.dataQuality,'warming-up');assert.equal(v.probabilityReliable,false);
});

test('an interruption invalidates the previous window and cannot look like a stop',()=>{
  const e=new ForkEngine(cal),raw=samples();
  for(const s of raw.slice(0,4000))e.update(s,raw,false);
  e.frozen=true;e.frozenZ=10;
  const v=e.update({...raw[4000],time:raw[4000].time+30000},raw,true);
  assert.equal(v.dataQuality,'sensor-gap');assert.equal(v.phase,'cleared');assert.equal(e.frozen,false);
});

test('non-increasing timestamps never advance the engine',()=>{
  const e=new ForkEngine(cal),s=samples(1)[0];e.update(s,[s]);
  assert.equal(e.update(s,[s]),null);assert.equal(e.vib.length,1);
});

test('untrained installations cannot invent a confident probability',()=>{
  const e=new ForkEngine(),raw=samples();let v;
  for(const s of raw)v=e.update(s,raw,s.time===raw.at(-1).time)||v;
  assert.equal(v.pLeft,.5);assert.equal(v.probabilityReliable,false);
});

test('a constant gyro bias is bounded by the trailing window, not journey duration',()=>{
  const raw=samples(),bias=.1;
  const biased=raw.map(s=>{const g=Math.hypot(s.gx,s.gy,s.gz);return {...s,
    rotationBeta:s.rotationBeta+bias*s.gx/g,rotationGamma:s.rotationGamma+bias*s.gy/g,rotationAlpha:s.rotationAlpha+bias*s.gz/g};});
  const difference=yawIntegral(biased,119980,16,0)-yawIntegral(raw,119980,16,0);
  assert.ok(Math.abs(difference+1.6)<.01);
  // This deliberately is not bias correction: 1.6 degrees can still alter
  // the selected branch and must not be described as measured curvature.
});

test('replay clears missing evidence exactly as the live display does',()=>{
  const raw=samples(),broken=raw.map((s,i)=>i>=4500&&i<4700?{...s,rotationGamma:null}:s);
  const timeline=replayDisplay(broken,cal);
  assert.ok(timeline.some(r=>r.t>80000 && r.t<89000 && r.shown));
  assert.ok(timeline.filter(r=>r.t>=90000 && r.t<109000).every(r=>r.shown===null));
});

test('actual phone turning remains a disturbance, despite coordinate invariance',()=>{
  const raw=samples(),turned=raw.map(s=>s.time>=110000&&s.time<111000?{...s,rotationAlpha:s.rotationAlpha+15}:s);
  assert.ok(Math.abs(yawIntegral(turned,119980,16,0)-yawIntegral(raw,119980,16,0))>10);
});

test('cumulative exports deduplicate raw journeys and reject conflicting labels',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brixton-recordings-'));
  try {
    const a=path.join(dir,'a.json'),b=path.join(dir,'b.json'),e={id:'trip',label:'left',timestamp:1,rawMotionData:samples(600)};
    fs.writeFileSync(a,JSON.stringify({examples:[e]}));fs.writeFileSync(b,JSON.stringify({examples:[e]}));
    const loaded=loadRecordings([a,b]);assert.equal(loaded.examples.length,1);assert.equal(loaded.duplicates,1);
    fs.writeFileSync(b,JSON.stringify({examples:[{...e,label:'right'}]}));
    assert.throws(()=>loadRecordings([a,b]),/Conflicting labels/);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('brixton-recordings-'));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
