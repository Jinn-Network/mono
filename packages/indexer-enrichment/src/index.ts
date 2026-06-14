#!/usr/bin/env node
/**
 * Bin entry for the verdict-envelope enrichment worker (#779).
 *
 * Boot path is fail-loud (the #1068 lesson): a DB-connect failure logs and exits
 * non-zero so Railway's ON_FAILURE policy restarts the process through this same
 * idempotent boot, rather than silently wedging an unobservable worker. The
 * worker writes ONLY verdict_envelope_meta on the indexer's shared
 * DATABASE_SCHEMA.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadConfig } from './config.js';
import { EnrichmentStore, type DrizzleLike } from './db.js';
import { EnrichmentRunner } from './runner.js';
import type { EnrichDeps } from './enrich.js';
import { createStatusServer } from './http.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // search_path set per-connection so every schema-unqualified identifier the
  // driver might emit resolves into the indexer's DATABASE_SCHEMA. The store's
  // own statements are explicitly schema-qualified regardless.
  const pool = new Pool({
    connectionString: config.databaseUrl,
    options: `-c search_path=${config.databaseSchema}`,
  });

  // Fail loud at boot if the DB is unreachable — exit non-zero so Railway
  // restarts us. A reachable-but-schema-missing DB is NOT a boot failure
  // (store.ready() handles that as "not ready, back off").
  try {
    const probe = await pool.connect();
    probe.release();
  } catch (err) {
    console.error(
      `[indexer-enrichment] FATAL: cannot connect to Postgres at boot: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    await pool.end().catch(() => {});
    process.exit(1);
  }

  const db = drizzle(pool) as unknown as DrizzleLike;
  const store = new EnrichmentStore(db, config.databaseSchema);

  const deps: EnrichDeps = {
    ipfsGateway: config.ipfsGateway,
    ipfsTimeoutMs: config.ipfsTimeoutMs,
    batchSize: config.batchSize,
    maxRetries: config.maxRetries,
    // The indexer is single-chain Base-Sepolia testnet; chainId is fixed at the
    // worker's deploy. Wired from the same convention the indexer uses.
    chainId: 84532,
    now: () => Date.now(),
  };

  const runner = new EnrichmentRunner(store, deps, {
    pollIntervalMs: config.pollIntervalMs,
  });

  console.error(
    `[indexer-enrichment] starting: schema=${config.databaseSchema} batchSize=${config.batchSize} pollIntervalMs=${config.pollIntervalMs} port=${config.port}`,
  );

  await runner.start();

  const server = createStatusServer({ config, runner });
  server.listen(config.port, '0.0.0.0');

  const shutdown = () => {
    runner.stop();
    server.close();
    void pool.end();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(
    `[indexer-enrichment] FATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
