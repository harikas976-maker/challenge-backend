const { test } = require('node:test');
const assert = require('node:assert/strict');
const buildApp = require('../services/app');
const listenMock = require('../mock-server');

test('real mock rejects invalid writes without storing orphan events', async t => {
  // Eliminate the intentional random read failures for this one data-integrity test.
  t.mock.method(Math, 'random', () => 0.5);
  listenMock();
  const app = buildApp();
  t.after(async () => { await app.close(); listenMock.close(); });
  const before = (await app.inject({ method: 'GET', url: '/getEvents' })).json();
  for (const [payload, expected] of [
    [{ name: 'Missing user' }, 400],
    [{ name: 'Unknown user', userId: '999' }, 404]
  ]) {
    const response = await app.inject({ method: 'POST', url: '/addEvent', payload });
    assert.equal(response.statusCode, expected);
    assert.equal(response.body.includes('stack'), false);
  }
  // Verify the mock's own write boundary as well as the public API validation.
  for (const [body, status] of [
    [{ id: 'missing-user', name: 'Missing user' }, 400],
    [{ id: 'unknown-user', name: 'Unknown user', userId: '999' }, 404]
  ]) {
    const response = await fetch('http://event.com/addEvent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, status);
    await response.text();
  }
  const after = (await app.inject({ method: 'GET', url: '/getEvents' })).json();
  assert.deepEqual(after, before);
  const created = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Valid event', userId: '1' } });
  assert.equal(created.statusCode, 200);
  const userEvents = (await app.inject({ method: 'GET', url: '/getEventsByUserId/1' })).json();
  assert.equal(userEvents.length, 3);
  assert.equal(userEvents.at(-1).name, 'Valid event');
});
