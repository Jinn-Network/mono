// Automated DATABASE_SCHEMA derivation (issues #1429, #5063).
//
// Ponder ties a data schema to the app that created it, and `ponder start`
// refuses a schema that another app holds:
//   - a different build (config, schema or indexing functions changed) gets
//     `MigrationError: Schema "..." was previously used by a different Ponder app`;
//   - the same build, while the previous deployment is still running and
//     heartbeating, gets `Failed to acquire lock on schema "..."` once the
//     heartbeat timeout has passed.
// Railway keeps the previous deployment serving until the new one is `/ready`,
// so every new deployment needs a schema of its own. Ponder's self-hosting docs
// say the same ("Each deployment must use a different schema"), and its Railway
// guide starts Ponder with `--schema $RAILWAY_DEPLOYMENT_ID`.
//
// This module names the schema after the Railway deployment:
// `jinn_indexer_<sha256(RAILWAY_DEPLOYMENT_ID)[:12]>`. A restart of the same
// deployment keeps its id, so it resumes its own schema through Ponder's crash
// recovery. Any new deployment (a merge, a variable change, a redeploy or a
// rollback) starts a fresh schema and re-indexes from Ponder's RPC cache, which
// lives in the separate `ponder_sync` schema. The id is hashed because Ponder
// caps schema names at 45 characters and the id format is Railway's, not ours.
//
// #1429 hashed `ponder.schema.ts` alone, so a build change that left that file
// alone reused the old name and crash-looped every deploy (#5063).
//
// The public-facing `jinn_indexer` VIEWS schema is unchanged: `ponder start
// --views-schema=jinn_indexer` swaps those views onto this deployment's data
// schema on `/ready`. The enrichment worker follows those views to find the
// live data schema (packages/indexer-enrichment/src/db.ts).

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Matches indexer-enrichment/src/config.ts (safe Postgres identifier).
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve the Ponder DATABASE_SCHEMA name.
 *
 * @param {{ env?: Record<string, string | undefined> }} args
 *   env — the process environment (defaults to `{}`).
 * @returns {string} the resolved schema name.
 */
export function resolveDatabaseSchema({ env = {} } = {}) {
  const auto = (env.JINN_INDEXER_SCHEMA_AUTO ?? 'true') !== 'false';

  if (!auto) {
    const name = env.DATABASE_SCHEMA;
    if (!name) {
      throw new Error(
        'JINN_INDEXER_SCHEMA_AUTO=false but DATABASE_SCHEMA is not set — ' +
          'set DATABASE_SCHEMA to an explicit name or drop the override.',
      );
    }
    if (!IDENTIFIER.test(name)) {
      throw new Error(
        `DATABASE_SCHEMA "${name}" is not a safe Postgres identifier ` +
          '(must match /^[A-Za-z_][A-Za-z0-9_]*$/).',
      );
    }
    return name;
  }

  const deploymentId = env.RAILWAY_DEPLOYMENT_ID;
  if (!deploymentId) {
    throw new Error(
      'RAILWAY_DEPLOYMENT_ID is not set, so no per-deployment schema can be derived. ' +
        'Outside Railway, set JINN_INDEXER_SCHEMA_AUTO=false and a DATABASE_SCHEMA ' +
        'that is new for every deployment.',
    );
  }
  const hash = createHash('sha256').update(deploymentId).digest('hex').slice(0, 12);
  return `jinn_indexer_${hash}`;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
// Prints ONLY the resolved schema name to stdout (so the Dockerfile CMD can
// capture it into DATABASE_SCHEMA), and a loud provenance line to stderr.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = resolveDatabaseSchema({ env: process.env });
  const auto = (process.env.JINN_INDEXER_SCHEMA_AUTO ?? 'true') !== 'false';
  if (auto) {
    process.stderr.write(
      `[schema] auto-derived DATABASE_SCHEMA=${name} for Railway deployment ${process.env.RAILWAY_DEPLOYMENT_ID}\n`,
    );
  } else {
    process.stderr.write(
      `[schema] using operator-set DATABASE_SCHEMA=${name} (JINN_INDEXER_SCHEMA_AUTO=false)\n`,
    );
  }
  process.stdout.write(name);
}
