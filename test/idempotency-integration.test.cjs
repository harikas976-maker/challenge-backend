const { test } = require('node:test');
const assert = require('node:assert/strict');
const buildApp = require('../services/app');
const listenMock = require('../mock-server');

test('lost response after a real mock write is retried without a duplicate event', async t => {
  listenMock();
  let time = 0;
  const app = buildApp({ resilience: { now: () => time, random: () => 0.5, wait: async ms => { time += ms; } } });
  const interceptedFetch = global.fetch;
  let postAttempts = 0;
  const keys = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    const response = await interceptedFetch(url, options);
    if (String(url).endsWith('/addEvent')) {
      postAttempts++;
      keys.push(options.headers['Idempotency-Key']);
      if (postAttempts === 1) {
        await response.text(); // The upstream committed; only its response was lost.
        throw new TypeError('Simulated lost response');
      }
    }
    return response;
  });
  t.after(async () => {
    await app.close();
    t.mock.restoreAll();
    listenMock.close();
  });
  const request = { method: 'POST', url: '/addEvent', headers: { 'Idempotency-Key': 'lost-response-key' }, payload: { name: 'Only once', userId: '1' } };
  const created = await app.inject(request);
  assert.equal(created.statusCode, 200);
  assert.equal(postAttempts, 2);
  assert.equal(keys[0], keys[1]);
  const events = (await app.inject({ method: 'GET', url: '/getEventsByUserId/1' })).json();
  assert.equal(events.filter(event => event.name === 'Only once').length, 1);
  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 200);
  assert.equal(postAttempts, 2);
  const conflict = await app.inject({ ...request, payload: { name: 'Different payload', userId: '1' } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(postAttempts, 2);
  // A fresh API instance has no cache: the upstream must still deduplicate.
  const secondApp = buildApp();
  t.after(() => secondApp.close());
  assert.equal((await secondApp.inject({ ...request, payload: { name: 'Wrong payload first', userId: '1' } })).statusCode, 409);
  assert.equal((await secondApp.inject(request)).statusCode, 200);
  assert.equal(postAttempts, 4);
  const finalEvents = (await secondApp.inject({ method: 'GET', url: '/getEventsByUserId/1' })).json();
  assert.equal(finalEvents.filter(event => event.name === 'Only once').length, 1);
});
