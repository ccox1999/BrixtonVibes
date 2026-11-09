// Real legacy-v38 -> current app migration, isolated from personal browser data.
// Run: node tools/test-update.mjs [recovery-page.html]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentWorker = await fs.readFile(path.join(root, 'sw.js'), 'utf8');
const currentRelease = /brixtonvibes-v(\d+)/.exec(currentWorker)?.[1];
const engineSource = await fs.readFile(path.join(root, 'fork-engine.js'), 'utf8');
const engineVersion = Number(/export const FORK_ENGINE_VERSION\s*=\s*(\d+)/.exec(engineSource)?.[1]);
assert.ok(currentRelease && Number.isInteger(engineVersion), 'Current release and engine version must be declared');
const recoveryPage = process.argv[2] || `update.html?release=${currentRelease}`;
const mount = '/BrixtonVibes/';
const legacyCommit = '5800ff2';
const types = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png' };
const oldFiles = new Map();
let serving = 'legacy';
const checks = [], errors = [];
function check(name, value) { assert.ok(value, name); checks.push(name); console.log('PASS', name); }
function legacy(name) {
  if (!oldFiles.has(name)) {
    try { oldFiles.set(name, execFileSync('git', ['show', `${legacyCommit}:${name}`], { cwd:root, stdio:['ignore','pipe','ignore'] })); }
    catch { oldFiles.set(name, null); }
  }
  return oldFiles.get(name);
}
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (!pathname.startsWith(mount)) { res.writeHead(404); res.end(); return; }
    const name = pathname.slice(mount.length) || 'index.html';
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    let body = serving === 'legacy' ? legacy(name) : await fs.readFile(target);
    if (!body) { res.writeHead(404); res.end(); return; }
    // A later worker with identical shell bytes still exercises the update
    // lifecycle and must never navigate a currently recording client.
    if (serving.startsWith('future') && name === 'sw.js') body = Buffer.from(body.toString().replace(/(const CACHE_VERSION\s*=\s*["'])([^"']+)/, `$1$2-next-test-${serving}`));
    // Prime a genuinely fresh HTTP-cache entry as well as CacheStorage. A
    // versioned worker name alone must not reuse the old unversioned modules.
    const cacheControl = serving === 'legacy' && ['fork-engine.js','features.js','style.css','app.js'].includes(name)
      ? 'public, max-age=3600' : 'no-store';
    res.writeHead(200, { 'Content-Type':types[path.extname(name)] || 'application/octet-stream', 'Cache-Control':cacheControl });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${mount}`;
const browser = await chromium.launch({ channel:'msedge', headless:true, args:['--disable-extensions','--disable-sync'] });
const context = await browser.newContext({ viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.dismiss());
await page.addInitScript(() => { window.updateTestPageInstance = Math.random().toString(36); });

async function waitForWorker() {
  await page.evaluate(async () => {
    const ready = navigator.serviceWorker.ready;
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Worker did not become ready')), 15000))]);
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout:15000 });
}
async function dataStillPresent() {
  return page.evaluate(async () => {
    const { getRaw } = await import('./raw-store.js');
    const raw = await getRaw('update-retained-trip');
    const set = JSON.parse(localStorage.getItem('victoria-line-training-set'));
    return localStorage.getItem('update-regression-sentinel') === 'must-survive' && raw?.length === 120 && raw[0].ax === .123 && set.examples.some(e => e.recordingId === 'update-retained-trip');
  });
}
async function startAndFeed() {
  await page.locator('#sensorBtn').click();
  await page.locator('#recordBtn').click();
  return page.evaluate(() => {
    dispatchEvent(new DeviceMotionEvent('devicemotion', {
      acceleration:{x:.17,y:.02,z:.03},
      accelerationIncludingGravity:{x:.17,y:.02,z:9.84},
      rotationRate:{alpha:.01,beta:.02,gamma:.03}, interval:16,
    }));
    return { instance:updateTestPageInstance, samples:motionLab.state.data.length };
  });
}
async function requestWorkerUpdate() {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
  }).catch(error => {
    // A safe idle reload can destroy the update() call's page context.
    if (!/Execution context was destroyed|navigation|Target closed/i.test(error.message)) throw error;
  });
}
async function allowActivationCallbacks() {
  // A negative safety assertion must give delayed controllerchange/activation
  // handlers a chance to run; otherwise it can pass before an unsafe reload.
  await page.waitForTimeout(1500);
}
try {
  await page.goto(base);
  await page.waitForFunction(() => window.motionLab?.state.trainSet);
  await waitForWorker();
  await page.reload();
  await page.waitForFunction(() => window.motionLab?.state.trainSet);
  check('Legacy v38 app and offline shell really installed', await page.evaluate(async () => !!document.getElementById('forecastLeft') && !document.getElementById('trackView') && (await caches.keys()).includes('brixtonvibes-v38')));
  await page.evaluate(async () => {
    localStorage.setItem('update-regression-sentinel', 'must-survive');
    const raw = Array.from({length:120}, (_, i) => ({time:Date.now()+i*17,ax:.123,ay:.02,az:.03,gx:0,gy:0,gz:9.81,rotationAlpha:.01,rotationBeta:.02,rotationGamma:.03}));
    motionLab.state.trainSet.add({accel_mag_mean:.125}, 'left', {recordingId:'update-retained-trip',timestamp:Date.now(),rawMotionData:raw,featureVersion:6,duration:2,sampleCount:120});
    await motionLab.state.trainSet.save();
  });
  check('Real localStorage and raw IndexedDB recording seeded', await dataStillPresent());

  const legacyCapture = await startAndFeed();
  check('Legacy sensor recording contains an unsaved sample', legacyCapture.samples > 0);
  serving = 'current';
  await requestWorkerUpdate();
  // Worker install + activation is asynchronous. Wait on its actual lifecycle,
  // not a fixed sleep, while retaining the live page's current recording.
  await page.waitForFunction(async () => (await caches.keys()).some(key => key.startsWith('brixtonvibes-') && key !== 'brixtonvibes-v38'), null, {timeout:20000});
  await allowActivationCallbacks();
  const legacyAfter = await page.evaluate(() => ({instance:updateTestPageInstance,recording:motionLab.state.recording,samples:motionLab.state.data.length}));
  check('Updating the worker never reloads or drops a legacy live recording', legacyAfter.instance === legacyCapture.instance && legacyAfter.recording && legacyAfter.samples >= legacyCapture.samples);
  check('Worker replacement preserves the previously saved journey', await dataStillPresent());

  // Finish/label before navigating explicitly to recovery. Never deliberately
  // navigate away from an in-progress recording in the migration check.
  await page.locator('#recordBtn').click();
  await page.locator('[data-answer="left"]').click();
  await page.waitForFunction(() => motionLab.state.trainSet.count() === 2);
  await page.evaluate(() => motionLab.state.trainSet.save());
  await page.goto(base + recoveryPage);
  await page.waitForFunction(() => !!document.querySelector('#trackView svg') && !!window.motionLab?.state.sync, null, {timeout:30000});
  check('Explicit update entry replaces cached v38 UI with the real track view', await page.locator('#trackView svg').isVisible());
  check('Migration preserves labelled training metadata and raw samples', await dataStillPresent());
  check('New precache bypasses still-fresh legacy HTTP cache for unversioned modules', await page.evaluate(async expected => (await import('./fork-engine.js')).FORK_ENGINE_VERSION === expected, engineVersion));
  await waitForWorker();

  // An idle reload must resolve to the new shell, not the old cache again.
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('#trackView svg') && !!window.motionLab?.state.sync, null, {timeout:20000});
  check('Subsequent normal reload keeps the updated UI', await page.locator('#trackView svg').isVisible());
  check('Normal reload also preserves personal recordings', await dataStillPresent());

  const idleInstance = await page.evaluate(() => updateTestPageInstance);
  serving = 'future-idle';
  await requestWorkerUpdate();
  await page.waitForFunction(previous => window.updateTestPageInstance !== previous && !!document.querySelector('#trackView svg') && !!window.motionLab?.state.sync, idleInstance, {timeout:20000});
  check('A safe idle worker update automatically opens the coherent new shell', await page.evaluate(previous => updateTestPageInstance !== previous && !motionLab.state.recording, idleInstance));
  check('Automatic idle refresh preserves saved training and raw data', await dataStillPresent());

  const currentCapture = await startAndFeed();
  serving = 'future-recording';
  await requestWorkerUpdate();
  await page.waitForFunction(async () => (await caches.keys()).some(key => key.includes('next-test-future-recording')), null, {timeout:20000});
  await allowActivationCallbacks();
  const currentAfter = await page.evaluate(() => ({instance:updateTestPageInstance,recording:motionLab.state.recording,samples:motionLab.state.data.length}));
  check('A later worker update also leaves current live recording untouched', currentAfter.instance === currentCapture.instance && currentAfter.recording && currentAfter.samples >= currentCapture.samples);
  check('Pending update controls stay hidden during sensor capture', !await page.locator('#updateNotice').isVisible());
  await page.locator('#recordBtn').click();
  await page.locator('[data-answer="skip"]').click();
  // finishing becomes false before the asynchronous history refresh completes.
  // The idle event updates the notice only after that work. Wait for the actual
  // visible state rather than racing the intermediate internal flag.
  await page.locator('#updateNotice').waitFor({state:'visible',timeout:10000});
  check('Finished trip is preserved and update waits for an explicit safe tap', await page.evaluate(previous => updateTestPageInstance === previous && motionLab.state.latestRecordingDurable && !document.querySelector('#updateNotice').classList.contains('hidden'), currentCapture.instance));
  const finishedId = await page.evaluate(() => motionLab.state.recordingId);
  await page.locator('#applyUpdateBtn').click();
  await page.waitForFunction(previous => window.updateTestPageInstance !== previous && !!document.querySelector('#trackView svg') && !!window.motionLab?.state.sync, currentCapture.instance, {timeout:20000});
  check('Explicit post-recording update retains the newly completed raw recording', await page.evaluate(async id => {
    const row = await motionLab.state.sync.getRecording(id);
    return row?.complete && row.payload.rawMotionData.length > 0;
  }, finishedId));
  await waitForWorker();
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('#trackView svg') && !!window.motionLab?.state.sync, null, {timeout:20000});
  check('Updated app and local recording store reopen offline', await page.locator('#trackView svg').isVisible());
  check('All existing personal recording data still survives offline startup', await dataStillPresent());
  check('No uncaught app errors during old-to-new migration', errors.length === 0);
  await fs.mkdir(path.join(root, 'test-results'), {recursive:true});
  await page.screenshot({path:path.join(root, 'test-results', 'iphone-updated-from-v38.png')});
  await fs.writeFile(path.join(root, 'test-results', 'update-results.json'), JSON.stringify({legacyCommit,recoveryPage,checks,errors},null,2)+'\n');
  console.log(`${checks.length} upgrade checks passed.`);
} catch (error) {
  const diagnostic = await page.evaluate(() => ({
    url:location.pathname+location.search,
    instance:window.updateTestPageInstance,
    recording:window.motionLab?.state.recording,
    finishing:window.motionLab?.state.finishing,
    durable:window.motionLab?.state.latestRecordingDurable,
    unsaved:window.motionLab?.state.memoryUnsaved,
    sampleCount:window.motionLab?.state.data.length,
    shareBusy:window.motionLab?.state.nativeSave?.busy,
    noticeClass:document.getElementById('updateNotice')?.className,
    noticeText:document.getElementById('updateNotice')?.textContent,
    warning:document.getElementById('sensorWarning')?.textContent,
  })).catch(readError=>({readError:readError.message}));
  console.error('Upgrade failure state:',JSON.stringify({serving,diagnostic,errors},null,2));
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
