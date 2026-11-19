# Chaos Engineering Fault Injection

Automated fault injection proving the system's self-healing guarantees
under infrastructure degradation, built from one test file
(`apps/api/src/__tests__/chaos.test.ts`) and two supporting pieces of CI
infra (`docker-compose.yml`'s `toxiproxy`/`redis` services, and the
`chaos` job in `.github/workflows/ci.yml`).

## Three groups of tests, one file

### 1. HTTP fault injection (Toxiproxy-backed)

A minimal fixture HTTP server stands in for Horizon. Toxiproxy sits
between a Node HTTP client and that fixture, injecting real network
faults:

- **3-second latency**: asserts the client-observed round trip actually
  reflects the injected delay.
- **Severed connection, then restored**: proves a heartbeat-driven
  reconnect loop (the same pattern `workers/watcher.worker.ts`'s
  `startHorizonSSEStream` uses) detects the outage and resumes receiving
  messages once connectivity returns.

### 2. Redis fault injection (Toxiproxy-backed)

A real local Redis is proxied through Toxiproxy. A minimal BullMQ
`Queue`/`Worker` pair (built fresh in the test, not
`lib/queue.ts`'s production singleton — see the comment at the top of
this section in the test file for why) processes a job, has its Redis
connection severed mid-flight, then restored:

- Asserts the worker reconnects (BullMQ/ioredis's own documented
  `retryStrategy` behavior) rather than hanging or crashing.
- Asserts exactly one delivery each for a job enqueued before the outage
  and one enqueued after recovery — no duplicate processing, nothing
  silently dropped.

### 3. Deterministic fault injection (no Docker needed)

Exercises the real `workers/watcher.worker.ts`'s `pollOnce` against a
simulated Horizon/DB fault via mocks — a rejected `getPaymentsSince`, a
rejected `wallet.findMany`, and an all-nodes-outage response that
clears on the next poll. These always run (including in the main CI
job) and prove the actual crash-prevention code path, not a stand-in.

## Running locally

Groups 1 and 2 are skipped entirely unless `TOXIPROXY_URL` is set:

```bash
docker compose up -d toxiproxy redis
# macOS/Windows Docker Desktop: toxiproxy's host-networking trick for the
# HTTP fixture doesn't apply the same way — see docker-compose.yml's
# comment on the toxiproxy service for the platform-specific workaround.
TOXIPROXY_URL=http://localhost:8474 npx vitest run src/__tests__/chaos.test.ts
```

Group 3 always runs as part of the normal `npx vitest run` suite.

## CI

The `chaos` job in `.github/workflows/ci.yml` runs on every PR,
independent of the main `test` job: it brings up `toxiproxy` and `redis`
via `docker compose`, waits for both to report healthy, then runs this
file with `TOXIPROXY_URL` / `TOXIPROXY_UPSTREAM_HOST` /
`TOXIPROXY_REDIS_UPSTREAM_HOST` pointed at the runner, so groups 1 and 2
execute for real rather than skipping.
