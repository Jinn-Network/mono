#!/usr/bin/env tsx
/**
 * Generates `client/openapi.v1.json` — the OpenAPI 3.1 document for the read routes
 * described by `client/src/api/contract/` (spec/2026-08-04-headless-operator-rederivation-design.md
 * §8 artifact 4). Route coverage today is `GET /v1/status`; the `ROUTES` table below is the
 * seam for adding the next one cheaply — one entry, no restructuring.
 *
 * **Zod-to-JSON-Schema conversion note (deviation from the issue's suggested approach):**
 * the task named the already-present `zod-to-json-schema` npm package (`client/package.json`)
 * as the converter. It does not understand zod v4 schema internals — run against a
 * `zod/v4`-authored schema it silently returns `{}` (verified empirically; zod-to-json-schema
 * was built against zod v3's `_def` shape, which v4 replaced). Zod v4 ships its own native
 * `z.toJSONSchema()`, which works correctly and — since OpenAPI 3.1's schema dialect *is*
 * JSON Schema draft 2020-12 — is the more correct converter for this task regardless of the
 * v3/v4 compatibility gap. `zod-to-json-schema` stays in `package.json` for its other caller
 * (`scripts/smoke-test-pack.mjs`); this script just doesn't use it.
 *
 * Run: `tsx scripts/generate-openapi.ts` (write) or `tsx scripts/generate-openapi.ts --check`
 * (compare against the committed artifact; nonzero exit on drift — same shape as
 * `.github/scripts/generate-architecture.mjs --check`).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod/v4';
import { statusV1ResponseSchema } from '../src/api/contract/status.js';
import { notificationsV1ResponseSchema } from '../src/api/contract/notifications.js';
import { CURRENT_CONTRACT_VERSION } from '../src/api/contract/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../openapi.v1.json');

interface RouteSpec {
  path: string;
  method: 'get';
  summary: string;
  responseSchema: z.ZodType;
}

// Add the next read route here — one entry, no restructuring (§8 artifact 4).
const ROUTES: RouteSpec[] = [
  {
    path: '/v1/status',
    method: 'get',
    summary: 'Operator daemon status — fleet, balances, activity, rewards, and per-vertical lifecycle rollups.',
    responseSchema: statusV1ResponseSchema,
  },
  {
    path: '/v1/notifications',
    method: 'get',
    summary: 'Server-derived operator notifications — a pure function over receipts + the live-health class (§6.5, issue #2408).',
    responseSchema: notificationsV1ResponseSchema,
  },
];

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // `unrepresentable: 'any'` covers the one deliberately-opaque field in the contract
  // (`predictionV1.operator`, a `z.custom` — see status.ts's docstring) by emitting `{}`
  // (JSON Schema "any") for it instead of throwing.
  return z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const route of ROUTES) {
    const jsonSchema = toJsonSchema(route.responseSchema);
    paths[route.path] = {
      [route.method]: {
        summary: route.summary,
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': { schema: jsonSchema },
            },
          },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Jinn operator daemon — read contract',
      version: `${CURRENT_CONTRACT_VERSION.major}.${CURRENT_CONTRACT_VERSION.minor}`,
      description:
        'Generated from client/src/api/contract/ — never handwritten (spec/2026-08-04-headless-operator-rederivation-design.md §8 artifact 4). Run `tsx scripts/generate-openapi.ts` to regenerate.',
    },
    paths,
  };
}

function serialize(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function main(): void {
  const check = process.argv.includes('--check');
  const doc = buildOpenApiDocument();
  const serialized = serialize(doc);

  if (check) {
    if (!existsSync(OUT_PATH)) {
      process.stderr.write(`openapi.v1.json is missing — run \`tsx scripts/generate-openapi.ts\` to generate it.\n`);
      process.exitCode = 1;
      return;
    }
    const committed = readFileSync(OUT_PATH, 'utf-8');
    if (committed !== serialized) {
      process.stderr.write(
        'openapi.v1.json is out of date — run `tsx scripts/generate-openapi.ts` and commit the result.\n',
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('openapi.v1.json is up to date.\n');
    return;
  }

  writeFileSync(OUT_PATH, serialized);
  process.stdout.write(`wrote ${OUT_PATH}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
