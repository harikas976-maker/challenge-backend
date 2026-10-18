# Event management backend

Use Node.js 24. Install with `npm ci`, start with `npm start`, and run checks with
`npm test`. Stop the previous server with Ctrl+C before restarting on port 3000.

The API runs at `http://localhost:3000`:

- `GET /getUsers`
- `GET /getEvents`
- `GET /getEventsByUserId/:id`
- `POST /addEvent` with JSON such as `{"name":"Demo event","userId":"1"}`

Event creation requires a nonblank name (maximum 200 characters) and a positive
integer user ID, as a number or numeric string. Optional `details` accepts up to
2000 characters. Other fields, including client-supplied `id`, are rejected.
New event IDs are server-generated UUID strings. Successful creation continues to
return HTTP 200 with `{"success":true}`.

Invalid input returns 400, unknown users return 404, upstream overload returns
503, invalid or failed upstream responses return 502, and upstream timeouts return
504. Error bodies contain a safe `error` message; internal stacks are not exposed.
Each upstream attempt has a two-second timeout; event creation has a five-second
overall budget, including its user lookup, retry delay and any retry.

MSW supplies the upstream API in this local application. Data resets on restart.
Individual event lookups deliberately take 500 ms. Some reads randomly fail;
creation cycles through five successes and ten failures. These simulations remain
enabled. Automated tests use controlled upstream responses to avoid random test
failures and also verify rejected writes against the real mock.

Event lookup runs up to five requests concurrently per incoming request and
preserves event order. This cap is per request, not a global limit across clients.
If a lookup fails, no further lookups are scheduled and the request returns an
error after in-flight work finishes. See [the JMeter plan](performance/README.md)
for reproducible local latency measurements.

## Event creation resilience

A custom circuit breaker protects the event-creation operation, including its
upstream user lookup. Three dependency failures in a rolling 30-second window
open the circuit. Successes between failures do not erase failures in that window;
client validation and missing-user errors do not count. Each failed outbound
attempt counts, so one request can contribute two failures if retried.

While open, valid new writes return 503 with `Retry-After` without any upstream
call. After cooldown, one incoming write probes recovery. A successful probe
closes the circuit; a failed probe reopens it. Base cooldown increases from 5 to
10 to 20 to 30 seconds, with +/-20% jitter and a 30-second cap. A bounded upstream
`Retry-After` can extend the cooldown. No background writes are generated. State
transitions and retry delays are logged without event bodies or idempotency keys.

Transient dependency failures allow at most one retry, with 100-200 ms jitter
and the same event ID and idempotency key. Retries honor upstream `Retry-After`
when it fits the remaining budget and stop if the circuit opens. This is safe
because the supplied mock implements upstream idempotency; a replacement upstream
must provide the same guarantee before write retries are enabled.

## Idempotent POST requests

Optionally send `Idempotency-Key: your-unique-request-key` with a POST. Keys accept
1-128 ASCII letters/digits or `.`, `_`, `:`, `-`. Reuse a key for retries of the
same logical creation, and use a new key for a new event.

- Same key and payload: return the original successful result without a new write.
- Concurrent calls with the same key: share one operation.
- Same key and different payload: return 409, without overwriting the event.
- Without a client key: internal retries are still deduplicated, but separate
  client requests are treated as separate creations.

Both the API and mock upstream retain idempotency entries for ten minutes from
first admission, up to 10,000 keys per process. They reject new keys at capacity
with 503 rather than evicting live keys. Expired keys can create new events again.
Numeric and string user IDs are treated equivalently when matching payloads.
The mock checks idempotency before applying its five-success/ten-failure cycle;
successful replays do not consume that counter or create duplicate associations.
The mock recovers by attempt count, not wall time, so several spaced probes can
be required before it accepts a new write.

This exercise uses in-memory stores: breaker and idempotency state reset on
restart and are not shared across replicas. A production service needs durable
idempotency records committed atomically with event creation and scoped to the
authenticated caller. Persistence, authentication, and deployment are outside
this exercise. Defaults here need tuning against real upstream latency/load.

The design follows [circuit-breaker guidance](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker),
[retry and idempotency guidance](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/),
and [HTTP Retry-After semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after).
