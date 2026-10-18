const { test } = require('node:test');
const assert = require('node:assert/strict');
const buildApp = require('../services/app');
const listenMock = require('../mock-server');

test('real mock cycle opens, suppresses calls, probes with backoff and resumes normal writes', async t => {
  listenMock();
  let time = 0;
  let outboundCalls = 0;
  let writeAttempts = 0;
  const interceptedFetch = global.fetch;
  t.mock.method(global, 'fetch', (...args) => {
    outboundCalls++;
    if (String(args[0]).endsWith('/addEvent')) writeAttempts++;
    return interceptedFetch(...args);
  });
  const app = buildApp({ resilience: {
    now: () => time, random: () => 0.5, wait: async ms => { time += ms; }
  } });
  t.after(async () => { await app.close(); t.mock.restoreAll(); listenMock.close(); });
  const send = () => app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Cycle event', userId: '1' } });
  for (let index = 0; index < 5; index++) assert.equal((await send()).statusCode, 200);
  assert.equal(writeAttempts, 5);
  assert.equal((await send()).statusCode, 503); // Two failed attempts.
  assert.equal(writeAttempts, 7);
  const opened = await send(); // Third failed attempt opens immediately.
  assert.equal(opened.statusCode, 503);
  assert.equal(opened.headers['retry-after'], '5');
  assert.equal(writeAttempts, 8);
  const blockedAt = outboundCalls;
  for (let index = 0; index < 5; index++) {
    assert.equal((await send()).statusCode, 503);
  }
  assert.equal(outboundCalls, blockedAt); // Neither user lookup nor POST reaches upstream.
  let response = opened;
  const cooldowns = [];
  for (let index = 0; index < 8; index++) {
    cooldowns.push(Number(response.headers['retry-after']));
    time += Number(response.headers['retry-after']) * 1000;
    response = await send();
    assert.equal(response.statusCode, index < 7 ? 503 : 200);
  }
  assert.deepEqual(cooldowns, [5, 10, 20, 30, 30, 30, 30, 30]);
  assert.equal(writeAttempts, 16);
  assert.equal((await send()).statusCode, 200);
  assert.equal(writeAttempts, 17);
});
