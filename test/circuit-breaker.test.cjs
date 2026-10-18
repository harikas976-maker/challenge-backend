const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker, CircuitOpenError } = require('../services/circuit-breaker');
const { ApiError } = require('../services/upstream');

function setup() {
  let time = 0;
  const transitions = [];
  const breaker = new CircuitBreaker({ now: () => time, random: () => 0.5, onTransition: event => transitions.push(event) });
  return { breaker, transitions, advance: ms => { time += ms; } };
}
const failure = () => { throw new ApiError(503, 'Unavailable'); };
async function fail(breaker) { await assert.rejects(breaker.execute(failure), { statusCode: 503 }); }
async function open(breaker) { for (let index = 0; index < 3; index++) await fail(breaker); }

test('third failure in a rolling window opens; successes do not erase failures', async () => {
  const { breaker } = setup();
  await fail(breaker);
  await breaker.execute(async () => 'ok');
  await fail(breaker);
  assert.equal(breaker.state, 'closed');
  await fail(breaker);
  assert.equal(breaker.state, 'open');
});

test('failures older than 30 seconds expire', async () => {
  const { breaker, advance } = setup();
  await fail(breaker);
  advance(30001);
  await fail(breaker);
  await fail(breaker);
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.failures.length, 2);
});

test('failures exactly 30 seconds apart count within the window', async () => {
  const { breaker, advance } = setup();
  await fail(breaker);
  advance(30000);
  await fail(breaker);
  await fail(breaker);
  assert.equal(breaker.state, 'open');
});

test('open circuit suppresses upstream work and reports remaining cooldown', async () => {
  const { breaker, advance } = setup();
  await open(breaker);
  let calls = 0;
  await assert.rejects(breaker.execute(() => { calls++; }), error => error instanceof CircuitOpenError && error.retryAfterSeconds === 5);
  advance(4001);
  assert.equal(breaker.retryAfterSeconds(), 1);
  assert.equal(calls, 0);
});

test('only one concurrent half-open probe is admitted; success closes the circuit', async () => {
  const { breaker, advance, transitions } = setup();
  await open(breaker);
  advance(5000);
  let complete;
  const probe = breaker.execute(() => new Promise(resolve => { complete = resolve; }));
  await assert.rejects(breaker.execute(() => assert.fail('Second probe admitted')), CircuitOpenError);
  complete('recovered');
  assert.equal(await probe, 'recovered');
  assert.equal(breaker.state, 'closed');
  assert.deepEqual(breaker.failures, []);
  assert.deepEqual(transitions.map(event => event.to), ['open', 'half-open', 'closed']);
});

test('failed probes increase cooldown to a bounded maximum', async () => {
  const { breaker, advance } = setup();
  await open(breaker);
  for (const expected of [10, 20, 30, 30]) {
    advance(breaker.retryAfterSeconds() * 1000);
    await fail(breaker);
    assert.equal(breaker.state, 'open');
    assert.equal(breaker.retryAfterSeconds(), expected);
  }
});

test('successful recovery resets the next cooldown', async () => {
  const { breaker, advance } = setup();
  await open(breaker);
  advance(5000);
  await fail(breaker);
  advance(10000);
  await breaker.execute(async () => 'ok');
  await open(breaker);
  assert.equal(breaker.retryAfterSeconds(), 5);
});

test('client errors do not trip the circuit or claim half-open recovery', async () => {
  const { breaker, advance } = setup();
  const rejectedUser = () => { throw new ApiError(404, 'Unknown user'); };
  for (let index = 0; index < 5; index++) await assert.rejects(breaker.execute(rejectedUser), { statusCode: 404 });
  assert.equal(breaker.state, 'closed');
  await open(breaker);
  advance(5000);
  await assert.rejects(breaker.execute(rejectedUser), { statusCode: 404 });
  assert.equal(breaker.state, 'half-open');
  assert.equal(await breaker.execute(async () => 'real probe'), 'real probe');
  assert.equal(breaker.state, 'closed');
});

test('late success from an older generation cannot close an open circuit', async () => {
  const { breaker } = setup();
  let finish;
  const old = breaker.execute(() => new Promise(resolve => { finish = resolve; }));
  await open(breaker);
  finish('old success');
  await old;
  assert.equal(breaker.state, 'open');
});

test('late failure from an old generation cannot reopen a recovered circuit', async () => {
  const { breaker, advance } = setup();
  let rejectOld;
  const old = breaker.execute(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const rejected = assert.rejects(old, { statusCode: 503 });
  await open(breaker);
  advance(5000);
  await breaker.execute(async () => 'recovered');
  rejectOld(new ApiError(503, 'Old failure'));
  await rejected;
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.failures.length, 0);
});

test('jitter changes cooldown within its documented bounds', async () => {
  for (const [random, expected] of [[0, 4], [1, 6]]) {
    const breaker = new CircuitBreaker({ now: () => 0, random: () => random });
    await open(breaker);
    assert.equal(breaker.retryAfterSeconds(), expected);
  }
});
