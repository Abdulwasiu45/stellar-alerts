/**
 * collections:export — generate a fresh Postman v2.1 collection from openapi.json.
 *
 * Run via `npm run collections:export` from the workspace root.
 *
 * What it does:
 *  1. Regenerates openapi.json from the live Fastify schema (same step as
 *     `generate:types`, but only writes the OpenAPI file — no TS types).
 *  2. Converts the spec to a Postman v2.1 collection using
 *     openapi-to-postmanv2 (run via npx, no permanent install required).
 *  3. Writes the result to apps/api/.postman/stellar_alerts.postman_collection.json
 *     and to the repository root (stellar_alerts.postman_collection.json) so
 *     both locations stay in sync.
 *
 * The script does NOT require a running API server or database — it derives
 * everything from the Zod schemas registered in apps/api/src/openapi.config.ts
 * (see docs/type-generation.md for why that is safe in CI).
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildOpenApiDocument } from './generate-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const OPENAPI_FILE = path.join(ROOT, 'openapi.json');

/** Destinations that receive the generated collection. */
const COLLECTION_DESTINATIONS = [
  path.join(ROOT, 'stellar_alerts.postman_collection.json'),
  path.join(ROOT, 'apps', 'api', 'stellar_alerts.postman_collection.json'),
];

async function main(): Promise<void> {
  // ── Step 1: build the OpenAPI document ──────────────────────────────────
  console.log('[collections:export] Building OpenAPI document from Fastify schema…');
  const document = await buildOpenApiDocument();
  const openapiJson = JSON.stringify(document, null, 2) + '\n';
  await fs.writeFile(OPENAPI_FILE, openapiJson, 'utf8');
  console.log(`[collections:export] Wrote ${path.relative(ROOT, OPENAPI_FILE)}`);

  // ── Step 2: convert to Postman v2.1 ─────────────────────────────────────
  console.log('[collections:export] Converting to Postman v2.1 collection via openapi-to-postmanv2…');

  // Write to a temp location first so we can read and fan-out the result.
  const tmpOut = path.join(ROOT, 'openapi-to-postman.tmp.json');

  const result = spawnSync(
    'npx',
    [
      '--yes',
      'openapi-to-postmanv2',
      '-s', OPENAPI_FILE,
      '-o', tmpOut,
      '-p',   // pretty-print
    ],
    { stdio: 'inherit', shell: false, cwd: ROOT }
  );

  if (result.status !== 0) {
    console.error('[collections:export] openapi-to-postmanv2 exited with status', result.status);
    process.exitCode = 1;
    return;
  }

  // ── Step 3: fan-out to all destination paths ─────────────────────────────
  const collectionJson = await fs.readFile(tmpOut, 'utf8');
  await fs.unlink(tmpOut);

  for (const dest of COLLECTION_DESTINATIONS) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, collectionJson, 'utf8');
    console.log(`[collections:export] Wrote ${path.relative(ROOT, dest)}`);
  }

  console.log('[collections:export] Done. Import stellar_alerts.postman_collection.json into Postman.');
  console.log('[collections:export] See docs/API_COLLECTIONS.md for full usage instructions.');
}

main().catch((err) => {
  console.error('[collections:export] Failed:', err);
  process.exitCode = 1;
});
