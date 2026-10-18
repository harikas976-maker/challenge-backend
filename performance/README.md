# Event lookup measurements with JMeter

This plan measures one client's local response time. It does not establish
production capacity or replace a concurrent load test. There are no unit-test
timing thresholds. Existing functional regressions remain under `npm test`.

## Prerequisites

- Node.js 24 and project dependencies (`npm ci`).
- Java 8 or newer supported by Apache JMeter; this run uses Java 17.
- Extract the [official JMeter 5.6.3 binary distribution](https://jmeter.apache.org/download_jmeter.cgi)
  and verify its published checksum. No JMeter plugins are required.

## Run automatically

From the project root in Command Prompt, replace the tool paths as appropriate:

```cmd
node performance/run-jmeter.cjs --jmeter-home "C:\tools\apache-jmeter-5.6.3" --java "C:\Program Files\Java\jdk-17\bin\java.exe" --label before
```

Use `--label after` on the implementation being compared. Alternatively set
`JMETER_HOME` and `JAVA_HOME`; a Java executable on PATH is also supported.
The label only names output; it does not switch code versions. Run once before
editing and again after the change with matching tool versions and machine load.

The runner starts a fresh real app/mock process on a free loopback port and stops
only that process afterward. An existing developer server is unaffected. JMeter
runs in CLI mode, produces raw CSV samples (`samples.jtl`), an HTML dashboard
(`report/index.html`), server logs, and `summary.json`, under ignored `results/`.
The runner rejects incomplete or failed runs even if JMeter exits with code zero.

One virtual user performs, in order:

1. Five GETs for user 1 with two events.
2. Five valid POSTs creating events for user 1.
3. Five GETs for user 1 with seven events.

The plan asserts HTTP status, event counts and names in their original order, and
successful creation. It stops on failure rather than timing an incorrect fixture.
The mock's 500 ms delay and failure cycle are unchanged. Only five POSTs are made,
so a fresh mock does not enter the overloaded phase.

Compare each GET label's median/minimum/maximum separately. The dashboard's global
average mixes POST setup and GET timings and is not the performance comparison.
Five samples are a small local check; do not present their p95/p99 as meaningful
production percentiles. If repeating runs, use the same warmup policy on both
versions; this plan has no discarded warmup samples.

## Run an existing server manually

Restart it first; user 1 must have exactly two events and a fresh POST counter.
Do not send other requests during the run. Use a new output directory each time:

```cmd
jmeter -n -t performance/event-lookup.jmx -Jhost=localhost -Jport=3000 -l performance/results/manual-before.jtl -j performance/results/manual-before.log -e -o performance/results/manual-before-report
```

## Rationale and limits

The worker pool allows at most five outstanding lookups per incoming request;
results are stored by original index. It stops scheduling new work after an
observed failure and waits for already-started calls before returning an error.
Two events should need one 500 ms batch; seven should need two batches. These
are expectations, not fixed pass/fail latency thresholds. A global upstream cap,
multi-user capacity study, and whole-request deadline are separate concerns.

Apache recommends [CLI mode for performance runs](https://jmeter.apache.org/usermanual/get-started.html).
The plan uses standard [HTTP samplers](https://jmeter.apache.org/usermanual/component_reference.html#HTTP_Request)
and [JSR223 assertions](https://jmeter.apache.org/usermanual/component_reference.html#JSR223_Assertion)
to verify responses before accepting measurements.
