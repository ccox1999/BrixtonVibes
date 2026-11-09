// Real Edge, temporary profile, local app; no personal browser session touched.
import {chromium} from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const recordingName = process.argv[2] || (await fs.readdir(root)).filter(name=>/^victoria-training-\d{4}-\d{2}-\d{2}-\d+L\d+R\.json$/.test(name)).sort().at(-1);
if (!recordingName || path.basename(recordingName)!==recordingName) throw new Error('A local training export filename is required');
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
  // Mock OS prompts and share target; actual IndexedDB, app, click and File
  // bytes remain real. Desktop automation cannot open iOS's OneDrive provider.
  await page.addInitScript(()=>{
    window.shareCalls=[];window.shareMode='success';
    Object.defineProperty(DeviceMotionEvent,'requestPermission',{configurable:true,value:()=>Promise.resolve('granted')});
    Object.defineProperty(DeviceOrientationEvent,'requestPermission',{configurable:true,value:()=>new Promise(()=>{})});
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
  const dataset=JSON.parse((await fs.readFile(path.join(root,recordingName),'utf8')).replace(/^\uFEFF/,''));
  const seed=dataset.examples.filter(e=>e.rawMotionData?.length);
  console.log('Seeding history through same-origin local fixture');
  await page.waitForFunction(()=>window.motionLab?.state.trainSet);
  await page.evaluate(async name=>{
    const {examples}=await (await fetch('./'+name)).json();
    const {TrainingSet}=await import('./training-set.js');
    const set=new TrainingSet();set.fromJSON({version:3,examples});await set.save();
  },recordingName);
  console.log('Reloading and calibrating');
  await page.reload();await page.waitForFunction(()=>window.motionLab?.state.forkCal?.liveYaw,{timeout:60000});
  await page.locator('#sensorBtn').click();
  check('An unanswered optional compass permission cannot block granted motion recording',await page.locator('#recordBtn').isEnabled());
  await page.locator('#recordBtn').click();
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
  check('Relative movement never claims 100 percent arrival',!/100%/.test(await page.locator('#trackProgress').textContent()));
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
  check('Label sheet exposes a named dialog and contains background interaction',await page.evaluate(()=>document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')==='tripLabelTitle'&&document.querySelector('.app-shell').inert&&document.activeElement.dataset.answer==='skip'));
  await page.keyboard.press('Tab');
  check('Label sheet traps keyboard focus inside its choices',await page.locator('[data-answer="left"]').evaluate(el=>el===document.activeElement));
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!motionLab.state.finishing);
  check('Escape skips the label and restores the app controls',await page.evaluate(()=>!document.querySelector('[role="dialog"]')&&!document.querySelector('.app-shell').inert));
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
  const compass = await page.evaluate(()=>{
    const orientation = values=>dispatchEvent(Object.assign(new Event('deviceorientation'),values));
    const sample = ()=>{dispatchEvent(new DeviceMotionEvent('devicemotion'));return motionLab.state.data.at(-1);};
    orientation({webkitCompassHeading:-10,webkitCompassAccuracy:8});
    const fresh=sample();motionLab.state.lastOrientationAt-=1001;
    const stale=sample();
    orientation({webkitCompassHeading:30,webkitCompassAccuracy:8});
    orientation({webkitCompassHeading:null});
    return {fresh,stale,unavailable:sample()};
  });
  check('Compass normalizes bearings and never repeats stale or unavailable readings',compass.fresh.heading===350&&compass.fresh.headingAccuracy===8&&compass.stale.heading===null&&compass.stale.headingAccuracy===null&&compass.unavailable.heading===null);
  await page.evaluate(async()=>{const store=motionLab.state.sync.store;window.originalPut=store.put;store.put=async()=>{throw new Error('Simulated full storage');};await motionLab.protectRecording(false);});
  await page.setViewportSize({width:320,height:568});
  check('Storage failure during capture needs no extra touch controls',await page.evaluate(()=>!document.querySelector('#emergencyDownload')&&!document.querySelector('#retryLocalSave')&&document.querySelector('#saveStatus').getBoundingClientRect().bottom<=innerHeight));
  await page.locator('#recordBtn').click();await page.locator('[data-answer="skip"]').click();await page.waitForFunction(()=>!motionLab.state.finishing);
  await page.locator('#recordBtn').click();
  check('Unsaved recording cannot be overwritten by a new Start',await page.evaluate(()=>motionLab.state.memoryUnsaved&&!motionLab.state.recording&&!!document.querySelector('#retryLocalSave')));
  const rescueFile=await page.evaluate(()=>motionLab.state.nativeSave.file.name);
  await page.locator('#toolsGroup').evaluate(el=>{el.open=true;});
  await page.locator('.local-recording button').first().click();
  check('Selecting history cannot replace the rescue file of an unsaved recording',await page.evaluate(name=>motionLab.state.nativeSave.file.name===name&&document.querySelector('#saveStatus').textContent.includes('Retry saving the current recording'),rescueFile));
  await page.locator('#toolsGroup').evaluate(el=>{el.open=false;});
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});
    document.querySelector('#emergencyDownload').remove();
  });
  await page.locator('#recordBtn').click();
  const downloadReady=await page.locator('#emergencyDownload').textContent();
  check('Unsaved recording offers a working download when native sharing is unavailable',downloadReady==='Download unsaved recording'&&await page.locator('#emergencyDownload').isEnabled());
  const download=page.waitForEvent('download');await page.locator('#emergencyDownload').click();
  check('Emergency download contains the current recording filename',(await download).suggestedFilename()===rescueFile);
  await page.evaluate(()=>{motionLab.state.sync.store.put=window.originalPut;});
  await page.locator('#retryLocalSave').click();await page.waitForFunction(()=>!motionLab.state.memoryUnsaved);
  check('Failed local save can be retried without losing samples',await page.evaluate(async()=>{const row=await motionLab.state.sync.getRecording(motionLab.state.recordingId);return row.complete&&row.payload.rawMotionData.length>0&&!document.querySelector('#retryLocalSave');}));
  // Delay the real history reads used by recalibration, then begin a journey.
  // Its confidence and position reference must remain fixed until Finish.
  await page.evaluate(()=>{
    const s=motionLab.state;
    window.beforeCalibration=s.forkCal;window.beforeReference=s.trackReference;
    window.originalRawRead=s.trainSet.getRawMotionData;
    const gate=new Promise(resolve=>{window.releaseCalibration=resolve;});
    window.calibrationReads=0;
    s.trainSet.getRawMotionData=async function(id){window.calibrationBlocked=true;await gate;const raw=await originalRawRead.call(this,id);window.calibrationReads++;return raw;};
    Object.defineProperty(navigator,'wakeLock',{configurable:true,value:{request:()=>new Promise(resolve=>{window.resolveWakeLock=resolve;})}});
  });
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('.recording-delete').first().click();
  await page.waitForFunction(()=>window.calibrationBlocked);
  await page.locator('#recordBtn').click();
  await page.evaluate(()=>window.releaseCalibration());
  await page.waitForFunction(()=>window.calibrationReads===motionLab.state.trainSet.count());
  check('A calibration finishing after Start cannot change the active journey',await page.evaluate(()=>motionLab.state.forkCal===beforeCalibration&&motionLab.state.trackReference===beforeReference&&motionLab.state.calibrationDeferred));
  await page.evaluate(()=>{motionLab.state.trainSet.getRawMotionData=originalRawRead;});
  await page.locator('#recordBtn').click();
  await page.waitForFunction(()=>!motionLab.state.finishing||document.querySelector('[data-answer="skip"]'));
  if (await page.locator('[data-answer="skip"]').count()) await page.locator('[data-answer="skip"]').click();
  await page.waitForFunction(()=>!motionLab.state.finishing);
  check('Deferred calibration is applied after Finish for the next journey',await page.evaluate(()=>!motionLab.state.calibrationDeferred&&motionLab.state.forkCal!==beforeCalibration));
  await page.evaluate(()=>{
    window.lateWakeLock={released:false,release:async function(){this.released=true;}};
    window.resolveWakeLock(lateWakeLock);
  });
  await page.waitForFunction(()=>window.lateWakeLock.released);
  check('A screen wake lock granted after Finish is released immediately',await page.evaluate(()=>!motionLab.state.wakeLock&&lateWakeLock.released));
  check('No uncaught browser errors',errors.length===0);
  check('Native-only recording and saving never contact an extra backend',apiRequests.length===0);
  // Cache installed shell, then prove full offline reload initializes modules.
  await page.evaluate(async()=>{await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Offline shell did not install')),15000))]);});
  await page.context().setOffline(true);await page.reload();await page.waitForFunction(()=>motionLab?.state.sync);
  check('Offline app-shell reload initializes local recording store',await page.evaluate(()=>!!motionLab.state.sync));
  await fs.writeFile(path.join(out,'browser-results.json'),JSON.stringify({checks,errors,replay},null,2));
  console.log(`${checks.length} browser checks passed; screenshots in test-results/`);
}finally{await browser.close();server.close();}
