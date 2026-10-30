// Real Edge, temporary profile, local app; no personal browser session touched.
import {chromium} from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'test-results'); await fs.mkdir(out,{recursive:true});
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'};
const server=http.createServer(async(req,res)=>{try{
  const name=decodeURIComponent(new URL(req.url,'http://local').pathname);
  const target=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!target.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}
  const body=await fs.readFile(target);res.writeHead(200,{'Content-Type':types[path.extname(target)]||'text/plain'});res.end(body);
}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-extensions','--disable-sync']});
const checks=[],errors=[],apiRequests=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,hasTouch:true,isMobile:true});
  // Mock only the OS share target; actual IndexedDB, app, click and File bytes
  // remain real. Desktop automation cannot open iOS's OneDrive provider.
  await page.addInitScript(()=>{
    window.shareCalls=[];window.shareMode='success';
    Object.defineProperty(navigator,'canShare',{configurable:true,value:({files})=>Array.isArray(files)&&files[0] instanceof File});
    Object.defineProperty(navigator,'share',{configurable:true,value:data=>{
      window.shareCalls.push({file:data.files[0],active:navigator.userActivation.isActive});
      return window.shareMode==='cancel'?Promise.reject(new DOMException('Cancelled','AbortError')):Promise.resolve();
    }});
  });
  page.on('pageerror',e=>{errors.push(e.message);console.error('BROWSER',e.message);});
  page.on('request',request=>{if(request.url().includes('/api/onedrive/'))apiRequests.push(request.url());});
  console.log('Loading app');
  await page.goto(url);await page.waitForFunction(()=>window.motionLab?.state.sync);
  const dataset=JSON.parse(await fs.readFile(path.join(root,'victoria-training-2026-10-30-21L21R.json'),'utf8'));
  const seed=dataset.examples.filter(e=>e.rawMotionData?.length);
  console.log('Seeding history through same-origin local fixture');
  await page.evaluate(async ()=>{
    const {examples}=await (await fetch('./victoria-training-2026-10-30-21L21R.json')).json();
    const {TrainingSet}=await import('./training-set.js');
    const set=new TrainingSet();set.fromJSON({version:3,examples});await set.save();
  });
  console.log('Reloading and calibrating');
  await page.reload();await page.waitForFunction(()=>window.motionLab?.state.forkCal?.liveYaw,{timeout:60000});
  await page.locator('#sensorBtn').click();await page.locator('#recordBtn').click();
  const start=await page.evaluate(()=>{const s=motionLab.state;cancelAnimationFrame(s.rafId);s.rafId=null;clearInterval(s.journalTimer);s.lastPredictionAt=Infinity;return {recording:s.recording,oneProbability:document.querySelectorAll('#forecastProbability').length,toolsVisible:!!document.querySelector('#toolsGroup').getClientRects().length};});
  check('Recording starts and hides settings',start.recording&&!start.toolsVisible);
  check('Exactly one direction probability element',start.oneProbability===1);
  const raw=seed.at(-1).rawMotionData;
  const replay=await page.evaluate(async raw=>{
    const s=motionLab.state, base=performance.now(), first=raw[0].time;
    s.data=[];s.startTime=base;s.epochBase=Date.now()-base;
    const snapshots=[];let next=1000;
    for(const sample of raw){s.data.push({...sample,time:base+sample.time-first});
      if(sample.time-first>=next){s.lastSampleReceivedAt=performance.now();await motionLab.makeLivePrediction();next+=1000;snapshots.push({t:sample.time-first,p:s.position?.progress,direction:document.querySelector('#forecastDirection').textContent,probability:document.querySelector('#forecastProbability').textContent,firm:s.lastLivePrediction?.firm});}}
    return {snapshots,position:s.position,view:document.querySelector('#trackView').getAttribute('aria-label'),prediction:s.lastLivePrediction};
  },raw);
  check('Historical live replay drives sensor-derived track marker',replay.position.progress>0&&replay.view.includes('Relative movement'));
  check('Live replay produces one platform prediction',/platform/.test(replay.snapshots.at(-1).direction)&&/\d+%/.test(replay.snapshots.at(-1).probability));
  check('Position has broad bounds and no invented junction',replay.position.lower<replay.position.progress&&replay.position.upper>replay.position.progress&&replay.position.junction.progress===null);
  // Accelerated fixture delivered a full journey in one turn. Let the automatic
  // marker animation settle before inspecting its actual final on-track position.
  await page.waitForTimeout(900);
  for(const size of [{width:320,height:568},{width:375,height:667},{width:390,height:664},{width:390,height:844},{width:430,height:932}]){
    await page.setViewportSize(size);
    const box=await page.evaluate(()=>{const button=document.querySelector('#recordBtn').getBoundingClientRect();return {bottom:button.bottom,width:document.documentElement.scrollWidth,height:innerHeight,warning:document.querySelector('#saveStatus').getBoundingClientRect().bottom};});
    check(`Finish and save status visible at ${size.width}x${size.height}`,box.bottom<=size.height&&box.warning<=size.height&&box.width<=size.width);
    await page.screenshot({path:path.join(out,`iphone-${size.width}x${size.height}.png`)});
  }
  await page.setViewportSize({width:390,height:844});
  const before=await page.locator('#forecastDirection').textContent(),prob=await page.locator('#forecastProbability').textContent();
  await page.locator('#recordBtn').click();await page.locator('[data-answer="skip"]').waitFor();
  check('Finish saves before asking for a label',await page.evaluate(async()=>{const row=await motionLab.state.sync.getRecording(motionLab.state.recordingId);return row?.complete&&row.payload.rawMotionData.length>1000;}));
  check('Finish preserves exact live direction and probability',before===await page.locator('#forecastDirection').textContent()&&prob===await page.locator('#forecastProbability').textContent());
  await page.locator('[data-answer="skip"]').click();await page.waitForFunction(()=>!motionLab.state.finishing);
  check('Finished recording offers a visible OneDrive save button',await page.locator('#saveOneDriveBtn').isVisible()&&await page.locator('#saveOneDriveBtn').isEnabled());
  await page.screenshot({path:path.join(out,'iphone-finished-onedrive.png')});
  await page.locator('#saveOneDriveBtn').click();
  const shared=await page.evaluate(async()=>{const call=shareCalls.at(-1);return {count:shareCalls.length,active:call.active,name:call.file.name,data:JSON.parse(await call.file.text())};});
  check('OneDrive button shares the actual full recording inside the user tap',shared.count===1&&shared.active&&shared.name.endsWith('.json')&&shared.data.examples[0].rawMotionData.length===raw.length);
  check('Native handoff never claims confirmed OneDrive upload',/Handed to the system/.test(await page.locator('#saveStatus').textContent()));
  await page.evaluate(()=>{window.shareMode='cancel';});await page.locator('#saveOneDriveBtn').click();
  check('Cancelled OneDrive save keeps a durable copy and allows retry',await page.evaluate(async()=>!!(await motionLab.state.sync.getRecording(motionLab.state.recordingId))&&!document.querySelector('#saveOneDriveBtn').disabled&&document.querySelector('#saveStatus').textContent.includes('cancelled')));
  await page.reload();await page.waitForFunction(()=>motionLab?.state.sync);
  await page.waitForFunction(()=>!document.querySelector('#saveOneDriveBtn').disabled);
  check('OneDrive save is prepared again automatically after reload',await page.locator('#saveOneDriveBtn').isVisible());
  check('Skipped label recording survives reload',await page.evaluate(async()=>(await motionLab.state.sync.listRecordings()).some(x=>x.complete)));
  // Draft recovery survives reload, and incomplete recordings never upload.
  await page.locator('#sensorBtn').click();await page.locator('#recordBtn').click();
  check('OneDrive control is hidden during recording',!await page.locator('#saveOneDriveBtn').isVisible());
  await page.evaluate(async()=>{const s=motionLab.state;s.data=[{time:performance.now(),ax:0,ay:0,az:.1,rotationAlpha:0,rotationBeta:0,rotationGamma:0,gx:0,gy:0,gz:9.81}];await motionLab.protectRecording(false);});
  await page.reload();await page.waitForFunction(()=>motionLab?.state.sync);
  check('Interrupted recording draft survives reload',await page.evaluate(async()=>(await motionLab.state.sync.listRecordings()).some(x=>!x.complete)));
  // Real devicemotion with absent fields must be preserved as missing.
  await page.locator('#sensorBtn').click();await page.locator('#recordBtn').click();
  const missing=await page.evaluate(()=>{dispatchEvent(new DeviceMotionEvent('devicemotion'));return motionLab.state.data.at(-1);});
  check('Missing sensors remain null instead of fake zero readings',missing.ax===null&&missing.gx===null&&missing.rotationAlpha===null);
  await page.evaluate(async()=>{const store=motionLab.state.sync.store;window.originalPut=store.put;store.put=async()=>{throw new Error('Simulated full storage');};await motionLab.protectRecording(false);});
  await page.setViewportSize({width:320,height:568});
  check('Storage failure during capture needs no extra touch controls',await page.evaluate(()=>!document.querySelector('#emergencyDownload')&&!document.querySelector('#retryLocalSave')&&document.querySelector('#saveStatus').getBoundingClientRect().bottom<=innerHeight));
  await page.locator('#recordBtn').click();await page.locator('[data-answer="skip"]').click();await page.waitForFunction(()=>!motionLab.state.finishing);
  await page.locator('#recordBtn').click();
  check('Unsaved recording cannot be overwritten by a new Start',await page.evaluate(()=>motionLab.state.memoryUnsaved&&!motionLab.state.recording&&!!document.querySelector('#retryLocalSave')));
  await page.evaluate(()=>{motionLab.state.sync.store.put=window.originalPut;});
  await page.locator('#retryLocalSave').click();await page.waitForFunction(()=>!motionLab.state.memoryUnsaved);
  check('Failed local save can be retried without losing samples',await page.evaluate(async()=>{const row=await motionLab.state.sync.getRecording(motionLab.state.recordingId);return row.complete&&row.payload.rawMotionData.length>0&&!document.querySelector('#retryLocalSave');}));
  check('No uncaught browser errors',errors.length===0);
  check('Native-only recording and saving never contact an extra backend',apiRequests.length===0);
  // Cache installed shell, then prove full offline reload initializes modules.
  await page.evaluate(async()=>{await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Offline shell did not install')),15000))]);});
  await page.context().setOffline(true);await page.reload();await page.waitForFunction(()=>motionLab?.state.sync);
  check('Offline app-shell reload initializes local recording store',await page.evaluate(()=>!!motionLab.state.sync));
  await fs.writeFile(path.join(out,'browser-results.json'),JSON.stringify({checks,errors,replay},null,2));
  console.log(`${checks.length} browser checks passed; screenshots in test-results/`);
}finally{await browser.close();server.close();}
