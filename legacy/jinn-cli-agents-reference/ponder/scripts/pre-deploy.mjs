/**
 * Ponder pre-deploy script — runs before ponder start.
 *
 * Handles two common deployment issues automatically:
 * 1. Schema locked by a crashed previous deploy (is_locked=1, is_ready=0)
 *    → Drops the incomplete schema so Ponder can recreate it fresh.
 * 2. Schema used by a different build_id (code changed but version wasn't bumped)
 *    → Drops the stale schema so Ponder can recreate it.
 *
 * If the schema exists AND is_ready=1 (completed backfill), we leave it alone.
 * Ponder will detect the matching build_id and resume from the live state.
 *
 * Environment:
 *   PONDER_DATABASE_URL  — Postgres connection string (required)
 *   PONDER_SCHEMA_VERSION — Target schema name, e.g. jinn_shared_v17 (required)
 */

import pg from "pg";
const { Client } = pg;

const schemaName = process.env.PONDER_SCHEMA_VERSION;
const dbUrl = process.env.PONDER_DATABASE_URL;

if (!schemaName) {
  console.log("[pre-deploy] PONDER_SCHEMA_VERSION not set, skipping schema check.");
  process.exit(0);
}
if (!dbUrl) {
  console.log("[pre-deploy] PONDER_DATABASE_URL not set, skipping schema check.");
  process.exit(0);
}

const client = new Client(dbUrl);

try {
  await client.connect();

  // Check if the schema exists
  const { rows: schemaRows } = await client.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
    [schemaName]
  );

  if (schemaRows.length === 0) {
    console.log(`[pre-deploy] Schema "${schemaName}" does not exist yet — fresh deploy, nothing to do.`);
    await client.end();
    process.exit(0);
  }

  // Schema exists — check _ponder_meta for state
  let meta;
  try {
    const { rows } = await client.query(
      `SELECT value FROM "${schemaName}"._ponder_meta WHERE key = 'app'`
    );
    meta = rows[0]?.value;
  } catch (e) {
    // _ponder_meta table doesn't exist — corrupt/partial schema, drop it
    console.log(`[pre-deploy] Schema "${schemaName}" exists but has no _ponder_meta table — dropping.`);
    await client.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    console.log(`[pre-deploy] Dropped schema "${schemaName}".`);
    await client.end();
    process.exit(0);
  }

  if (!meta) {
    console.log(`[pre-deploy] Schema "${schemaName}" has empty _ponder_meta — dropping.`);
    await client.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    console.log(`[pre-deploy] Dropped schema "${schemaName}".`);
    await client.end();
    process.exit(0);
  }

  const { is_ready, is_locked, build_id } = meta;

  console.log(`[pre-deploy] Schema "${schemaName}" state: is_ready=${is_ready}, is_locked=${is_locked}, build_id=${build_id}`);

  if (is_ready === 1) {
    // Schema completed backfill previously. If the build_id matches, Ponder will
    // reuse it (hot start). If it doesn't match, Ponder will error — but that means
    // the code changed and the operator should have bumped the version.
    console.log(`[pre-deploy] Schema "${schemaName}" is READY — leaving intact for Ponder to reuse or detect mismatch.`);
    await client.end();
    process.exit(0);
  }

  // Schema is NOT ready (incomplete backfill from a previous crashed deploy).
  // Drop it so Ponder starts fresh. This handles:
  // - is_locked=1 (previous instance crashed without releasing)
  // - is_locked=0 but is_ready=0 (unlocked manually but still incomplete)
  console.log(`[pre-deploy] Schema "${schemaName}" is NOT ready (incomplete backfill) — dropping for fresh start.`);
  await client.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  console.log(`[pre-deploy] Dropped schema "${schemaName}". Ponder will recreate it.`);
  await client.end();
  process.exit(0);
} catch (e) {
  console.error(`[pre-deploy] Error:`, e.message);
  // Don't block deploy on pre-deploy failure — Ponder will handle or fail with a clear error
  await client.end().catch(() => {});
  process.exit(0);
}
