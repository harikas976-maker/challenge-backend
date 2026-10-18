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
Each upstream request has a two-second timeout. Writes are not automatically
retried because an ambiguous failure could otherwise duplicate an event.

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

Circuit breaking and backoff are not yet implemented. The service has no persistent
storage or authentication and is intended for this development exercise.
