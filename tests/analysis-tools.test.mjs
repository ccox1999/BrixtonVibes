import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('chronological analysis rejects invalid dates before it can report a different validation method',()=>{
  for(const value of [undefined,'not-a-date','2026-02-30','2026-11']) {
    const args=['analyze-loocv.mjs','missing-private-export.json','--train-before'];
    if(value!==undefined) args.push(value);
    const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/requires a valid YYYY-MM-DD date/);
    assert.doesNotMatch(result.stdout,/LEAVE-ONE-OUT/);
  }
});

test('development analysis handles no compass or shown readings and holds out exact unseen recordings',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brixton-analysis-'));
  try {
    const raw=Array.from({length:600},(_,i)=>({time:i*20,ax:.1*Math.sin(i),ay:.1,az:.1,
      gx:0,gy:0,gz:9.81,rotationAlpha:0,rotationBeta:0,rotationGamma:0}));
    const examples=Array.from({length:7},(_,i)=>({id:`trip-${i}`,label:i%2?'right':'left',
      timestamp:Date.parse('2026-10-01')+i*86400000,
      rawMotionData:raw.map((s,j)=>j===0?{...s,rotationAlpha:i}:s)}));
    const earlier=path.join(dir,'earlier.json'),latest=path.join(dir,'latest.json'),out=path.join(dir,'metrics.json');
    fs.writeFileSync(earlier,JSON.stringify({examples:examples.slice(0,6)}));
    fs.writeFileSync(latest,JSON.stringify({examples}));
    const result=spawnSync(process.execPath,['analyze-development.mjs',earlier,latest,'--holdout-from',earlier,'--out',out],
      {cwd:root,encoding:'utf8',maxBuffer:2*1024*1024});
    assert.equal(result.status,0,result.stderr);
    const metrics=JSON.parse(fs.readFileSync(out,'utf8'));
    assert.equal(metrics.n,7);assert.equal(metrics.duplicates,6);
    assert.equal(metrics.holdout.trainingCount,6);
    assert.deepEqual(metrics.holdout.testIds,['trip-6']);
    assert.ok(metrics.compass.every(row=>row.valid===0 && row.approachPhoneTiltChangeDeg===null));
    assert.ok(metrics.compassFrozenHoldout.every(row=>row.threshold===null && row.correct===0));
    for(const variant of metrics.variants) {
      assert.equal(variant.loo.leads[0].shown,0);
      assert.equal(variant.loo.leads[0].brier,null);
      assert.equal(variant.loo.live.journeyWeightedBrier,null);
    }
  } finally {
    assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('brixton-analysis-'));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
