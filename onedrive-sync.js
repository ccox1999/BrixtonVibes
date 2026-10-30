/* Durable recording journal and same-origin, cookie-authenticated upload queue.
 * No Microsoft credentials or bearer tokens ever enter this module. */
const DB_NAME = "brixtonvibes-recording-outbox";
const STORE = "recordings";
const META = "recordingMetadata";
const API = "/api/onedrive";
const clone = value => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));

export function recordingFilename(id) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid recording ID");
  return `victoria-recording-${id}.json`;
}

export function recordingMetadata(row) {
  const { payload, ...meta } = row;
  return { ...meta, label: payload?.label || null,
    sampleCount: payload?.rawMotionData?.length || 0,
    timestamp: payload?.timestamp ?? payload?.recordedAt,
    duration: payload?.duration };
}

export class IndexedDBRecordingStore {
  async open() {
    if (this.db) return this.db;
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 2); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(META)) {
          const metadata = db.createObjectStore(META, { keyPath: "id" });
          // One-time migration of an earlier journal: cursor reads only one
          // recording at a time, then all normal reads use compact metadata.
          const cursor = req.transaction.objectStore(STORE).openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (entry) { metadata.put(recordingMetadata(entry.value)); entry.continue(); }
          };
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        this.db.onversionchange = () => { this.db.close(); this.db = null; this.opening = null; };
        resolve(this.db);
      };
      req.onerror = () => { this.opening = null; reject(req.error || new Error("Recording storage unavailable")); };
      req.onblocked = () => { this.opening = null; reject(new Error("Close the other app tab to save recordings")); };
    });
    return this.opening;
  }
  async transaction(mode, operation, storeName = STORE) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = operation(tx.objectStore(storeName));
      let result;
      req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("Recording could not be saved"));
      tx.onabort = () => reject(tx.error || new Error("Recording save interrupted"));
    });
  }
  get(id) { return this.transaction("readonly", s => s.get(id)); }
  getMetadata(id) { return this.transaction("readonly", s => s.get(id), META); }
  listMetadata() { return this.transaction("readonly", s => s.getAll(), META); }
  async put(row) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, META], "readwrite");
      tx.objectStore(STORE).put(row);
      tx.objectStore(META).put(recordingMetadata(row));
      tx.oncomplete = () => resolve(row.id);
      tx.onerror = () => reject(tx.error || new Error("Recording could not be saved"));
      tx.onabort = () => reject(tx.error || new Error("Recording save interrupted"));
    });
  }
}

export class OneDriveSync {
  constructor({ store = new IndexedDBRecordingStore(), fetchImpl = globalThis.fetch?.bind(globalThis), onStatus = () => {}, now = () => Date.now(), online = () => globalThis.navigator?.onLine !== false, nativeOnly = false } = {}) {
    this.store = store; this.fetch = fetchImpl; this.onStatus = onStatus; this.now = now; this.online = online;
    this.status = { configured: false, authenticated: false, recording: false, pending: 0, drafts: 0, saved: 0, state: "local", message: "Recordings stay on this phone" };
    this.recording = false; this.running = false; this.timer = null; this.saveChain = Promise.resolve();
    this.nativeOnly = nativeOnly;
    this.onlineListener = () => { if (!this.recording) this.retry().catch(() => {}); };
    this.visibleListener = () => { if (globalThis.document?.visibilityState === "visible") this.onlineListener(); };
  }
  getStatus() { return { ...this.status }; }
  async request(url, options, timeout = 45000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer?.unref?.();
    try { return await this.fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
  emit(patch = {}) { Object.assign(this.status, patch, { recording: this.recording }); this.onStatus(this.getStatus()); }
  async counts() {
    const rows = await this.store.listMetadata();
    this.emit({ saved: rows.length, drafts: rows.filter(r => !r.complete).length, pending: rows.filter(r => r.complete && r.uploadedRevision !== r.revision).length });
    return rows;
  }
  async init() {
    await this.counts();
    globalThis.addEventListener?.("online", this.onlineListener);
    globalThis.document?.addEventListener("visibilitychange", this.visibleListener);
    await this.refreshStatus();
    if (this.status.authenticated) await this.retry();
    return this.getStatus();
  }
  async refreshStatus() {
    if (this.nativeOnly) {
      this.emit({configured:false,authenticated:false,state:'local',message:'Saved on this phone · use Save to OneDrive'});
      return this.getStatus();
    }
    if (!this.online() || this.recording) return this.getStatus();
    try {
      const response = await this.request(`${API}/status`, { credentials: "same-origin", cache: "no-store" }, 10000);
      // GitHub Pages deliberately has no backend. HTML/404 => local-only.
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        this.emit({ configured: false, authenticated: false, state: "local", message: "Saved on this phone · OneDrive setup available in the guide" });
        return this.getStatus();
      }
      const info = await response.json();
      this.emit({ configured: !!info.configured, authenticated: !!info.authenticated, state: info.authenticated ? "ready" : "local", message: info.authenticated ? "OneDrive connected" : info.configured ? "Connect OneDrive before your next recording" : "Saved on this phone · OneDrive setup required" });
    } catch {
      this.emit({ state: "offline", message: "Offline · recordings stay on this phone" });
    }
    return this.getStatus();
  }
  setRecording(value) {
    const wasRecording = this.recording;
    this.recording = !!value;
    if (this.recording) { clearTimeout(this.timer); this.timer = null; }
    this.emit();
    // Never navigate, ask for authentication, or start upload while recording.
    if (wasRecording && !this.recording) this.retry().catch(() => {});
  }
  async saveRecording(payload) {
    const id = String(payload.recordingId || "");
    recordingFilename(id);
    if (!Array.isArray(payload.rawMotionData) || !payload.rawMotionData.length) throw new Error("No sensor samples to save");
    const snapshot = clone(payload);
    // Serialize local revisions so Finish cannot race a preceding autosave.
    const work = this.saveChain.then(async () => {
      const old = await this.store.getMetadata(id);
      const row = { ...old, id, payload: snapshot, complete: snapshot.complete !== false, revision: (old?.revision || 0) + 1, createdAt: old?.createdAt || this.now(), updatedAt: this.now(), attempts: 0, nextAttemptAt: 0, lastError: null };
      await this.store.put(row); // transaction completed BEFORE any network work
      await this.counts();
      this.emit({ state: "saved", message: row.complete ? "Saved on this phone" : "Recording protected on this phone" });
      return { id, durable: true, revision: row.revision, complete: row.complete };
    });
    this.saveChain = work.catch(() => {});
    const result = await work;
    if (result.complete && !this.recording) this.retry().catch(() => {});
    return result;
  }
  async updateRecording(id, patch) {
    await this.saveChain;
    const row = await this.store.get(id);
    if (!row) throw new Error("Recording not found on this phone");
    return this.saveRecording({ ...row.payload, ...patch, recordingId: id });
  }
  async getRecording(id) { await this.saveChain; return this.store.get(id); }
  async listRecordings() {
    await this.saveChain;
    return (await this.store.listMetadata()).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async downloadRecording(id) {
    const row = await this.getRecording(id);
    if (!row) throw new Error("Recording not found");
    return { blob: new Blob([JSON.stringify(recordingExport(row.payload))], { type: "application/json" }), filename: recordingFilename(id) };
  }
  async connect() {
    if (this.recording) throw new Error("Finish recording before connecting OneDrive");
    const res = await this.request(`${API}/connect`, { method: "POST", credentials: "same-origin", headers: { "X-BrixtonVibes": "1" } });
    if (!res.ok) throw new Error("OneDrive setup is required; see the setup guide");
    const { url } = await res.json();
    if (new URL(url).origin !== "https://login.microsoftonline.com") throw new Error("Unexpected sign-in destination");
    globalThis.location.assign(url);
  }
  async disconnect() {
    if (this.recording) throw new Error("Finish recording before changing OneDrive");
    const res = await this.request(`${API}/disconnect`, { method: "POST", credentials: "same-origin", headers: { "X-BrixtonVibes": "1" } });
    if (!res.ok) throw new Error("Could not disconnect OneDrive; try again when online");
    this.emit({ authenticated: false, state: "local", message: "Disconnected · local recordings retained" });
  }
  async retry({ force = false } = {}) {
    if (this.nativeOnly) return;
    if (this.running || this.recording) return;
    clearTimeout(this.timer); this.timer = null;
    if (!this.online()) { this.emit({ state: "offline", message: "Offline · upload will retry when this app is open" }); return; }
    this.running = true;
    try {
      if (!this.status.authenticated) await this.refreshStatus();
      if (!this.status.authenticated) return;
      await this.saveChain;
      const rows = await this.store.listMetadata();
      for (const meta of rows) {
        if (this.recording) break;
        if (!meta.complete || meta.uploadedRevision === meta.revision || (!force && meta.nextAttemptAt > this.now())) continue;
        const row = await this.store.get(meta.id);
        if (this.recording) break;
        if (!row || !row.complete || row.uploadedRevision === row.revision) continue;
        this.emit({ state: "uploading", message: "Saved on phone · uploading to OneDrive…" });
        let res;
        try {
          res = await this.request(`${API}/recordings/${encodeURIComponent(row.id)}`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-BrixtonVibes": "1" }, body: JSON.stringify(recordingExport(row.payload)) });
          if (!res.ok) {
            const failure = new Error(res.status === 401 ? "Reconnect OneDrive after recording; your file is safe" : `Upload paused (${res.status}); your file is safe`);
            failure.status = res.status;
            const retryAfter = Number(res.headers.get("retry-after"));
            failure.retryAfter = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
            throw failure;
          }
          // A label may have been saved during the upload; never mark that
          // NEWER revision uploaded until its own request has succeeded.
          await this.markRow(row.id, latest => ({ ...latest, uploadedRevision: row.revision, lastError: null, attempts: 0, nextAttemptAt: 0, uploadedAt: this.now() }));
          this.emit({ state: "uploaded", message: "Saved on phone and OneDrive" });
        } catch (error) {
          await this.markRow(row.id, latest => ({ ...latest, attempts: (latest.attempts || 0) + 1, nextAttemptAt: this.now() + Math.max(error.retryAfter || 0, Math.min(300000, 5000 * 2 ** Math.min(latest.attempts || 0, 6))), lastError: error.message }));
          this.emit({ state: "pending", authenticated: error.status === 401 ? false : this.status.authenticated, message: error.message || "Upload interrupted · file safe on phone" });
          // Don't hammer Graph on an expired/revoked session or throttling.
          break;
        }
      }
      const after = await this.counts();
      const pending = after.filter(r => r.complete && r.uploadedRevision !== r.revision);
      if (pending.length && this.status.authenticated && !this.recording) {
        const delay = Math.max(1000, Math.min(...pending.map(r => r.nextAttemptAt || this.now())) - this.now());
        this.timer = setTimeout(() => this.retry().catch(() => {}), delay);
        this.timer?.unref?.();
      }
    } finally { this.running = false; }
  }
  async markRow(id, change) {
    const work = this.saveChain.then(async () => {
      const latest = await this.store.get(id);
      if (latest) await this.store.put(change(latest));
    });
    this.saveChain = work.catch(() => {});
    return work;
  }
  destroy() {
    clearTimeout(this.timer);
    globalThis.removeEventListener?.("online", this.onlineListener);
    globalThis.document?.removeEventListener("visibilitychange", this.visibleListener);
  }
}

export function recordingExport(payload) {
  // Existing restore/analysis format; an unlabelled recovery stays unlabelled.
  return { version: 3, storageKey: "victoria-line-training-set", exportTimestamp: Date.now(), complete: payload.complete !== false, recordingId: payload.recordingId, examples: [{ ...payload, id: payload.id || payload.recordingId, features: payload.features || {}, hasRawData: true }] };
}
