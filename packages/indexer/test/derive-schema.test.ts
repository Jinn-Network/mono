/**
 * Regression tests for automated DATABASE_SCHEMA derivation (issues #1429, #5063).
 *
 * Ponder ties a data schema to the app that created it. `ponder start` refuses
 * a schema created by a different build (`MigrationError: Schema "..." was
 * previously used by a different Ponder app`) and a schema whose app is still
 * running (`Failed to acquire lock on schema "..."`). Railway keeps the old
 * deployment serving until the new one is `/ready`, so each deployment needs a
 * schema of its own, and a restart of the same deployment must find its own
 * schema again to resume instead of re-indexing.
 *
 * #1429 hashed `ponder.schema.ts` alone, so a build that changed anything else
 * (handlers, config, dependencies) derived the same name and every deploy
 * crash-looped (#5063). The first test drives the boot CLI exactly as the
 * Dockerfile CMD does, for two builds that share `ponder.schema.ts`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { resolveDatabaseSchema } from '../deploy/derive-schema.mjs';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deriveScript = path.join(packageRoot, 'deploy', 'derive-schema.mjs');
const ponderSchema = readFileSync(path.join(packageRoot, 'ponder.schema.ts'), 'utf8');

// Railway deployment ids are UUIDs; these are made-up test values.
const DEPLOYMENT_A = '3f1c2a9e-8b4d-4f6a-9c2e-1d7b5a3e9f01';
const DEPLOYMENT_B = 'b7e04d12-5c3a-4e8f-a1d9-6f2c8b0e4a73';

// Ponder rejects schema names longer than this (ponder/src/drizzle/onchain.ts).
const PONDER_MAX_SCHEMA_NAME_LENGTH = 45;

interface Build {
  schema: string;
  config: string;
  handlers: string;
}

/**
 * Lay out one image the way the Dockerfile does (`deploy/derive-schema.mjs`
 * next to `ponder.schema.ts`, `ponder.config.ts` and `src/`) and run the boot
 * CLI in it with the given environment, returning what the CMD would export.
 */
function bootDerive(build: Build, env: Record<string, string>): string {
  // realpath: the CLI's main-module guard compares against argv[1], which must
  // not run through a symlinked temp directory (macOS /var -> /private/var).
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'jinn-indexer-image-'));
  mkdirSync(path.join(root, 'deploy'));
  mkdirSync(path.join(root, 'src'));
  copyFileSync(deriveScript, path.join(root, 'deploy', 'derive-schema.mjs'));
  writeFileSync(path.join(root, 'ponder.schema.ts'), build.schema);
  writeFileSync(path.join(root, 'ponder.config.ts'), build.config);
  writeFileSync(path.join(root, 'src', 'handlers.ts'), build.handlers);
  return execFileSync(process.execPath, [path.join(root, 'deploy', 'derive-schema.mjs')], {
    env,
    encoding: 'utf8',
  });
}

describe('derive-schema boot CLI (issue #5063)', () => {
  it('gives a build that changed everything but ponder.schema.ts a schema of its own', () => {
    const running: Build = {
      schema: ponderSchema,
      config: 'export default { contracts: { JinnRouter: { startBlock: 1 } } };\n',
      handlers: 'export const handlerVersion = 1;\n',
    };
    const next: Build = {
      schema: ponderSchema,
      config: 'export default { contracts: { JinnRouter: { startBlock: 2 } } };\n',
      handlers: 'export const handlerVersion = 2;\n',
    };

    const runningName = bootDerive(running, { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A });
    const nextName = bootDerive(next, { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_B });

    // Same name under a different Ponder build is the crash loop in #5063.
    expect(nextName).not.toBe(runningName);
  });

  it('resumes the same schema when the same deployment restarts', () => {
    const build: Build = {
      schema: ponderSchema,
      config: 'export default {};\n',
      handlers: 'export const handlerVersion = 1;\n',
    };
    const first = bootDerive(build, { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A });
    const restart = bootDerive(build, { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A });
    expect(restart).toBe(first);
  });
});

describe('resolveDatabaseSchema (issues #1429, #5063)', () => {
  it('(a) is stable across restarts of one deployment', () => {
    const a = resolveDatabaseSchema({ env: { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A } });
    const b = resolveDatabaseSchema({ env: { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A } });
    expect(a).toBe(b);
  });

  it('(b) gives every new deployment a fresh name, even for an unchanged build', () => {
    // An unchanged build redeployed (a variable change, a docs-only merge, a
    // manual redeploy) overlaps the running deployment until /ready, and Ponder
    // will not share a schema with an app that still holds its lock.
    const a = resolveDatabaseSchema({ env: { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A } });
    const b = resolveDatabaseSchema({ env: { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_B } });
    expect(a).not.toBe(b);
  });

  it('(c) matches the pinned sha256(RAILWAY_DEPLOYMENT_ID)[:12] algorithm', () => {
    const expected =
      'jinn_indexer_' + createHash('sha256').update(DEPLOYMENT_A).digest('hex').slice(0, 12);
    expect(resolveDatabaseSchema({ env: { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A } })).toBe(expected);
  });

  it('(d) honors a manual override when auto is disabled', () => {
    const name = resolveDatabaseSchema({
      env: {
        JINN_INDEXER_SCHEMA_AUTO: 'false',
        DATABASE_SCHEMA: 'jinn_indexer_v9',
        RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A,
      },
    });
    expect(name).toBe('jinn_indexer_v9');
  });

  it('(e) rejects an invalid manual override', () => {
    expect(() =>
      resolveDatabaseSchema({
        env: { JINN_INDEXER_SCHEMA_AUTO: 'false', DATABASE_SCHEMA: '9bad-name' },
      }),
    ).toThrow();
  });

  it('(f) fails loud when auto is disabled but no DATABASE_SCHEMA is set', () => {
    expect(() =>
      resolveDatabaseSchema({ env: { JINN_INDEXER_SCHEMA_AUTO: 'false' } }),
    ).toThrow();
  });

  it('(g) derives a safe Postgres identifier Ponder accepts, distinct from the views schema', () => {
    // Conformance to indexer-enrichment/src/config.ts (`/^[A-Za-z_][A-Za-z0-9_]*$/`)
    // and to Ponder's own schema-name length check.
    const name = resolveDatabaseSchema({ env: { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A } });
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(name.length).toBeLessThanOrEqual(PONDER_MAX_SCHEMA_NAME_LENGTH);
    expect(name).not.toBe('jinn_indexer');
  });

  it('(h) auto-derives by default and treats explicit true identically', () => {
    const def = resolveDatabaseSchema({ env: { RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A } });
    const explicit = resolveDatabaseSchema({
      env: { JINN_INDEXER_SCHEMA_AUTO: 'true', RAILWAY_DEPLOYMENT_ID: DEPLOYMENT_A },
    });
    expect(explicit).toBe(def);
  });

  it('(i) fails loud in auto mode without a Railway deployment id', () => {
    expect(() => resolveDatabaseSchema({ env: {} })).toThrow(/JINN_INDEXER_SCHEMA_AUTO=false/);
  });
});
