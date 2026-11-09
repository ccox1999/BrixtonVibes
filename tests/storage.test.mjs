import test from 'node:test';
import assert from 'node:assert/strict';
import { TrainingSet } from '../training-set.js';

// Exercise transaction completion, undefined delete results and connection
// lifecycle without replacing the storage module's public methods.
function memoryIndexedDB() {
  const rows = new Map(), connections = [];
  return { rows, connections, open() {
    const request = {};
    const db = { closed: false, close() { this.closed = true; }, transaction() {
      if (this.closed) throw new Error('Connection closed');
      const tx = { objectStore() {
        return Object.fromEntries(['get', 'put', 'delete', 'clear', 'getAllKeys'].map(method => [method, (...args) => {
          const req = {};
          queueMicrotask(() => {
            if (method === 'get') req.result = structuredClone(rows.get(args[0]));
            if (method === 'put') { rows.set(args[1], structuredClone(args[0])); req.result = args[1]; }
            if (method === 'delete') rows.delete(args[0]);
            if (method === 'clear') rows.clear();
            if (method === 'getAllKeys') req.result = [...rows.keys()];
            req.onsuccess?.();
            tx.oncomplete?.();
          });
          return req;
        }]));
      } };
      return tx;
    } };
    connections.push(db); request.result = db;
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } };
}
const db = memoryIndexedDB();
globalThis.indexedDB = db;
let storageFailure = false;
const metadata = new Map();
globalThis.localStorage = {
  getItem: key => metadata.get(key) ?? null,
  setItem(key, value) { if (storageFailure) throw new Error('Simulated metadata failure'); metadata.set(key, value); },
  removeItem: key => metadata.delete(key),
};
const example = (id, extra = {}) => ({ id, recordingId: `recording-${id}`, features: { value: 1 }, label: 'left', timestamp: 1, ...extra });

test('a damaged import skips null rows and keeps valid journeys usable', () => {
  const set = new TrainingSet();
  set.fromJSON({ examples: [null, false, [], example('example-1', { label: ' LEFT ' })] });
  assert.equal(set.count(), 1);
  assert.equal(set.examples[0].label, 'left');
  assert.throws(() => set.fromJSON(null), /Invalid training set/);
});

test('malformed raw sensor samples reject the import without replacing existing journeys', () => {
  const set = new TrainingSet();
  set.fromJSON({ examples: [example('example-1')] });
  const malformed = [null, false, 42, [], {}, { time: '1' }, { time: NaN }, { time: Infinity }];
  for (const sample of malformed) {
    assert.throws(() => set.fromJSON({ examples: [example('example-2', { rawMotionData: [sample] })] }), /Invalid raw sensor sample/);
    assert.equal(set.examples[0].id, 'example-1');
    assert.equal(set.nextId, 2);
  }
  assert.throws(() => set.fromJSON({ examples: [example('example-2', { rawMotionData: Array(2) })] }), /Invalid raw sensor sample/);
});

test('supplied raw sensor data must be an array while missing sensor channels remain valid', () => {
  const set = new TrainingSet();
  set.fromJSON({ examples: [example('example-1')] });
  for (const rawMotionData of [null, false, 42, {}, 'raw']) {
    assert.throws(() => set.fromJSON({ examples: [example('example-2', { rawMotionData })] }), /Invalid raw sensor data/);
    assert.equal(set.examples[0].id, 'example-1');
  }
  const rawMotionData = [{ time: 0, ax: null, gx: null }, { time: 1 }];
  set.fromJSON({ examples: [example('example-2', { rawMotionData })] });
  assert.deepEqual(set.examples[0].rawMotionData, rawMotionData);
});

test('missing or colliding imported local IDs cannot remove the wrong journey', () => {
  const set = new TrainingSet();
  set.fromJSON({ examples: [example('example-1'), example('example-1', { recordingId: 'different' }), example(undefined)] });
  assert.equal(new Set(set.examples.map(e => e.id)).size, 3);
  const imported = set.examples[1].id;
  assert.equal(set.remove(imported), true);
  assert.equal(set.get('example-1').recordingId, 'recording-example-1');
});

test('re-importing an existing journey repairs its raw samples without duplicating it', async () => {
  const set = new TrainingSet(), backup = new TrainingSet();
  set.fromJSON({ examples: [example('example-1', { hasRawData: true })] });
  backup.fromJSON({ examples: [example('example-9', { recordingId: 'recording-example-1', rawMotionData: [{ time: 1 }] })] });
  assert.equal(set.mergeFrom(backup), 0);
  assert.equal(await set.restoreRawFrom(backup), 1);
  assert.equal(set.count(), 1);
  assert.deepEqual(set.examples[0].rawMotionData, [{ time: 1 }]);
});

test('a duplicate recording ID cannot overwrite healthy raw samples during restore', async () => {
  const set = new TrainingSet(), backup = new TrainingSet();
  const healthy = [{ time: 1 }, { time: 2 }];
  set.fromJSON({ examples: [example('example-1', { rawMotionData: healthy })] });
  backup.fromJSON({ examples: [example('example-9', { recordingId: 'recording-example-1', rawMotionData: [{ time: 999 }] })] });
  assert.equal(set.mergeFrom(backup), 0);
  assert.equal(await set.restoreRawFrom(backup), 0);
  assert.deepEqual(set.examples[0].rawMotionData, healthy);
});

test('a conflicting recording ID inside an import rejects before replacing the current set', () => {
  const set = new TrainingSet();
  set.fromJSON({ examples: [example('example-1')] });
  assert.throws(() => set.fromJSON({ examples: [
    example('example-2', { recordingId: 'conflict', rawMotionData: [{ time: 1 }] }),
    example('example-3', { recordingId: 'conflict', rawMotionData: [{ time: 2 }] }),
  ] }), /Conflicting journeys/);
  assert.equal(set.examples[0].id, 'example-1');
});

test('metadata-only quota fallback reports incomplete storage and retains raw in memory', async () => {
  const set = new TrainingSet('quota-test');
  set.fromJSON({ examples: [example('example-1', { recordingId: 'quota-recording', rawMotionData: [{ time: 1 }] })] });
  const rawModule = await import('../raw-store.js');
  // Invalidate the cached normal connection before making storage unavailable.
  for (const connection of db.connections) connection.onversionchange?.();
  const original = globalThis.localStorage;
  globalThis.indexedDB = { open() { throw new Error('Unavailable for quota test'); } };
  globalThis.localStorage = { ...original, setItem(key, value) {
    if (JSON.parse(value).examples.some(e => e.rawMotionData)) throw Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
    original.setItem(key, value);
  } };
  try {
    await assert.rejects(set.save(), error => error.code === 'RAW_STORAGE_UNAVAILABLE');
    assert.deepEqual(set.examples[0].rawMotionData, [{ time: 1 }]);
    assert.equal(JSON.parse(metadata.get('quota-test')).examples[0].rawMotionData, undefined);
  } finally { globalThis.indexedDB = db; globalThis.localStorage = original; }
  assert.equal(await rawModule.putRaw('quota-retry', [{ time: 1 }]), true);
});

test('legacy exports without recording IDs get separate local identities when merged', () => {
  const set = new TrainingSet(), backup = new TrainingSet();
  set.fromJSON({ examples: [example('example-1')] });
  backup.fromJSON({ examples: [example('example-1', { recordingId: undefined })] });
  assert.equal(set.mergeFrom(backup), 1);
  assert.equal(set.examples[1].recordingId, 'example-2');
});

test('a failed metadata save preserves raw data for the still-saved journey', async () => {
  const set = new TrainingSet('delete-test');
  set.fromJSON({ examples: [example('example-1', { rawMotionData: [{ time: 1 }] })] });
  await set.save();
  assert.ok(db.rows.has('recording-example-1'));
  set.remove('example-1');
  storageFailure = true;
  try { await assert.rejects(set.save(), /Simulated metadata failure/); }
  finally { storageFailure = false; }
  assert.ok(db.rows.has('recording-example-1'));
  assert.equal(JSON.parse(metadata.get('delete-test')).examples.length, 1);
  await set.save();
  assert.equal(db.rows.has('recording-example-1'), false);
  assert.equal(JSON.parse(metadata.get('delete-test')).examples.length, 0);
});

test('clearing training data preserves metadata, memory and raw if metadata removal fails', async () => {
  const set = new TrainingSet('clear-test');
  set.fromJSON({ examples: [example('example-1', { recordingId: 'clear-recording', rawMotionData: [{ time: 1 }] })] });
  await set.save();
  const saved = metadata.get('clear-test'), nextId = set.nextId;
  const original = globalThis.localStorage;
  globalThis.localStorage = { ...original, removeItem() { throw new Error('Simulated removal failure'); } };
  try { await assert.rejects(set.clear(), /Simulated removal failure/); }
  finally { globalThis.localStorage = original; }
  assert.equal(set.count(), 1);
  assert.equal(set.nextId, nextId);
  assert.equal(metadata.get('clear-test'), saved);
  assert.deepEqual(db.rows.get('clear-recording'), [{ time: 1 }]);
  await set.clear();
  assert.equal(set.count(), 0);
  assert.equal(set.nextId, 1);
  assert.equal(metadata.has('clear-test'), false);
  assert.equal(db.rows.has('clear-recording'), false);
});

test('raw store reopens after a version change and reports successful deletion', async () => {
  const raw = await import(`../raw-store.js?lifecycle=${Date.now()}`);
  await raw.putRaw('lifecycle', [{ time: 1 }]);
  const first = db.connections.at(-1);
  first.onversionchange();
  assert.equal(first.closed, true);
  assert.deepEqual(await raw.getRaw('lifecycle'), [{ time: 1 }]);
  assert.notEqual(db.connections.at(-1), first);
  assert.equal(await raw.deleteRaw('lifecycle'), true);
  assert.equal(await raw.clearRaw(), true);
});

test('raw store recovers after synchronous unavailability instead of caching failure forever', async () => {
  const raw = await import(`../raw-store.js?retry=${Date.now()}`);
  globalThis.indexedDB = { open() { throw new Error('Temporarily unavailable'); } };
  try { assert.equal(await raw.putRaw('retry', [{ time: 1 }]), false); }
  finally { globalThis.indexedDB = db; }
  assert.equal(await raw.putRaw('retry', [{ time: 1 }]), true);
});

test('blocked raw storage returns failure promptly and closes any late connection', async () => {
  const raw = await import(`../raw-store.js?blocked=${Date.now()}`);
  let request, closed = false;
  globalThis.indexedDB = { open() {
    request = { result: { close() { closed = true; } } };
    queueMicrotask(() => request.onblocked());
    return request;
  } };
  try {
    assert.equal(await raw.putRaw('blocked', [{ time: 1 }]), false);
    request.onsuccess();
    assert.equal(closed, true);
  } finally { globalThis.indexedDB = db; }
  assert.equal(await raw.putRaw('blocked', [{ time: 1 }]), true);
});
