import test from "node:test";
import assert from "node:assert/strict";
import { OneDriveSync, IndexedDBRecordingStore, recordingExport, recordingFilename, recordingMetadata } from "./onedrive-sync.js";
import { handleRequest, seal, unseal, validateOwner, checkMutation, verifyMicrosoftIdToken } from "./onedrive-worker/worker.mjs";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";

class MemoryStore {
  constructor() { this.rows = new Map(); }
  async get(id) { return structuredClone(this.rows.get(id)); }
  async put(row) { this.rows.set(row.id, structuredClone(row)); }
  async list() { return structuredClone([...this.rows.values()]); }
  async getMetadata(id) { const row = this.rows.get(id); return row ? recordingMetadata(row) : undefined; }
  async listMetadata() { return [...this.rows.values()].map(recordingMetadata); }
}
const payload = (complete = true) => ({ recordingId: "trip_1", rawMotionData: [{ time: 1, ax: 0, ay: 0, az: 0 }], complete });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const sleepTick = () => new Promise(resolve => setTimeout(resolve, 10));
function client(options = {}) {
  return new OneDriveSync({ store: new MemoryStore(), online: () => false, ...options });
}

test('native-only app mode never requests a backend or authentication service', async () => {
  let calls=0;
  const sync=client({nativeOnly:true,online:()=>true,fetchImpl:async()=>{calls++;throw new Error('No backend allowed');}});
  await sync.init();sync.setRecording(true);await sync.saveRecording(payload(false));
  await sync.saveRecording(payload(true));sync.setRecording(false);await sync.retry();await sync.refreshStatus();
  await assert.rejects(sync.connect(), /system share screen/);
  await assert.rejects(sync.disconnect(), /system share screen/);
  assert.equal(calls,0);assert.equal(sync.getStatus().configured,false);
  assert.equal((await sync.getRecording('trip_1')).complete,true);sync.destroy();
});

test("journal storage retries a synchronous IndexedDB opening failure", async () => {
  const previous = globalThis.indexedDB;
  let calls = 0;
  const db = { close() {} };
  globalThis.indexedDB = { open() {
    if (++calls === 1) throw new Error("temporarily unavailable");
    const request = { result: db };
    queueMicrotask(() => request.onsuccess());
    return request;
  } };
  try {
    const store = new IndexedDBRecordingStore();
    await assert.rejects(store.open(), /temporarily unavailable/);
    assert.equal(await store.open(), db);
    assert.equal(calls, 2);
  } finally { globalThis.indexedDB = previous; }
});

test("journal storage closes late connections after a blocked opening", async () => {
  const previous = globalThis.indexedDB;
  let request, closed = false;
  globalThis.indexedDB = { open() { request = { result: { close() { closed = true; } } }; queueMicrotask(() => request.onblocked()); return request; } };
  try {
    const store = new IndexedDBRecordingStore();
    await assert.rejects(store.open(), /other app tab/);
    request.onsuccess();
    assert.equal(closed, true);
    assert.equal(store.db, undefined);
  } finally { globalThis.indexedDB = previous; }
});

test("concurrent recording patches preserve both changes and ordered revisions", async () => {
  const sync = client(); await sync.saveRecording(payload());
  await Promise.all([
    sync.updateRecording("trip_1", { label: "right" }),
    sync.updateRecording("trip_1", { notes: "arrived" })
  ]);
  const row = await sync.getRecording("trip_1");
  assert.equal(row.payload.label, "right");
  assert.equal(row.payload.notes, "arrived");
  assert.equal(row.revision, 3);
  sync.destroy();
});

test("an HTTP success without explicit upload acknowledgement remains pending", async () => {
  const sync = client(); await sync.saveRecording(payload());
  sync.online = () => true; sync.status.authenticated = true;
  sync.fetch = async () => response({ message: "proxy login" });
  await sync.retry();
  assert.equal((await sync.getRecording("trip_1")).uploadedRevision, undefined);
  assert.equal(sync.getStatus().pending, 1);
  assert.match(sync.getStatus().message, /not confirmed/);
  sync.destroy();
});

test("HTTP-date throttling delays retry for the full server interval", async () => {
  const now = Date.parse("2026-11-08T20:00:00Z");
  const sync = client({ now: () => now }); await sync.saveRecording(payload());
  sync.online = () => true; sync.status.authenticated = true;
  sync.fetch = async () => response({}, 429, { "Retry-After": new Date(now + 120000).toUTCString() });
  await sync.retry();
  assert.equal((await sync.getRecording("trip_1")).nextAttemptAt, now + 120000);
  sync.destroy();
});

test("draft persists durably without upload; reload can recover raw samples", async () => {
  const store = new MemoryStore(); let calls = 0;
  const sync = client({ store, fetchImpl: async () => { calls++; throw Error("offline"); } });
  sync.setRecording(true);
  assert.equal((await sync.saveRecording(payload(false))).durable, true);
  const next = client({ store });
  assert.equal((await next.getRecording("trip_1")).payload.rawMotionData.length, 1);
  assert.equal((await next.listRecordings())[0].complete, false);
  assert.equal(calls, 0);
  sync.destroy(); next.destroy();
});

test("storage failure rejects rather than falsely claiming saved or uploading", async () => {
  let sent = false;
  const sync = client({ store: { getMetadata: async () => null, put: async () => { throw Error("quota"); } }, fetchImpl: async () => { sent = true; } });
  await assert.rejects(sync.saveRecording(payload()), /quota/);
  assert.equal(sent, false);
});

test("network failure retains complete recording and queues retry", async () => {
  const sync = client(); await sync.saveRecording(payload());
  sync.online = () => true; sync.status.authenticated = true;
  sync.fetch = async () => { throw Error("network interrupted"); };
  await sync.retry();
  const row = await sync.getRecording("trip_1");
  assert.equal(row.payload.rawMotionData.length, 1);
  assert.equal(row.uploadedRevision, undefined);
  assert.equal(sync.getStatus().pending, 1);
  sync.destroy();
});

test("expired authentication preserves file and stops automatic auth navigation", async () => {
  const sync = client(); await sync.saveRecording(payload());
  sync.online = () => true; sync.status.authenticated = true;
  sync.fetch = async () => response({}, 401);
  await sync.retry();
  assert.equal(sync.getStatus().authenticated, false);
  assert.equal((await sync.getRecording("trip_1")).complete, true);
  sync.destroy();
});

test("draft never uploads, finish does, repeated success retains local copy", async () => {
  const sent = [];
  const sync = client(); await sync.saveRecording(payload(false));
  sync.online = () => true; sync.status.authenticated = true;
  sync.fetch = async (url, opts) => { sent.push([url, opts]); return response({ uploaded: true }); };
  await sync.retry(); assert.equal(sent.length, 0);
  sync.setRecording(true); await sync.saveRecording(payload(true)); sync.setRecording(false);
  while (sync.running) await sleepTick();
  await sync.retry(); await sync.retry();
  assert.equal(sent.length, 1);
  assert.equal(sync.getStatus().pending, 0);
  assert.equal((await sync.getRecording("trip_1")).payload.rawMotionData.length, 1);
  assert.equal((await sync.listRecordings()).length, 1);
  sync.destroy();
});

test("label saved during upload remains pending until newer revision uploads", async () => {
  const sync = client(); await sync.saveRecording(payload());
  sync.online = () => true; sync.status.authenticated = true;
  let release;
  sync.fetch = () => new Promise(resolve => { release = () => resolve(response({ uploaded: true })); });
  const pending = sync.retry();
  while (!release) await sleepTick();
  await sync.updateRecording("trip_1", { label: "right" });
  release(); await pending;
  const row = await sync.getRecording("trip_1");
  assert.equal(row.revision, 2);
  assert.equal(row.uploadedRevision, 1);
  assert.equal(row.payload.label, "right");
  assert.equal(sync.getStatus().pending, 1);
  sync.destroy();
});

test("authentication and upload are blocked during recording", async () => {
  let calls = 0;
  const sync = client({ online: () => true, fetchImpl: async () => { calls++; return response({}); } });
  sync.setRecording(true); sync.status.authenticated = true;
  await sync.saveRecording(payload()); await sync.retry();
  await assert.rejects(sync.connect(), /Finish recording/);
  await assert.rejects(sync.disconnect(), /Finish recording/);
  assert.equal(calls, 0);
  sync.destroy();
});

test("autosaves and Finish serialize, and download is a complete portable backup", async () => {
  const sync = client();
  const draft = sync.saveRecording(payload(false));
  const finish = sync.saveRecording({ ...payload(true), label: "left" });
  await Promise.all([draft, finish]);
  assert.equal((await sync.getRecording("trip_1")).complete, true);
  const { blob, filename } = await sync.downloadRecording("trip_1");
  const exported = JSON.parse(await blob.text());
  assert.equal(filename, "victoria-recording-trip_1.json");
  assert.equal(exported.examples[0].label, "left");
  assert.equal(exported.examples[0].rawMotionData.length, 1);
  assert.throws(() => recordingFilename("../oops"));
  sync.destroy();
});

test("init, autosave counts and history listing read metadata without loading historical raw recordings", async () => {
  const store = new MemoryStore();
  for (let i = 0; i < 42; i++) {
    await store.put({ id: `history-${i}`, payload: { recordingId: `history-${i}`, rawMotionData: Array(12000).fill({ time: i, ax: 0 }) }, complete: true, revision: 1, uploadedRevision: 1, updatedAt: i });
  }
  let rawReads = 0;
  store.get = async () => { rawReads++; throw new Error("Raw historical recording must not be read during autosave"); };
  store.list = async () => { rawReads++; throw new Error("Raw getAll must never be used"); };
  const sync = client({ store });
  await sync.init();
  sync.setRecording(true);
  await sync.saveRecording(payload(false));
  await sync.saveRecording(payload(false));
  const rows = await sync.listRecordings();
  assert.equal(rows.length, 43);
  assert.equal(rows.some(row => "payload" in row), false);
  assert.equal(rawReads, 0);
  assert.equal(sync.getStatus().saved, 43);
  sync.destroy();
});

class FakeD1 {
  constructor() { this.rows = new Map(); }
  prepare(sql) {
    const db = this;
    return { bind(...args) { return {
      async run() {
        if (sql.startsWith("INSERT")) db.rows.set(args[0], { kind: args[1], secret: args[2], expires: args[3] });
        if (sql.startsWith("DELETE")) db.rows.delete(args[0]);
        return {};
      },
      async first() {
        const row = db.rows.get(args[0]);
        return row && row.kind === args[1] && row.expires > args[2] ? row : null;
      }
    }; } };
  }
}
const env = () => ({ DB: new FakeD1(), APP_ORIGIN: "https://brixton.example", MICROSOFT_CLIENT_ID: "public-id", MICROSOFT_CLIENT_SECRET: "server-only-secret", TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"), ALLOWED_OBJECT_ID: "owner-object", ALLOWED_TENANT_ID: "9188040d-6c67-4c5b-b112-36a304b66dad" });
const request = (path, method = "GET", opts = {}) => new Request(`https://brixton.example/api/onedrive/${path}`, { method, ...opts, headers: { Origin: "https://brixton.example", "X-BrixtonVibes": "1", "Sec-Fetch-Site": "same-origin", ...opts.headers } });

async function authenticated(e, { wrongOwner = false } = {}) {
  const start = await handleRequest(request("connect", "POST"), e);
  const login = new URL((await start.json()).url);
  const authCookie = start.headers.get("set-cookie").split(";")[0];
  const result = await handleRequest(request(`callback?state=${login.searchParams.get("state")}&code=code`, "GET", { headers: { Cookie: authCookie } }), e, {
    fetchImpl: async () => response({ access_token: "server-access-token", refresh_token: "server-refresh-token", id_token: "signed-id-token", expires_in: 3600, scope: "Files.ReadWrite.AppFolder" }),
    verifyIdToken: async () => ({ nonce: login.searchParams.get("nonce"), oid: wrongOwner ? "attacker-object" : e.ALLOWED_OBJECT_ID, tid: e.ALLOWED_TENANT_ID })
  });
  return { result, cookie: result.headers.getSetCookie().find(x => x.startsWith("__Host-bv_session="))?.split(";")[0], login };
}

test("server encrypts credentials at rest and rejects wrong keys", async () => {
  const e = env(); const value = await seal({ refresh: "sensitive" }, e);
  assert.equal(value.includes("sensitive"), false);
  assert.deepEqual(await unseal(value, e), { refresh: "sensitive" });
  await assert.rejects(unseal(value, { ...e, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64url") }));
});

test("credential encryption handles payloads beyond JavaScript argument limits", async () => {
  const e = env(), large = { refresh: "x".repeat(200000) };
  assert.deepEqual(await unseal(await seal(large, e), e), large);
});

test("Microsoft identity validation rejects invalid signatures, audience, issuer and expired tokens", async () => {
  const e = env();
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey); jwk.kid = "test-key";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const claims = { oid: e.ALLOWED_OBJECT_ID, tid: e.ALLOWED_TENANT_ID, nonce: "nonce" };
  const sign = (options = {}) => new SignJWT({ ...claims, ...options.claims }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuedAt().setSubject("subject").setIssuer(options.issuer || `https://login.microsoftonline.com/${e.ALLOWED_TENANT_ID}/v2.0`).setAudience(options.audience || e.MICROSOFT_CLIENT_ID).setExpirationTime(options.expiration || "1h").sign(privateKey);
  const valid = await sign();
  assert.equal((await verifyMicrosoftIdToken(valid, e, keys)).oid, e.ALLOWED_OBJECT_ID);
  await assert.rejects(verifyMicrosoftIdToken(await sign({ audience: "other-app" }), e, keys));
  await assert.rejects(verifyMicrosoftIdToken(await sign({ issuer: "https://evil.example" }), e, keys));
  await assert.rejects(verifyMicrosoftIdToken(await sign({ expiration: Math.floor(Date.now() / 1000) - 3600 }), e, keys));
  const parts = valid.split("."); parts[1] = Buffer.from(JSON.stringify({ ...claims, aud: "forged" })).toString("base64url");
  await assert.rejects(verifyMicrosoftIdToken(parts.join("."), e, keys));
});

test("server requires exact owner, tenant and same-origin CSRF protection", async () => {
  const e = env();
  assert.equal(validateOwner({ oid: e.ALLOWED_OBJECT_ID, tid: e.ALLOWED_TENANT_ID }, e), true);
  assert.equal(validateOwner({ oid: "other", tid: e.ALLOWED_TENANT_ID }, e), false);
  assert.equal(validateOwner(null, e), false);
  assert.equal(validateOwner({ oid: e.ALLOWED_OBJECT_ID, tid: 42 }, e), false);
  assert.equal(checkMutation(request("connect", "POST", { headers: { Origin: "https://evil.example" } }), e), false);
  assert.equal((await handleRequest(request("connect", "POST", { headers: { Origin: "https://evil.example" } }), e)).status, 403);
  assert.equal((await handleRequest(request("recordings/trip_1", "PUT"), e)).status, 401);
  const wrong = await authenticated(e, { wrongOwner: true });
  assert.equal(wrong.result.status, 403);
  assert.equal(wrong.cookie, undefined);
});

test("OAuth uses PKCE and nonce, sessions are HttpOnly, tokens never returned", async () => {
  const e = env(); const { result, cookie: sessionCookie, login } = await authenticated(e);
  assert.equal(result.status, 303);
  assert.equal(login.searchParams.get("code_challenge_method"), "S256");
  assert.equal(login.searchParams.has("nonce"), true);
  assert.equal(login.searchParams.has("client_secret"), false);
  assert.match(result.headers.get("set-cookie"), /HttpOnly/);
  assert.match(result.headers.get("set-cookie"), /Secure/);
  const status = await handleRequest(request("status", "GET", { headers: { Cookie: sessionCookie } }), e);
  assert.deepEqual(await status.json(), { configured: true, authenticated: true });
  assert.equal(JSON.stringify([...e.DB.rows.values()]).includes("server-access-token"), false);
});

test("upload is restricted to appfolder, renews token once, and retains no raw in D1", async () => {
  const e = env(); const { cookie: sessionCookie } = await authenticated(e);
  const calls = []; let uploads = 0;
  const uploaded = await handleRequest(request("recordings/trip_1", "PUT", { headers: { Cookie: sessionCookie, "Content-Type": "application/json" }, body: JSON.stringify(recordingExport(payload())) }), e, { fetchImpl: async (url, opts) => {
    calls.push([url, opts]);
    if (url.includes("/token")) return response({ access_token: "renewed-access", refresh_token: "renewed-refresh", expires_in: 3600, scope: "Files.ReadWrite.AppFolder" });
    uploads++;
    return uploads === 1 ? response({}, 401) : response({ size: 123 });
  } });
  assert.equal(uploaded.status, 200);
  assert.equal(uploads, 2);
  assert.equal(calls.filter(([url]) => url.includes("/token")).length, 1);
  assert.ok(calls.filter(([url]) => url.includes("graph.microsoft.com")).every(([url]) => url.includes("/me/drive/special/approot:/victoria-recording-trip_1.json:/content")));
  assert.deepEqual(await uploaded.json(), { uploaded: true, filename: "victoria-recording-trip_1.json", size: 123 });
  assert.equal(JSON.stringify([...e.DB.rows.values()]).includes("rawMotionData"), false);
});

test("server rejects incomplete, mismatched, oversized and invalid recording data", async () => {
  const e = env(); const { cookie: sessionCookie } = await authenticated(e);
  const send = value => handleRequest(request("recordings/trip_1", "PUT", { headers: { Cookie: sessionCookie, "Content-Type": "application/json" }, body: JSON.stringify(value) }), e);
  assert.equal((await send(recordingExport(payload(false)))).status, 400);
  assert.equal((await send({ version: 3, complete: true, recordingId: "trip_1" })).status, 400);
  assert.equal((await send({ ...recordingExport(payload()), recordingId: "different" })).status, 400);
  for (const bad of [null, 42, [], { time: "1" }]) {
    const malformed = recordingExport(payload()); malformed.examples[0].rawMotionData = [bad];
    assert.equal((await send(malformed)).status, 400);
  }
  const tooLarge = await handleRequest(request("recordings/trip_1", "PUT", { headers: { Cookie: sessionCookie, "Content-Type": "application/json", "Content-Length": String(13 * 1024 * 1024) }, body: "{}" }), e);
  assert.equal(tooLarge.status, 413);
});

test("logout revokes server session while browser queue is independent", async () => {
  const e = env(); const { cookie: sessionCookie } = await authenticated(e);
  assert.equal((await handleRequest(request("disconnect", "POST", { headers: { Cookie: sessionCookie } }), e)).status, 200);
  const status = await handleRequest(request("status", "GET", { headers: { Cookie: sessionCookie } }), e);
  assert.equal((await status.json()).authenticated, false);
});
