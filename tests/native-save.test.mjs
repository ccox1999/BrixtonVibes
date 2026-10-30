import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeRecordingSave} from '../native-save.js';
const blob=()=>new Blob(['{"version":3,"examples":[]}'],{type:'application/json'});
const name='victoria-recording-test-id.json';
test('native save invokes the OS directly in the click turn and sends actual bytes',async()=>{
  let called=false;let file;
  const save=new NativeRecordingSave({navigatorRef:{canShare:()=>true,share:data=>{called=true;file=data.files[0];return Promise.resolve();}}});
  save.prepare(blob(),name);const pending=save.share();assert.equal(called,true);
  assert.equal(file.name,name);assert.equal(JSON.parse(await file.text()).version,3);
  assert.deepEqual(await pending,{handedOff:true,cloudUploadConfirmed:false});
});
test('cancelling the system sheet keeps the prepared file available for retry',async()=>{
  const statuses=[];let cancelled=true;
  const save=new NativeRecordingSave({navigatorRef:{canShare:()=>true,share:()=>cancelled?Promise.reject(new DOMException('Cancelled','AbortError')):Promise.resolve()},onStatus:s=>statuses.push(s.state)});
  save.prepare(blob(),name);assert.equal((await save.share()).cancelled,true);assert.ok(save.file);
  cancelled=false;assert.equal((await save.share()).handedOff,true);assert.ok(statuses.includes('cancelled'));
});
test('failure is visible and never deletes the local copy or pretends cloud delivery',async()=>{
  const save=new NativeRecordingSave({navigatorRef:{canShare:()=>true,share:()=>Promise.reject(new Error('Provider unavailable'))}});
  save.prepare(blob(),name);await assert.rejects(save.share(),/Provider unavailable/);assert.ok(save.file);assert.equal(save.busy,false);
});
test('unsupported browsers do not silently fall back to a download or a URL-only share',async()=>{
  let called=false;const save=new NativeRecordingSave({navigatorRef:{canShare:()=>false,share:()=>{called=true;}}});
  assert.equal(save.prepare(blob(),name),false);await assert.rejects(save.share(),/unavailable/);assert.equal(called,false);
});
test('no file sharing or system interaction can start during sensor recording',async()=>{
  let called=false;const save=new NativeRecordingSave({navigatorRef:{canShare:()=>true,share:()=>{called=true;}}});
  save.prepare(blob(),name);save.setRecording(true);await assert.rejects(save.share(),/Finish/);assert.equal(called,false);
});
test('text MIME compatibility preserves .json filename and JSON bytes',async()=>{
  const save=new NativeRecordingSave({navigatorRef:{canShare:({files})=>files[0].type==='text/plain',share:()=>Promise.resolve()}});
  assert.equal(save.prepare(blob(),name),true);assert.equal(save.file.type,'text/plain');assert.equal(save.file.name,name);assert.equal(await save.file.text(),await blob().text());
});
test('overlapping shares are rejected until the current sheet closes',async()=>{
  let finish;const save=new NativeRecordingSave({navigatorRef:{canShare:()=>true,share:()=>new Promise(r=>finish=r)}});
  save.prepare(blob(),name);const pending=save.share();await assert.rejects(save.share(),/already open/);finish();await pending;
});
