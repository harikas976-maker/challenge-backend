const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IdempotencyStore, eventFingerprint } = require('../services/idempotency');

test('concurrent identical keys execute once and return the same result', async () => {
  const store = new IdempotencyStore();
  let calls = 0; let finish;
  const operation = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = store.execute('key', 'payload', operation);
  const second = store.execute('key', 'payload', operation);
  await Promise.resolve();
  finish({ success: true });
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test('capacity is bounded without evicting a live key; expired keys can be reused', async () => {
  let time = 0;
  const store = new IdempotencyStore({ now: () => time, ttlMs: 100, maxEntries: 1 });
  await store.execute('first', 'payload', async () => 'first');
  await assert.rejects(store.execute('second', 'payload', async () => 'second'), { statusCode: 503 });
  assert.equal(await store.execute('first', 'payload', async () => assert.fail('Duplicate execution')), 'first');
  time = 100;
  assert.equal(await store.execute('second', 'payload', async () => 'second'), 'second');
  assert.equal(store.entries.size, 1);
});

test('pending entries are not evicted on expiry', async () => {
  let time = 0; let finish;
  const store = new IdempotencyStore({ now: () => time, ttlMs: 100, maxEntries: 1 });
  const pending = store.execute('first', 'payload', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  time = 1000;
  await assert.rejects(store.execute('second', 'payload', async () => 'second'), { statusCode: 503 });
  finish('finished');
  await pending;
});

test('payload fingerprint normalizes numeric user IDs and includes details', () => {
  assert.equal(eventFingerprint({ name: 'Event', userId: 1 }), eventFingerprint({ userId: '1', name: 'Event' }));
  assert.notEqual(eventFingerprint({ name: 'Event', userId: 1 }), eventFingerprint({ name: 'Event', userId: 1, details: 'Changed' }));
});
