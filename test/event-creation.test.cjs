const { test } = require('node:test');
const assert = require('node:assert/strict');
const createEventWriter = require('../services/event-creation');
const { ApiError } = require('../services/upstream');

const event = { name: 'Test event', userId: '1' };
const logger = { info() {}, warn() {} };
function setup(respond) {
  let time = 0;
  const calls = []; const waits = [];
  const write = createEventWriter({
    upstream: async (path, options) => { calls.push({ path, options }); return respond(calls.length); },
    getUser: async () => ({ id: 1, events: [] }), logger,
    now: () => time, random: () => 0.5,
    wait: async ms => { waits.push(ms); time += ms; }
  });
  return { write, calls, waits };
}
function safeFailure(retryAfterMs = 0) {
  return new ApiError(503, 'Unavailable', { upstreamStatus: 503, retryAfterMs });
}

test('transient failure is retried once with jitter and the same idempotency key and event ID', async () => {
  const { write, calls, waits } = setup(attempt => {
    if (attempt === 1) throw safeFailure();
    return { success: true };
  });
  assert.deepEqual(await write(event), { success: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [150]);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.ok(calls[0].options.headers['Idempotency-Key']);
  assert.equal(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
});

test('retries are bounded and stop immediately when the third failed attempt opens the circuit', async () => {
  const { write, calls, waits } = setup(() => { throw safeFailure(); });
  await assert.rejects(write(event), { statusCode: 503 });
  assert.equal(calls.length, 2);
  await assert.rejects(write(event), error => error.statusCode === 503 && error.retryAfterSeconds === 5);
  assert.equal(calls.length, 3);
  await assert.rejects(write(event), { statusCode: 503 });
  assert.equal(calls.length, 3);
  assert.equal(waits.length, 1);
});

test('timeouts and transport failures are retried once under the upstream idempotency contract', async () => {
  for (const status of [504, 502]) {
    const { write, calls, waits } = setup(() => { throw new ApiError(status, 'Ambiguous write'); });
    await assert.rejects(write(event), { statusCode: status });
    assert.equal(calls.length, 2);
    assert.equal(waits.length, 1);
  }
});

test('ordinary upstream client errors are not retried', async () => {
  const { write, calls } = setup(() => { throw new ApiError(404, 'Not found'); });
  await assert.rejects(write(event), { statusCode: 404 });
  assert.equal(calls.length, 1);
});

test('client retries reuse cached success and conflicting payloads return 409', async () => {
  const { write, calls } = setup(() => ({ success: true }));
  assert.deepEqual(await write(event, 'client-key'), { success: true });
  assert.deepEqual(await write(event, 'client-key'), { success: true });
  assert.equal(calls.length, 1);
  await assert.rejects(write({ ...event, name: 'Different' }, 'client-key'), { statusCode: 409 });
  assert.equal(calls.length, 1);
});

test('failed client requests retain the same event ID for later retries', async () => {
  const { write, calls } = setup(attempt => {
    if (attempt <= 2) throw safeFailure();
    return { success: true };
  });
  await assert.rejects(write(event, 'client-key'), { statusCode: 503 });
  assert.deepEqual(await write(event, 'client-key'), { success: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.body, calls[2].options.body);
});

test('safe retry honors Retry-After if it fits the request budget', async () => {
  const { write, waits } = setup(attempt => {
    if (attempt === 1) throw safeFailure(1000);
    return { success: true };
  });
  await write(event);
  assert.deepEqual(waits, [1000]);
});

test('retry is not scheduled beyond the five-second request budget', async () => {
  const { write, calls, waits } = setup(() => { throw safeFailure(10000); });
  await assert.rejects(write(event), error => error.statusCode === 503 && error.retryAfterSeconds === 10);
  assert.equal(calls.length, 1);
  assert.equal(waits.length, 0);
});
