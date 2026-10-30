// Real IndexedDB schema-upgrade and atomic metadata/raw-write checks in Edge.
import { chromium } from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const source = await readFile(new URL("../onedrive-sync.js", import.meta.url));
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/onedrive-sync.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/onedrive-sync.js" ? source : "<!doctype html><title>Journal verification</title>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-extensions", "--disable-sync"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const legacy = await new Promise((resolve, reject) => {
      const request = indexedDB.open("brixtonvibes-recording-outbox", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("recordings", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const oldRow = { id: "legacy", complete: true, revision: 1, uploadedRevision: 1, payload: { recordingId: "legacy", label: "left", timestamp: 123, rawMotionData: Array(22000).fill({ time: 1, ax: 0.1 }) } };
    await new Promise((resolve, reject) => {
      const tx = legacy.transaction("recordings", "readwrite"); tx.objectStore("recordings").put(oldRow);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    legacy.close();
    const { IndexedDBRecordingStore, OneDriveSync } = await import("/onedrive-sync.js");
    const store = new IndexedDBRecordingStore();
    const migrated = await store.listMetadata();
    const recovered = await store.get("legacy");
    const sync = new OneDriveSync({ store, online: () => false });
    await sync.init(); sync.setRecording(true);
    await sync.saveRecording({ recordingId: "new-trip", complete: false, timestamp: 456, rawMotionData: [{ time: 2, ax: 0 }] });
    const meta = await store.getMetadata("new-trip"), raw = await store.get("new-trip");
    // The raw + metadata writes must commit together. Abort the transaction
    // immediately after the raw request is queued, before metadata can commit.
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...rest) {
      if (this.name === "recordingMetadata" && value.id === "abort-trip") { this.transaction.abort(); return undefined; }
      return nativePut.call(this, value, ...rest);
    };
    let aborted = false;
    try { await store.put({ ...oldRow, id: "abort-trip" }); } catch { aborted = true; }
    finally { IDBObjectStore.prototype.put = nativePut; }
    const absentRaw = await store.get("abort-trip"), absentMeta = await store.getMetadata("abort-trip");
    sync.destroy(); store.db.close();
    return { migrated: migrated.map(row => ({ ...row, bytes: JSON.stringify(row).length })), recoveredSamples: recovered.payload.rawMotionData.length, meta, rawSamples: raw.payload.rawMotionData.length, aborted, noPartialWrite: !absentRaw && !absentMeta };
  });
  assert.equal(result.migrated.length, 1);
  assert.equal(result.migrated[0].sampleCount, 22000);
  assert.ok(result.migrated[0].bytes < 500);
  assert.equal(result.recoveredSamples, 22000);
  assert.equal(result.meta.sampleCount, 1);
  assert.equal(result.meta.complete, false);
  assert.equal(result.rawSamples, 1);
  assert.equal(result.aborted, true);
  assert.equal(result.noPartialWrite, true);
  console.log("PASS real IndexedDB: legacy migration preserves raw data; metadata stays compact; autosave writes both stores; aborted save leaves no partial write");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
