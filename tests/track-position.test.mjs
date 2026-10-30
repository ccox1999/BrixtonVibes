import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionFrames, motionFrames, buildTrackReference, TrackPosition } from '../track-position.js';
const frame = (moving = true) => ({ moving, quality: true, gap: false, features: [0.1, 0, .5] });
const reference = buildTrackReference(Array.from({ length: 8 }, (_, i) => ({ label: i % 2 ? 'left' : 'right', frames: Array.from({ length: 80 + i }, () => frame()) })));
test('reference contains aggregates and has no asserted physical junction', () => {
  assert.equal(reference.coordinate, 'historical-moving-profile-fraction');
  assert.equal(reference.junction.verified, false);
  assert.equal(reference.junction.progress, null);
  assert.equal(reference.tripCount, 8);
  assert.ok(reference.branches.left.profile.length === 61);
});
test('multiple stops do not advance either route hypothesis and restart retains progress', () => {
  const matcher = new TrackPosition(reference);
  for (let i = 0; i < 35; i++) matcher.updateFrame(frame());
  for (let round = 0; round < 3; round++) {
    const before = structuredClone(matcher.value);
    for (let i = 0; i < 30; i++) matcher.updateFrame(frame(false));
    assert.equal(matcher.value.progress, before.progress);
    assert.equal(matcher.value.hypotheses.left.progress, before.hypotheses.left.progress);
    assert.equal(matcher.value.hypotheses.right.progress, before.hypotheses.right.progress);
    assert.equal(matcher.value.state, 'paused-or-slow');
    matcher.updateFrame(frame());
    assert.ok(matcher.value.progress > before.progress);
  }
});
test('missing reference or sensors never manufacture a position', () => {
  const matcher = new TrackPosition(null);
  matcher.update({ time: 1, ax: null, ay: 0, az: 0 });
  matcher.update({ time: 1001, ax: null, ay: 0, az: 0 });
  assert.equal(matcher.value.progress, null);
  const withReference = new TrackPosition(reference);
  for (let i = 0; i < 40; i++) withReference.updateFrame({ ...frame(), moving: false, quality: false, gap: true });
  assert.equal(withReference.value.movingSeconds, 0);
  assert.equal(withReference.value.progress, null);
  assert.equal(withReference.value.state, 'waiting-for-motion');
});
test('raw frames freeze over synthetic still interval and reject large phone movement', () => {
  const observed = [], reader = new MotionFrames(f => observed.push(f));
  for (let ms = 0; ms < 12000; ms += 20) reader.update({ time: ms, ax: ms < 5000 ? 1 : 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 9.81, rotationAlpha: 0, rotationBeta: 0, rotationGamma: 0 });
  assert.equal(observed[8].moving, false);
  assert.equal(observed[3].moving, true);
  const bad = motionFrames(Array.from({ length: 100 }, (_, i) => ({ time: i * 20, ax: 100, ay: 0, az: 0, gx: 0, gy: 0, gz: 9.81, rotationAlpha: 80 })));
  assert.ok(bad.every(f => !f.moving));
});
test('sensor gaps and duplicate timestamps do not count unobserved seconds as movement', () => {
  const frames = [], reader = new MotionFrames(f => frames.push(f));
  for (let i = 0; i < 50; i++) reader.update({ time: i * 20, ax: 1, ay: 0, az: 0 });
  reader.update({ time: 60000, ax: 1, ay: 0, az: 0 });
  reader.update({ time: 60000, ax: 1, ay: 0, az: 0 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].gap, true);
  assert.equal(frames[0].moving, false);
});
test('vibration-only tracking remains explicitly limited when gyro or gravity is missing', () => {
  const matcher = new TrackPosition(reference);
  for (let i = 0; i < 12; i++) matcher.updateFrame({ ...frame(), features: [null, 0, null] });
  assert.equal(matcher.value.quality, 'limited-sensors');
  assert.ok(matcher.value.progress > 0);
  assert.ok(matcher.value.upper - matcher.value.lower >= .3);
});
