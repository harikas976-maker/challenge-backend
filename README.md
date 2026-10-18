# Event Management API

This is a small Node.js/Fastify API that uses MSW to mock the upstream event service.

The changes are based on [DevTask.md](DevTask.md). The main goals were to document the project, improve event lookup performance, and handle failures during event creation.

The existing routes and successful response format are unchanged. I also kept the mock's 500 ms lookup delay and failure scenarios so the improvements could be tested against the original behavior.

## Run locally

Use Node.js 24:

```sh
npm ci
npm start
```

The server runs at `http://localhost:3000`.

To run the checks:

```sh
npm test
npm audit
```

Stop the server with Ctrl+C before restarting it. If you see `EADDRINUSE`, an earlier instance is usually still using port 3000.

Restarting the server clears the mock data and request counter. Java and JMeter are only needed for performance measurements.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/getUsers` | List users |
| GET | `/getEvents` | List events |
| GET | `/getEventsByUserId/:id` | List a user's events in their original order |
| POST | `/addEvent` | Create an event |

For a POST in Postman, select **Body -> raw -> JSON** and use `Content-Type: application/json`:

```json
{
  "name": "Demo event",
  "userId": "1",
  "details": "Optional event details"
}
```

`name` and `userId` are required. Names must contain a non-whitespace character and can be up to 200 characters. User IDs accept positive integers or numeric strings. Optional `details` can be up to 2,000 characters. Unknown fields, including a supplied `id`, are rejected; new IDs are server-generated UUIDs.

Successful creation returns HTTP 200 with `{"success":true}`.

## What needed fixing

I started by testing the existing endpoints in Postman to understand how they behaved before making any changes.

One thing that stood out was that the API sometimes returned HTTP 200 even when the upstream service had failed. I also found that creating an event for a missing or unknown user could leave an event in the mock store, even though the API reported that creation had failed.

There were a few other issues. Event lookups were running sequentially, which made the response slower as the number of events increased. Input validation was missing in some places, client input could overwrite generated event IDs, and error responses exposed stack traces. There were also no upstream timeouts or recovery logic.

Another issue was that `npm test` was still a placeholder, so there wasn't a proper automated test suite to verify the changes.

I wrote ten regression tests before fixing the implementation. Two passed and eight failed against the original code. Those failures gave me a starting point and helped me check whether the changes were actually fixing the problems.

## Event lookup performance

The event lookup endpoint was taking longer than necessary because requests were being processed one at a time.

Each event lookup has an intentional 500 ms delay in the mock service. The original implementation waited for one lookup to finish before starting the next. Because of that, fetching seven events took around 3.5 seconds.

I kept the existing delay and changed the route to use five concurrent workers.

I chose a worker limit instead of starting all requests at once because a user could have a large number of events. This allows multiple lookups to run together without sending an unlimited number of requests to the upstream service.

I also made sure the results stay in their original order. Even if requests finish at different times, each event is placed back in the correct position.

If a lookup fails, workers stop taking new work once the error is detected. Requests already in progress are allowed to finish before the route returns the error. This prevents the endpoint from returning an incomplete list without indicating that something went wrong.

For a user with no events, the endpoint returns `[]`.

### Measurements

I used Postman to manually check the API behavior and JMeter to measure the performance before and after the changes.

Each JMeter run started with fresh data and used one virtual user. The test included five GET requests with two events, five successful POST requests, and five GET requests with seven events.

| Events | Before median | After median | Time reduction |
| --- | --- | --- | --- |
| 2 | 1,028 ms | 514 ms | 50.0% |
| 7 | 3,567 ms | 1,021 ms | 71.4% |

Both runs passed all 15 response checks, including event counts and order.

The tests were run on 2026-10-18 using Node 24.15.0, Java 17.0.12, and JMeter 5.6.3. The mock delay remained the same, and no warmup samples were discarded.

The [JMeter instructions](performance/README.md) explain how to repeat the test and generate an HTML report.

The results show a clear improvement in local response times, especially when fetching seven events. However, five samples aren't enough to determine how the API would perform under production traffic or establish production tail latency.

The worker limit also applies per incoming request. If multiple clients call the endpoint at the same time, the total number of upstream requests can still increase.

## Failures and recovery

The next issue I worked on was handling upstream failures during event creation.

I added a custom circuit breaker around the event creation flow, including the user lookup that happens before creating an event. I implemented this without adding a third-party circuit-breaker library.

The circuit breaker has three states:

- **Closed:** allow requests and count dependency failures in a rolling 30-second window.
- **Open:** after the third failure, return 503 with `Retry-After` without calling upstream.
- **Half-open:** after cooldown, allow one incoming request to check recovery.

If the recovery request succeeds, the circuit closes and the backoff resets. If it fails, the circuit opens again.

One detail I had to handle was the failure count. The requirement was three failures within 30 seconds, not three consecutive failures. Because of that, a successful request between failures doesn't clear the rolling window.

Invalid input and missing users don't count toward the failure threshold.

The base cooldown increases through 5, 10, 20, and 30 seconds, with +/-20% jitter and a maximum of 30 seconds.

Recovery happens through incoming requests rather than background writes. Once the cooldown ends, the next eligible request can check whether the upstream service has recovered.

The read endpoints remain independent of the creation circuit breaker.

### Retries and timeouts

For transient failures, I added one retry with a 100-200 ms delay.

Each failed attempt counts toward the circuit-breaker threshold. This means a single client request can contribute two failures if both the initial attempt and retry fail.

Retries stop when the circuit opens. They also respect the upstream `Retry-After` value as long as it fits within the remaining time budget.

Each upstream call has a two-second timeout. The complete event creation operation has a five-second limit, including the user lookup and retry delay.

These are initial settings for this project. In a real environment, I would adjust them based on the upstream service's response times, failure patterns, and recovery behavior.

## Safe POST retries

One of the more complicated cases was handling a POST request that succeeds upstream but loses its response.

For example, an event might be created successfully, but the response could be lost before the API receives it. If the API retries the request without checking, another event could be created.

I added idempotency support to handle this situation. It wasn't explicitly requested in the original brief, but it became important once automatic POST retries were introduced.

Clients can add an optional header without changing the JSON body:

```text
Idempotency-Key: event-request-001
```

Use the same key when retrying one logical creation, and a new key for a new event. Keys allow 1-128 ASCII letters, digits, or `.`, `_`, `:`, `-`.

| Request | Behavior |
| --- | --- |
| Same key and payload | Return the original successful result |
| Same key, different payload | Return 409 |
| Concurrent calls with the same key/payload | Share one operation |
| Different keys | Create separate events, even with identical data |
| No client key | Separate client POSTs remain separate creations; internal retries reuse a generated key |

I kept the event ID and idempotency key separate because they serve different purposes.

The event ID identifies the stored event. The idempotency key identifies the creation request before that event exists.

The original payload didn't include a client-provided event ID. If the server generated an ID but the response was lost, the client wouldn't know which ID had been created.

Using an event ID could work with a different API contract, but uniqueness alone wouldn't prevent duplicate user associations.

### Implementation details

Both the API and mock upstream use an in-memory `Map`, matching each key to a SHA-256 fingerprint of the name, normalized user ID, and optional details.

The API also keeps the generated event ID and operation result. Numeric and string forms of a user ID are treated as equivalent. Internal retries reuse both the key and event ID.

Records are kept for ten minutes from first admission, with a maximum of 10,000 keys per store.

Pending entries are retained. If the store reaches capacity, new keys receive 503 instead of evicting a live key. Once a record expires, its key can be used for another creation.

I also updated the mock upstream to check for duplicates before changing event data, user associations, or its failure counter.

This was important because an API-side cache alone wouldn't protect against a write that had already succeeded upstream but lost its response.

If the mock were replaced with a real upstream service, that service would need to provide the same idempotency guarantee before automatic POST retries could safely remain enabled.

## Validation and errors

I added input validation before upstream work so invalid requests are rejected early.

I also changed the mock creation flow to verify that the user exists before modifying the event store.

Previously, a failed creation could still leave an event behind. With this change, rejected writes don't leave orphan events in the mock store.

This adds a user lookup before creation. For a real database, transactional consistency would still be needed at the write boundary.

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, JSON, or key format |
| 404 | User or upstream resource not found |
| 409 | Key reused with different data |
| 502 | Failed or invalid upstream response |
| 503 | Upstream unavailable, circuit blocking calls, or idempotency capacity reached |
| 504 | Upstream timeout or creation budget exhausted |

Errors return a safe `error` message without internal stacks or paths.

Circuit transitions and retry delays are logged without including event bodies or idempotency keys.

## Checks and decisions worth noting

The project now has **49 passing tests**, using `node:test`, Fastify injection, and MSW.

The tests cover HTTP contracts, rejected writes, timeout and retry limits, failure-window boundaries, recovery, concurrent calls, and idempotency.

I also added a test for a situation where a write succeeds in the mock service but the response is lost. The test checks that retrying the request doesn't create another event.

Another test repeats the request through a fresh API instance to make sure duplicate prevention doesn't depend only on the original instance's local cache.

A few things came up while I was working on the tests:

- **Mock failure counter:** The mock starts failing after five successful attempts. Initially, this interfered with some validation checks because the mock had already reached its failure state. I used fresh state for independent checks so the tests wouldn't affect each other.
- **Random read failures:** The mock can randomly fail during event reads. I kept this behavior for manual testing but used controlled responses in automated tests so the results would be repeatable.
- **Recovery behavior:** The mock recovers based on attempt count rather than elapsed time. Several spaced recovery probes may be needed. I kept this behavior instead of changing the counter just to make the tests pass.
- **Half-open concurrency:** Only one half-open probe is admitted. I also added generation checks so an older request finishing late can't change a newer circuit state.
- **Idempotency conflicts:** If the upstream service rejects a key because it belongs to a different payload, a fresh API instance must not cache the incorrect payload. I tested this along with a later replay of the original request.
- **Response cancellation:** During development, waiting for cancellation of an intercepted stream caused error handling to stall. I changed this so cancellation no longer delays the status-based response.

For recovery tests, I used a controlled clock instead of waiting through real cooldown periods.

I kept performance testing separate from the unit tests. JMeter was used for the performance comparison, while the automated tests focused on behavior without relying on latency thresholds.

After the changes, I ran a fresh `npm ci` installation and the full test suite passed. The syntax and diff checks also passed.

### Dependencies and project setup

The original dependency audit flagged Fastify and its transitive router.

I upgraded Fastify to 5.12.7. The audit on 2026-10-18 reported zero known vulnerabilities.

I set Node.js 24 as the project runtime so development and test runs use the same major version. The committed lockfile lets `npm ci` install the same dependency versions instead of resolving a new tree each time.

The lockfile also resolves MSW to 2.15.0. MSW remains a runtime dependency because the application uses it during startup.

I separated app construction from listening so tests don't depend on port 3000.

The performance runner starts its own server on a free port and accepts an explicit Java executable. This also helped me work around the local Java PATH launcher issue.

The package is marked `private` to prevent npm publication. GitHub visibility is unaffected.

## Remaining work

The original brief allows unfinished work to be documented. These are the areas I would work on next:

- **Persistent storage:** Events and idempotency records are stored in memory. They reset when the application restarts and aren't shared across replicas. Circuit-breaker state is also local to each application instance and resets on restart. I would persist event creation and its idempotency record atomically, scope keys to an authenticated caller, and decide how recovery should be coordinated across instances.
- **Concurrent load testing:** The current performance tests use one virtual user. I would run tests with multiple concurrent clients before choosing a global upstream limit or adjusting timeout and backoff settings.
- **Request cancellation:** I would add client-disconnect cancellation and an overall deadline for event reads.
- **Startup configuration:** I would make the normal startup host and port configurable and add startup and shutdown tests.
- **Fixture cleanup:** The original fixtures have a few inconsistencies. User 3 exposes ID 2, and some seeded event IDs are repeated. These are data issues rather than evidence of duplicate event fetching.
- **CI and code quality:** I would add CI checks for clean installation, automated tests, and dependency audits, along with linting and formatting checks.

This exercise doesn't include a production database, authentication, or deployment setup.

I kept the deliberate 500 ms delay, random read errors, and five-success/ten-failure creation cycle because they are part of the mock behavior and are useful for testing failure handling.

That cycle counts upstream creation attempts, not client requests. An automatic retry uses another attempt, while a successful idempotent replay doesn't advance the counter.

## References

These are the references I used for the implementation choices and verification approach:

- [Fastify v5 migration guide](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/), [validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), and [testing](https://fastify.dev/docs/latest/Guides/Testing/) cover the upgrade, request schemas, and testing the app without starting a listening server.
- [Node.js abort signals](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay) explain the timeout mechanism, and [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/) documents clean installation from the lockfile.
- [Microsoft's circuit-breaker pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker) describes the closed, open, and half-open states and how recovery probes should be limited.
- [AWS on retries, backoff, and jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) explains why retries need limits, while [idempotent API design](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) covers caller intent and duplicate-write protection.
- [HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) defines the retry-delay header used in error responses.
- [JMeter's getting-started guide](https://jmeter.apache.org/usermanual/get-started.html) covers command-line runs and reports. [Postman's Collection Runner](https://learning.postman.com/docs/tests-and-scripts/running-collections/intro-to-collection-runs) covers repeated requests and result inspection.

The worker count, timeout values, cooldowns, and retention limits are choices for this project. They aren't fixed values required by these references.
