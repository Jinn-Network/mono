#!/usr/bin/env node
/**
 * Failure-cause audit for FAILED `task_runs` rows (issue #577).
 *
 * Read-only diagnostic: opens the daemon's SQLite store
 * `{ readonly: true, fileMustExist: true }` and classifies every FAILED row in a
 * window into one of the 8 fixed buckets via the pure cascade in
 * `./classify-failure.ts`. NEVER writes to the DB. Output is a per-bucket count
 * table (default), an optional per-row drilldown (`--drilldown` / `--bucket`), and
 * a machine `--json` form for the DR's baseline distribution table.
 *
 * The only error-carrying column is `failure_reason` — there is no
 * stderr/log/trace column — so this audit's accuracy is bounded by what the engine
 * serialized into that single field (see the DR caveats).
 *
 * Usage:
 *   yarn audit:failures                          # last 30 days, count table
 *   yarn audit:failures -- --all                 # lifetime
 *   yarn audit:failures -- --days 7              # trailing 7 days
 *   yarn audit:failures -- --since 2026-05-01    # since an ISO date
 *   yarn audit:failures -- --drilldown           # per-row table, grouped by bucket
 *   yarn audit:failures -- --bucket unknown      # drilldown filtered to one bucket
 *   yarn audit:failures -- --all --json          # machine output for the DR
 *   yarn audit:failures -- --db ./other.db       # alternate DB file
 *
 * Flags:
 *   --db <path>     DB file (default: config dbPath → ~/.jinn-client/jinn.db)
 *   --days <n>      window = trailing n days (default 30)
 *   --since <ISO>   window start (overrides --days)
 *   --all           no window filter (lifetime)
 *   --drilldown     print the per-row table (all buckets)
 *   --bucket <name> drilldown filtered to one bucket (implies --drilldown)
 *   --json          machine output (counts + rows)
 *   --config <path> config file path (same resolution as the daemon)
 */

import { config as dotenvConfig } from 'dotenv';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from '../src/config.js';
import { classify, ALL_BUCKETS, type Bucket } from './classify-failure.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const DAY_MS = 86_400_000;

interface Args {
  db?: string;
  days: number;
  since?: string;
  all: boolean;
  drilldown: boolean;
  bucket?: Bucket;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 30, all: false, drilldown: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--db':
        args.db = argv[++i];
        break;
      case '--days':
        args.days = Number(argv[++i]);
        if (!Number.isFinite(args.days) || args.days <= 0) {
          throw new Error(`--days must be a positive number, got ${argv[i]}`);
        }
        break;
      case '--since':
        args.since = argv[++i];
        if (Number.isNaN(Date.parse(args.since))) {
          throw new Error(`--since must be an ISO date, got ${args.since}`);
        }
        break;
      case '--all':
        args.all = true;
        break;
      case '--drilldown':
        args.drilldown = true;
        break;
      case '--bucket': {
        const b = argv[++i];
        if (!ALL_BUCKETS.includes(b as Bucket)) {
          throw new Error(`--bucket must be one of: ${ALL_BUCKETS.join(', ')} (got ${b})`);
        }
        args.bucket = b as Bucket;
        args.drilldown = true;
        break;
      }
      case '--json':
        args.json = true;
        break;
      // --config is consumed by getConfigPathFromArgs; skip its value here.
      case '--config':
        i++;
        break;
      default:
        // Ignore unknown flags so `yarn ... -- --config x` style passthrough works.
        break;
    }
  }
  return args;
}

interface FailedRow {
  request_id: string;
  task_id: string | null;
  attempt_index: number | null;
  solver_type: string | null;
  task_role: string | null;
  impl_name: string | null;
  solver_net_manifest_cid: string | null;
  state_updated_at: number;
  failure_reason: string | null;
}

interface ClassifiedRow {
  requestId: string;
  taskId: string | null;
  attemptIndex: number | null;
  solverType: string | null;
  taskRole: string | null;
  implName: string | null;
  manifestCid: string | null;
  tsIso: string;
  bucket: Bucket;
  ruleId: string;
  reason120: string;
}

function shortCid(cid: string | null): string {
  if (!cid) return '—';
  return cid.length > 12 ? `${cid.slice(0, 10)}…` : cid;
}

function reason120(reason: string | null): string {
  if (!reason) return '';
  return reason.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function resolveDbPath(args: Args): string {
  if (args.db) return args.db;
  const config = loadConfig(getConfigPathFromArgs());
  return config.dbPath;
}

function windowDescription(args: Args, sinceMs: number | null, total: number): string {
  if (args.all) return `lifetime (no window filter), ${total} FAILED rows`;
  if (args.since) return `since ${new Date(sinceMs!).toISOString()} (--since ${args.since}), ${total} FAILED rows`;
  return `last ${args.days} days (since ${new Date(sinceMs!).toISOString()}), ${total} FAILED rows`;
}

function main(): void {
  const args = parseArgs(process.argv);
  const dbPath = resolveDbPath(args);

  let sinceMs: number | null = null;
  if (!args.all) {
    sinceMs = args.since ? Date.parse(args.since) : Date.now() - args.days * DAY_MS;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const sql = `
      SELECT request_id, task_id, attempt_index, solver_type, task_role, impl_name,
             solver_net_manifest_cid, state_updated_at, failure_reason
      FROM task_runs
      WHERE state = 'FAILED'
        AND (@all = 1 OR state_updated_at >= @sinceMs)
      ORDER BY state_updated_at DESC
    `;
    const raw = db.prepare(sql).all({
      all: args.all ? 1 : 0,
      sinceMs: sinceMs ?? 0,
    }) as FailedRow[];

    const rows: ClassifiedRow[] = raw.map((r) => {
      const { bucket, ruleId } = classify(r.failure_reason);
      return {
        requestId: r.request_id,
        taskId: r.task_id,
        attemptIndex: r.attempt_index,
        solverType: r.solver_type,
        taskRole: r.task_role,
        implName: r.impl_name,
        manifestCid: r.solver_net_manifest_cid,
        tsIso: new Date(r.state_updated_at).toISOString(),
        bucket,
        ruleId,
        reason120: reason120(r.failure_reason),
      };
    });

    const total = rows.length;
    const counts: Record<string, number> = Object.fromEntries(ALL_BUCKETS.map((b) => [b, 0]));
    for (const r of rows) counts[r.bucket] += 1;
    const windowDesc = windowDescription(args, sinceMs, total);

    if (args.json) {
      const out = {
        asOf: new Date().toISOString(),
        dbPath,
        window: {
          mode: args.all ? 'all' : args.since ? 'since' : 'days',
          days: args.all || args.since ? undefined : args.days,
          since: sinceMs ? new Date(sinceMs).toISOString() : undefined,
          description: windowDesc,
        },
        total,
        counts,
        rows: args.drilldown
          ? rows.filter((r) => !args.bucket || r.bucket === args.bucket)
          : undefined,
      };
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    // Human count table — sorted descending by count.
    console.log(`Failure-cause audit  (db: ${dbPath})`);
    console.log(`  window: ${windowDesc}`);
    console.log('');
    if (total === 0) {
      console.log('  (no FAILED rows in window)');
      return;
    }
    const sorted = [...ALL_BUCKETS].sort((a, b) => counts[b] - counts[a]);
    const widest = Math.max(...ALL_BUCKETS.map((b) => b.length));
    for (const b of sorted) {
      const n = counts[b];
      const pct = ((n / total) * 100).toFixed(1);
      console.log(`  ${b.padEnd(widest)}  ${String(n).padStart(5)}  ${pct.padStart(5)}%`);
    }
    console.log(`  ${'TOTAL'.padEnd(widest)}  ${String(total).padStart(5)}  100.0%`);

    if (args.drilldown) {
      const drill = rows.filter((r) => !args.bucket || r.bucket === args.bucket);
      console.log('');
      console.log(
        args.bucket
          ? `Drilldown — bucket=${args.bucket} (${drill.length} rows):`
          : `Drilldown — all ${drill.length} rows (grouped by bucket):`,
      );
      const order = args.bucket ? [args.bucket] : sorted;
      for (const b of order) {
        const group = drill.filter((r) => r.bucket === b);
        if (group.length === 0) continue;
        console.log('');
        console.log(`  [${b}]  (${group.length})`);
        for (const r of group) {
          console.log(
            `    ${r.tsIso}  ${r.ruleId}  attempt=${r.attemptIndex ?? '—'}  ` +
              `solver=${r.solverType ?? '—'}  role=${r.taskRole ?? '—'}  impl=${r.implName ?? '—'}  ` +
              `cid=${shortCid(r.manifestCid)}  req=${r.requestId.slice(0, 14)}…  task=${r.taskId ?? '—'}`,
          );
          console.log(`      reason: ${r.reason120 || '(empty)'}`);
        }
      }
    }
  } finally {
    db.close();
  }
}

main();
