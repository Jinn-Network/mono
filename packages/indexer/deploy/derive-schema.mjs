// Automated DATABASE_SCHEMA derivation (issue #1429).
//
// A `ponder.schema.ts` change to an `onchainTable` requires a fresh Ponder data
// schema — Ponder does not online-migrate, so reusing the old schema name after
// a schema change crash-loops the new container
// (`MigrationError: Schema "..." was previously used by a different Ponder app`)
// while the stale container keeps serving. That used to mean a manual Railway
// `DATABASE_SCHEMA` bump per schema PR, and forgetting it was a silent failure.
//
// This module derives the schema name at container boot from a content hash of
// `ponder.schema.ts`: an identical schema resumes in place (stable name), and
// any change lands in a fresh `jinn_indexer_<hash>` namespace automatically.
// Both the indexer and the enrichment worker feed the byte-identical schema
// file through this module, so they always derive matching names.
//
// The public-facing `jinn_indexer` VIEWS schema is unchanged: `ponder start
// --views-schema=jinn_indexer` swaps those views onto whatever data schema this
// derives on `/ready`. A hash-named data schema can never equal the literal
// `jinn_indexer` views schema, so the historical collision invariant is gone.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Matches indexer-enrichment/src/config.ts:39 (safe Postgres identifier).
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve the Ponder DATABASE_SCHEMA name.
 *
 * @param {{ schemaSource: string, env?: Record<string, string | undefined> }} args
 *   schemaSource — the raw text of `ponder.schema.ts`.
 *   env          — the process environment (defaults to `{}`).
 * @returns {string} the resolved schema name.
 */
export function resolveDatabaseSchema({ schemaSource, env = {} }) {
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

  const hash = createHash('sha256').update(schemaSource).digest('hex').slice(0, 8);
  return `jinn_indexer_${hash}`;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
// Prints ONLY the resolved schema name to stdout (so the Dockerfile CMD can
// capture it into DATABASE_SCHEMA), and a loud provenance line to stderr.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const schemaSource = readFileSync(
    fileURLToPath(new URL('../ponder.schema.ts', import.meta.url)),
    'utf8',
  );
  const name = resolveDatabaseSchema({ schemaSource, env: process.env });
  const auto = (process.env.JINN_INDEXER_SCHEMA_AUTO ?? 'true') !== 'false';
  if (auto) {
    process.stderr.write(
      `[schema] auto-derived DATABASE_SCHEMA=${name} from ponder.schema.ts\n`,
    );
  } else {
    process.stderr.write(
      `[schema] using operator-set DATABASE_SCHEMA=${name} (JINN_INDEXER_SCHEMA_AUTO=false)\n`,
    );
  }
  process.stdout.write(name);
}
