const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { ApiError } = require('./upstream');
const { CircuitBreaker, CircuitOpenError } = require('./circuit-breaker');
const { IdempotencyStore, eventFingerprint } = require('./idempotency');

function createEventWriter({ upstream, getUser, logger, now = () => performance.now(), random = Math.random, wait = sleep }) {
  const breaker = new CircuitBreaker({
    now, random,
    onTransition: transition => logger.warn({ circuit: 'event-creation', ...transition }, 'Circuit state changed')
  });
  const requests = new IdempotencyStore({ now, createContext: () => ({ id: randomUUID() }) });

  async function attemptCreation({ name, userId, details }, key, id) {
    const deadline = now() + 5000;
    const body = JSON.stringify({ name, userId, ...(details !== undefined ? { details } : {}), id });
    function remainingMs() {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) throw new ApiError(504, 'Event service timed out');
      return remaining;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await breaker.execute(async () => {
          await getUser(userId, { timeoutMs: remainingMs() });
          const result = await upstream('/addEvent', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
            body, timeoutMs: remainingMs()
          });
          if (result?.success !== true) throw new ApiError(502, 'Invalid creation response from event service');
          return { success: true };
        });
      } catch (error) {
        const retryAfterSeconds = breaker.retryAfterSeconds();
        if (retryAfterSeconds && (error.dependencyFailure || error instanceof CircuitOpenError)) {
          throw new CircuitOpenError(retryAfterSeconds);
        }
        if (error.retryAfterMs) error.retryAfterSeconds = Math.ceil(error.retryAfterMs / 1000);
        // The local upstream enforces idempotency before committing a write.
        // Retry only transient dependency failures, at most once, with the same key/ID.
        if (attempt > 0 || !error.dependencyFailure) throw error;
        const delayMs = Math.max(Math.round(100 + random() * 100), error.retryAfterMs);
        if (now() + delayMs >= deadline) throw error;
        logger.info({ circuit: 'event-creation', delayMs }, 'Retrying rejected event creation');
        await wait(delayMs);
      }
    }
  }

  return async function createEvent(payload, key) {
    if (!key) return attemptCreation(payload, randomUUID(), randomUUID());
    return requests.execute(key, eventFingerprint(payload), ({ id }) => attemptCreation(payload, key, id));
  };
}

module.exports = createEventWriter;
