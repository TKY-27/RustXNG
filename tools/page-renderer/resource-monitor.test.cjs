// SPDX-License-Identifier: AGPL-3.0-or-later
const assert = require('node:assert/strict');
const test = require('node:test');
const { ResourceMonitor } = require('./resource-monitor.cjs');

function clock(t) {
  let now = 0;
  const timers = new Set();
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const timer = { callback, at: now + delay };
    timers.add(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer));
  return milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      now = next.at;
      timers.delete(next);
      next.callback();
    }
    now = end;
  };
}

test('idle begins only after the last worker or resource finishes', async t => {
  const advance = clock(t);
  const resources = new ResourceMonitor();
  t.after(() => resources.close());
  const workerReady = resources.start();
  const responseDelivered = resources.start();
  let settled = false;
  const idle = resources.wait().then(version => { settled = true; return version; });
  workerReady();
  advance(1000);
  await Promise.resolve();
  assert.equal(settled, false);
  responseDelivered();
  responseDelivered();
  advance(499);
  await Promise.resolve();
  assert.equal(settled, false);
  advance(1);
  assert.equal(resources.unchanged(await idle), true);
});

test('activity resets the quiet period and invalidates an earlier snapshot', async t => {
  const advance = clock(t);
  const resources = new ResourceMonitor();
  t.after(() => resources.close());
  let settled = false;
  const idle = resources.wait().then(version => { settled = true; return version; });
  advance(400);
  const finished = resources.start();
  finished();
  advance(100);
  await Promise.resolve();
  assert.equal(settled, false);
  advance(400);
  const version = await idle;
  const next = resources.start();
  assert.equal(resources.unchanged(version), false);
  next();
  assert.equal(resources.unchanged(version), false);
  const updated = resources.wait();
  advance(500);
  assert.equal(resources.unchanged(await updated), true);
});

test('a stalled resource reaches the shared render deadline', async t => {
  const advance = clock(t);
  const resources = new ResourceMonitor();
  t.after(() => resources.close());
  resources.start();
  const idle = assert.rejects(resources.wait(), /rendering exceeded 10000 ms/);
  const deadline = assert.rejects(resources.deadline, /rendering exceeded 10000 ms/);
  advance(10000);
  await Promise.all([idle, deadline]);
  await assert.rejects(resources.wait(), /rendering exceeded 10000 ms/);
});

test('the deadline also covers work after resources become idle', async t => {
  const advance = clock(t);
  const resources = new ResourceMonitor();
  t.after(() => resources.close());
  const idle = resources.wait();
  advance(500);
  const version = await idle;
  const deadline = assert.rejects(resources.deadline, /rendering exceeded 10000 ms/);
  advance(9500);
  await deadline;
  assert.equal(resources.unchanged(version), false);
});

test('shutdown cancels an idle wait and clears its deadline', async t => {
  const advance = clock(t);
  const resources = new ResourceMonitor();
  const idle = assert.rejects(resources.wait(), /renderer stopped/);
  let deadlineReached = false;
  resources.deadline.catch(() => { deadlineReached = true; });
  resources.close();
  advance(10000);
  await idle;
  assert.equal(deadlineReached, false);
  await assert.rejects(resources.wait(), /renderer stopped/);
});
