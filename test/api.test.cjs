const { test } = require('node:test');
const assert = require('node:assert/strict');
const { http, HttpResponse, delay } = require('msw');
const { setupServer } = require('msw/node');
const buildApp = require('../services/app');

function setup(t, overrides = [], appOptions = {}) {
  const writes = [];
  const user = { id: 1, events: ['event-1', 'event-3'] };
  const events = [
    { id: 'event-1', name: 'First event', userId: 1 },
    { id: 'event-3', name: 'Third event', userId: 1 }
  ];
  const server = setupServer(
    ...overrides,
    http.get('http://event.com/getUsers', () => HttpResponse.json([user])),
    http.get('http://event.com/getEvents', () => HttpResponse.json([...events, ...writes])),
    http.get('http://event.com/getUserById/:id', ({ params }) =>
      params.id === '1' ? HttpResponse.json(user) : new HttpResponse(null, { status: 404 })),
    http.get('http://event.com/getEventById/:id', ({ params }) =>
      HttpResponse.json([...events, ...writes].find(event => String(event.id) === params.id))),
    http.post('http://event.com/addEvent', async ({ request }) => {
      const body = await request.json();
      writes.push(body);
      user.events.push(body.id);
      return HttpResponse.json({ success: true });
    })
  );
  server.listen({ onUnhandledRequest: 'error' });
  const app = buildApp(appOptions);
  t.after(async () => { await app.close(); server.close(); });
  return { app, writes, events };
}

test('GET users and events return the controlled upstream data', async t => {
  const { app, events } = setup(t);
  const users = await app.inject({ method: 'GET', url: '/getUsers' });
  assert.equal(users.statusCode, 200);
  assert.equal(users.json()[0].id, 1);
  const response = await app.inject({ method: 'GET', url: '/getEvents' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), events);
});

test('valid event can be created and read back for the user', async t => {
  const { app, writes } = setup(t);
  const created = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'New event', userId: '1' } });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.json(), { success: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'New event');
  assert.ok(writes[0].id);
  const response = await app.inject({ method: 'GET', url: '/getEventsByUserId/1' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().at(-1), writes[0]);
});

for (const [name, payload] of [
  ['missing name', { userId: '1' }],
  ['empty name', { name: '', userId: '1' }],
  ['whitespace name', { name: '   ', userId: '1' }],
  ['missing user ID', { name: 'Event' }],
  ['invalid user ID type', { name: 'Event', userId: {} }],
  ['client-supplied ID', { id: 'client-chosen-id', name: 'Event', userId: '1' }]
]) {
  test(`rejects ${name} without writing upstream`, async t => {
    const { app, writes } = setup(t);
    const response = await app.inject({ method: 'POST', url: '/addEvent', payload });
    assert.equal(response.statusCode, 400);
    assert.equal(writes.length, 0);
  });
}

test('unknown user GET returns 404', async t => {
  const { app } = setup(t);
  const response = await app.inject({ method: 'GET', url: '/getEventsByUserId/999' });
  assert.equal(response.statusCode, 404);
});

test('unknown user POST returns 404 without writing upstream', async t => {
  const { app, writes } = setup(t);
  const response = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Event', userId: '999' } });
  assert.equal(response.statusCode, 404);
  assert.equal(writes.length, 0);
});

test('upstream creation unavailability returns 503', async t => {
  const { app } = setup(t, [http.post('http://event.com/addEvent', () =>
    HttpResponse.json({ success: false, error: 'Unavailable' }, { status: 503 }))]);
  const response = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Event', userId: '1' } });
  assert.equal(response.statusCode, 503);
});

test('upstream internal errors are not exposed to clients', async t => {
  const { app } = setup(t, [http.post('http://event.com/addEvent', () =>
    HttpResponse.json({ message: 'Private internal error', stack: 'PRIVATE_STACK_MARKER' }, { status: 500 }))]);
  const response = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Event', userId: '1' } });
  assert.equal(response.body.includes('PRIVATE_STACK_MARKER'), false);
  assert.ok(response.statusCode >= 500);
});

test('upstream timeout retries once with a stable idempotency key, then returns 504', async t => {
  let attempts = 0;
  const keys = [];
  const { app } = setup(t, [http.post('http://event.com/addEvent', async ({ request }) => {
    attempts++;
    keys.push(request.headers.get('Idempotency-Key'));
    await delay(100);
    return HttpResponse.json({ success: true });
  })], { upstreamTimeoutMs: 30 });
  const response = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Event', userId: '1' } });
  assert.equal(response.statusCode, 504);
  assert.equal(attempts, 2);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
});

test('upstream transport error returns 502', async t => {
  const { app } = setup(t, [http.get('http://event.com/getUsers', () => HttpResponse.error())]);
  const response = await app.inject({ method: 'GET', url: '/getUsers' });
  assert.equal(response.statusCode, 502);
});

test('malformed upstream JSON returns 502', async t => {
  const { app } = setup(t, [http.get('http://event.com/getUsers', () => new HttpResponse('invalid JSON'))]);
  const response = await app.inject({ method: 'GET', url: '/getUsers' });
  assert.equal(response.statusCode, 502);
});

test('malformed user data prevents an upstream write', async t => {
  const { app, writes } = setup(t, [http.get('http://event.com/getUserById/:id', () => HttpResponse.json({ id: 1 }))]);
  const response = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Event', userId: '1' } });
  assert.equal(response.statusCode, 502);
  assert.equal(writes.length, 0);
});

test('creation response must confirm success', async t => {
  const { app } = setup(t, [http.post('http://event.com/addEvent', () => HttpResponse.json({ success: false }))]);
  const response = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Event', userId: '1' } });
  assert.equal(response.statusCode, 502);
});

test('numeric user ID and optional details remain supported', async t => {
  const { app, writes } = setup(t);
  const response = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Event', userId: 1, details: 'Some details' } });
  assert.equal(response.statusCode, 200);
  assert.equal(writes[0].details, 'Some details');
});

test('user with no events returns an empty array', async t => {
  const { app } = setup(t, [http.get('http://event.com/getUserById/:id', () =>
    HttpResponse.json({ id: 1, events: [] }))]);
  const response = await app.inject({ method: 'GET', url: '/getEventsByUserId/1' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), []);
});

test('failed event lookup returns an error rather than partial data', async t => {
  const { app } = setup(t, [http.get('http://event.com/getEventById/event-3', () =>
    new HttpResponse(null, { status: 503 }))]);
  const response = await app.inject({ method: 'GET', url: '/getEventsByUserId/1' });
  assert.equal(response.statusCode, 503);
  assert.equal(Array.isArray(response.json()), false);
});

test('invalid idempotency keys return 400 before any write', async t => {
  const { app, writes } = setup(t);
  const response = await app.inject({ method: 'POST', url: '/addEvent',
    headers: { 'Idempotency-Key': 'invalid key with spaces' }, payload: { name: 'Event', userId: '1' } });
  assert.equal(response.statusCode, 400);
  assert.equal(writes.length, 0);
});

test('Retry-After beyond the retry budget is returned without an early retry', async t => {
  let attempts = 0;
  const { app } = setup(t, [http.post('http://event.com/addEvent', () => {
    attempts++;
    return new HttpResponse(null, { status: 429, headers: { 'Retry-After': '10' } });
  })]);
  const response = await app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Event', userId: '1' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '10');
  assert.equal(attempts, 1);
});

test('only one half-open HTTP request probes upstream; reads remain available', async t => {
  let time = 0;
  let attempts = 0;
  let failing = true;
  let finishProbe;
  let startedProbe;
  const probeStarted = new Promise(resolve => { startedProbe = resolve; });
  const { app } = setup(t, [http.post('http://event.com/addEvent', async () => {
    attempts++;
    if (failing) return new HttpResponse(null, { status: 503 });
    startedProbe();
    await new Promise(resolve => { finishProbe = resolve; });
    return HttpResponse.json({ success: true });
  })], { resilience: { now: () => time, random: () => 0.5, wait: async ms => { time += ms; } } });
  const send = () => app.inject({ method: 'POST', url: '/addEvent', payload: { name: 'Event', userId: '1' } });
  assert.equal((await send()).statusCode, 503);
  const opened = await send();
  assert.equal(attempts, 3);
  assert.equal((await app.inject({ method: 'GET', url: '/getUsers' })).statusCode, 200);
  time += Number(opened.headers['retry-after']) * 1000;
  failing = false;
  const probe = send();
  await probeStarted;
  const rejected = await send();
  assert.equal(rejected.statusCode, 503);
  assert.equal(attempts, 4);
  finishProbe();
  assert.equal((await probe).statusCode, 200);
});
