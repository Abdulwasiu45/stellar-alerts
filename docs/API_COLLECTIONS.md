# API Collections — Postman & Bruno

This guide explains how to keep the Postman and Bruno collections in sync with
the Fastify OpenAPI schema, and how to use those collections to test the API
locally or against a staging environment.

## Background

The collection files are derived from `openapi.json`, which itself is generated
from the Zod schemas registered in `apps/api/src/openapi.config.ts`. Without
explicit regeneration, the collection files drift from the schema every time a
route or schema is changed.

The `collections:export` npm script regenerates both in a single step without
requiring a running API server or database.

---

## Prerequisites

- Node.js ≥ 18 and `npm` installed.
- [Postman](https://www.postman.com/downloads/) (desktop or web) **or**
  [Bruno](https://www.usebruno.com/) (open-source desktop client) for running
  requests.
- `npx` available on your `PATH` (bundled with npm ≥ 5.2).

---

## Exporting a fresh collection

Run the following command from the **workspace root**:

```bash
npm run collections:export
```

What the script does:

1. Builds the OpenAPI 3.0 document directly from the Fastify schema
   (`apps/api/src/openapi.config.ts`), without booting the full application or
   connecting to a database (the same technique used by `generate:types`).
2. Writes the spec to `openapi.json` at the workspace root.
3. Converts the spec to a Postman v2.1 collection using
   [`openapi-to-postmanv2`](https://github.com/postmanlabs/openapi-to-postman)
   via `npx`.
4. Writes the resulting collection to two locations so both are always
   identical:
   - `stellar_alerts.postman_collection.json` (workspace root)
   - `apps/api/stellar_alerts.postman_collection.json`

Commit all three files (`openapi.json` and both collection copies) together
after running the script.

> **When to run it:** any time you change a Zod schema referenced by
> `openApiComponentSchemas` in `apps/api/src/openapi.config.ts`, or add/remove
> a route. The same workflow as `generate:types` — change schema, regenerate,
> commit.

---

## Importing into Postman

### Desktop client

1. Open Postman and choose **File → Import** (or click the **Import** button in
   the sidebar).
2. Select `stellar_alerts.postman_collection.json` from the workspace root (or
   drag the file into the import dialog).
3. Postman will create a new collection named **Stellar Alerts API**.

### Environment variables

Set these Postman variables before running requests. The recommended place is a
**Postman Environment** (not Collection Variables) so you can switch between
local and staging without editing the collection itself.

| Variable | Purpose | Example value |
|---|---|---|
| `baseUrl` | API base URL | `http://localhost:3001` |
| `jwtToken` | Bearer token for protected routes | _(set by test scripts — see below)_ |
| `refreshToken` | Rotating refresh token | _(set by test scripts)_ |
| `walletId` | ID of a created wallet | _(set by create/list test scripts)_ |
| `webhookId` | ID of a created webhook | _(set by create/list test scripts)_ |
| `alertRuleId` | ID of a created alert rule | _(set by create/list test scripts)_ |
| `exportId` | ID of an export job | _(set by create/list test scripts)_ |
| `simulationId` | ID of a simulation | _(set by create/list test scripts)_ |
| `deadLetterId` | ID of a dead-letter entry | _(set by create/list test scripts)_ |

`{{jwtToken}}` is the only variable you normally need to set by hand if you
sign in outside Postman. All ID variables are saved automatically by the
create/list request test scripts when the API returns them.

### Getting a session token

**Magic link (email)**

1. Run **Authentication → Magic Link → Request Magic Link**.
   In development the response body includes a `token` field; the request's
   test script saves it to `{{magicToken}}`.
2. Run **Authentication → Magic Link → Verify Magic Link**.
   The test script saves the access token to `{{jwtToken}}` and the rotating
   refresh token to `{{refreshToken}}`.

**SEP-10 (Stellar wallet)**

1. Run **Authentication → SEP-10 → Get SEP-10 Challenge**.
   Copy the `transaction` XDR envelope from the response.
2. Sign the XDR with [Freighter](https://freighter.app/) or any Stellar SDK.
3. Paste the signed XDR into the **Verify SEP-10 Challenge** request body and
   run it. The test script saves `{{jwtToken}}` and `{{refreshToken}}`.

**Rotating the token**

Run `POST /auth/refresh` at any time. The test script updates both variables
in the active environment.

### Notes

- `GET /events` is a server-sent events (SSE) stream and will stay pending in
  Postman — this is expected.
- `GET /exports/:id/download` uses a signed query string (`expires` and `sig`)
  instead of a bearer token. Copy the `download.url` value from the
  `GET /exports/:id` response and open it in a browser or in a new Postman
  request without an Authorization header.
- Webhook provider callbacks (Slack `X-Slack-Signature`, Discord
  `X-Signature-Ed25519`, Telegram `X-Telegram-Init-Data`) require real
  signatures. The collection ships with intentionally empty placeholder values
  for these headers.

---

## Importing into Bruno

Bruno stores its collections as plain-text `.bru` files, which you can commit
alongside the codebase. Use the Bruno CLI or the desktop app to convert the
Postman collection or the OpenAPI spec.

### From the OpenAPI spec (recommended)

1. Open Bruno and choose **Import Collection → OpenAPI**.
2. Select `openapi.json` from the workspace root.
3. Bruno creates a folder structure matching the API tag groups.
4. Save the collection inside `apps/api/.postman/bruno/` (or any folder you
   prefer) and commit the `.bru` files.

### From the Postman collection

1. Open Bruno and choose **Import Collection → Postman Collection v2**.
2. Select `stellar_alerts.postman_collection.json`.
3. Save the generated `.bru` files and commit them.

### Environment variables in Bruno

Create a Bruno environment file (`.env.bru`) in your collection folder:

```
vars {
  baseUrl: http://localhost:3001
  jwtToken:
}

vars:secret [
  jwtToken
]
```

Bruno does not run Postman test scripts. Set `jwtToken` manually after
signing in with magic link or SEP-10, or write a Bruno script block in the
verify request to capture the token.

---

## Staging / production environment

Create a separate Postman Environment (or Bruno `.env.bru` file) pointing at
the staging base URL:

| Variable | Staging example |
|---|---|
| `baseUrl` | `https://api.staging.stellar-alerts.example.com` |

Do not store production tokens in committed files. Use Postman's **Vault** or
Bruno's secret variable support to keep credentials local to your machine.

---

## Schema linting

The generated Postman collection can be linted against the OpenAPI spec to
catch gaps between what the spec describes and what the collection covers.

Install [Newman](https://github.com/postmanlabs/newman) (Postman's CLI runner)
and validate the collection structure:

```bash
# Install Newman globally (once)
npm install -g newman

# Run the full collection against a local API
newman run stellar_alerts.postman_collection.json \
  --env-var "baseUrl=http://localhost:3001" \
  --reporters cli,json \
  --reporter-json-export apps/api/.postman/newman-report.json
```

For CI, the `openapi:check:breaking` script (`npm run openapi:check:breaking`)
catches backward-incompatible changes to the spec before collection regeneration
is even necessary.

---

## Keeping collections up to date

| Event | Action |
|---|---|
| New or modified Zod schema | Run `npm run collections:export`, commit all changed files |
| New route added | Run `npm run collections:export`, commit all changed files |
| `openapi.json` changes in CI | Run `npm run collections:export` locally before pushing |
| Pull request changes `openapi.config.ts` | Reviewer should confirm collection is regenerated |

A good pattern for a contributor workflow:

```bash
# 1. Make schema changes
# 2. Regenerate types and OpenAPI spec
npm run generate:types

# 3. Regenerate the Postman collection from the updated spec
npm run collections:export

# 4. Commit everything together
git add openapi.json stellar_alerts.postman_collection.json \
        apps/api/stellar_alerts.postman_collection.json \
        packages/shared/src/generated/api-types.ts
git commit -m "chore: sync openapi.json and collections"
```

---

## Related docs

- [`docs/type-generation.md`](./type-generation.md) — how `openapi.json` is built without booting the app
- [`docs/LOCAL_SETUP.md`](./LOCAL_SETUP.md) — full local development setup including Docker services
- [`docs/openapi-breaking-changes.md`](./openapi-breaking-changes.md) — breaking-change detection in CI
