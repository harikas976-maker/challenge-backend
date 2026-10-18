const fastify = require('fastify');
const { randomUUID } = require('node:crypto');
const { ApiError, createUpstreamClient } = require('./upstream');

function buildApp({ logger = false, upstreamTimeoutMs = 2000 } = {}) {
  const app = fastify({ logger,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }
  });
  const upstream = createUpstreamClient({ timeoutMs: upstreamTimeoutMs });
  app.setErrorHandler((error, request, reply) => {
    const status = error.validation ? 400 : error instanceof ApiError ? error.statusCode
      : error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'Request failed');
    const message = error.validation ? 'Invalid request input' : error instanceof ApiError ? error.message
      : status < 500 ? 'Invalid request' : 'Internal server error';
    reply.code(status).send({ error: message });
  });
  async function getUser(id) {
    const user = await upstream(`/getUserById/${encodeURIComponent(id)}`);
    if (!user || !Array.isArray(user.events)) throw new ApiError(502, 'Invalid user response from event service');
    return user;
  }
  app.get('/getUsers', async () => upstream('/getUsers'));
  app.get('/getEvents', async () => upstream('/getEvents'));
  app.post('/addEvent', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['name', 'userId'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        userId: { anyOf: [
          { type: 'string', pattern: '^[1-9][0-9]*$' }, { type: 'integer', minimum: 1 }
        ] },
        details: { type: 'string', maxLength: 2000 }
      }
    } }
  }, async request => {
    const { name, userId, details } = request.body;
    await getUser(userId);
    const result = await upstream('/addEvent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, userId, ...(details !== undefined ? { details } : {}), id: randomUUID() })
    });
    if (result?.success !== true) throw new ApiError(502, 'Invalid creation response from event service');
    return { success: true };
  });
  app.get('/getEventsByUserId/:id', {
    schema: { params: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string', pattern: '^[1-9][0-9]*$' } }
    } }
  }, async request => {
    const user = await getUser(request.params.id);
    const events = new Array(user.events.length);
    let nextIndex = 0;
    let failure;

    async function worker() {
      while (!failure && nextIndex < user.events.length) {
        const index = nextIndex++;
        try {
          events[index] = await upstream(`/getEventById/${encodeURIComponent(user.events[index])}`);
        } catch (error) {
          failure ??= error;
        }
      }
    }

    // Bound traffic per request and retain order regardless of completion order.
    // Drain in-flight work on failure; no worker schedules another lookup afterward.
    await Promise.all(Array.from({ length: Math.min(5, user.events.length) }, worker));
    if (failure) throw failure;
    return events;
  });
  return app;
}
module.exports = buildApp;
