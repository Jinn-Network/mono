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
 *   yarn audit:failures -- --unsafe-raw          # include raw row identifiers/reasons
 *
 * Flags:
 *   --db <path>      DB file (default: config dbPath → ~/.jinn-client/jinn.db)
 *   --days <n>       window = trailing n days (default 30)
 *   --since <ISO>    window start (overrides --days)
 *   --all            no window filter (lifetime)
 *   --drilldown      print the per-row table (all buckets)
 *   --bucket <name>  drilldown filtered to one bucket (implies --drilldown)
 *   --json           machine output (counts + rows)
 *   --unsafe-raw     print raw identifiers, DB path, and failure_reason snippets
 *   --config <path>  config file path (same resolution as the daemon)
 */

import { config as dotenvConfig } from 'dotenv';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from '../src/config.js';
import { classify, ALL_BUCKETS, type Bucket } from './classify-failure.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

const DAY_MS = 86_400_000;

interface Args {
  db?: string;
  days: number;
  since?: string;
  all: boolean;
  drilldown: boolean;
  bucket?: Bucket;
  json: boolean;
  unsafeRaw: boolean;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 30, all: false, drilldown: false, json: false, unsafeRaw: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--db':
        args.db = readFlagValue(argv, i, a);
        i++;
        break;
      case '--days':
        args.days = Number(readFlagValue(argv, i, a));
        i++;
        if (!Number.isFinite(args.days) || args.days <= 0) {
          throw new Error(`--days must be a positive number, got ${argv[i]}`);
        }
        break;
      case '--since':
        args.since = readFlagValue(argv, i, a);
        i++;
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
        const b = readFlagValue(argv, i, a);
        i++;
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
      case '--unsafe-raw':
        args.unsafeRaw = true;
        break;
      // --config is consumed by getConfigPathFromArgs; skip its value here.
      case '--config':
        readFlagValue(argv, i, a);
        i++;
        break;
      default:
        throw new Error(a.startsWith('--') ? `Unknown flag: ${a}` : `Unknown argument: ${a}`);
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

interface TableColumn {
  name: string;
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}/<redacted-url>`;
  } catch {
    return '<redacted-url>';
  }
}

function isPathWhitespace(value: string): boolean {
  return /\s/.test(value);
}

function shouldIncludeQuotedPathChar(value: string, index: number): boolean {
  const prev = value[index - 1] ?? '';
  const next = value[index + 1] ?? '';
  return /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next);
}

function findFilesystemPathEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length) {
    const ch = value[end];
    if (ch === '"' || ch === '`' || ch === '<' || ch === '>' || ch === '|') break;
    if ((ch === "'" || ch === ')' || ch === ']' || ch === '}') && !shouldIncludeQuotedPathChar(value, end)) break;
    if (ch === '\r' || ch === '\n' || ch === '\t') break;
    if (isPathWhitespace(ch)) {
      let next = end + 1;
      while (next < value.length && isPathWhitespace(value[next])) next++;
      const nextStop = value.slice(next).search(/[\s<>"`|)\]}]/);
      const nextChunk = nextStop === -1 ? value.slice(next) : value.slice(next, next + nextStop);
      if (nextChunk.includes('/') || nextChunk.includes('\\')) {
        end = next;
        continue;
      }
      break;
    }
    end++;
  }
  while (end > start && /[,;:]/.test(value[end - 1])) end--;
  return end;
}

function redactAbsoluteFilesystemPaths(value: string): string {
  const pathStart = /\/(?:Users|home|var|tmp|private|opt|Volumes|Applications|Library|System|usr|etc|mnt)(?=\/)|~\/|\$HOME\//g;
  let output = '';
  let last = 0;
  for (;;) {
    const match = pathStart.exec(value);
    if (!match) break;
    const start = match.index;
    if (start < last) continue;
    const end = findFilesystemPathEnd(value, start);
    output += `${value.slice(last, start)}<redacted-path>`;
    last = end;
    pathStart.lastIndex = end;
  }
  return `${output}${value.slice(last)}`;
}

function redactPathSegments(value: string): string {
  return redactAbsoluteFilesystemPaths(value)
    .replace(
      /(^|[\s("'`])(?:(?:~|\.\.?)\/)?(?:[A-Za-z0-9_. '-]+\/)*engine-work\/[^\s<>"'`)\]}]*/gi,
      '$1<redacted-path>',
    )
    .replace(
      /(^|[\s("'`])(?:(?:~|\.\.?)\/)?(?:[A-Za-z0-9_. '-]+\/)*hooks\/session-start\b[^\s<>"'`)\]}]*/gi,
      '$1<redacted-path>',
    )
    .replace(/\b[A-Za-z]:\\[^\s<>"`|]+(?:\s+[^\s<>"`|]+\\[^\s<>"`|]+)*/g, '<redacted-path>');
}

function redactSensitiveText(value: string): string {
  const redactedSecrets = value
    .replace(
      /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|RPC[_-]?URL|RPCURL)[A-Z0-9_]*\s*=\s*[^\s]+/gi,
      '<redacted-secret>',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+/gi, '<redacted-openrouter-key>')
    .replace(/\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]+/gi, '<redacted-openai-key>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/gi, '<redacted-openai-key>')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g, '<redacted-github-token>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '<redacted-github-token>')
    .replace(/\bhttps?:\/\/[^\s<>"')]+/gi, (url) => redactUrl(url));
  return redactPathSegments(redactedSecrets)
    .replace(/\b0x[a-fA-F0-9]{40}\b/g, '<redacted-address>')
    .replace(/\b(?:0x)?[a-fA-F0-9]{64,}\b/g, '<redacted-hex>')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, '<redacted-address>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<redacted-id>')
    .replace(/(^|[\\/ \t])req[-_][A-Za-z0-9_-]{10,}(?=$|[\\/.\s])/gi, '$1<redacted-id>')
    .replace(/(^|[\\/ \t])[0-9A-HJKMNP-TV-Z]{20,32}(?=$|[\\/.\s])/gi, '$1<redacted-id>');
}

function compactReason(reason: string | null, unsafeRaw: boolean): string {
  if (!reason) return '';
  const clean = stripTerminalControls(reason.toString()).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (unsafeRaw ? clean : redactSensitiveText(clean)).slice(0, 120);
}

function stableRef(prefix: string, value: string | null): string | null {
  if (!value) return null;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${prefix}:${digest}`;
}

function displayField(prefix: string, value: string | null, unsafeRaw: boolean): string | null {
  if (!value) return null;
  return unsafeRaw ? stripTerminalControls(value) : stableRef(prefix, value);
}

function displayText(value: string | null, unsafeRaw: boolean): string | null {
  if (!value) return null;
  const clean = stripTerminalControls(value);
  return unsafeRaw ? clean : redactSensitiveText(clean);
}

function displayDbPath(dbPath: string, unsafeRaw: boolean): string {
  const clean = stripTerminalControls(dbPath);
  if (unsafeRaw) return clean;
  const home = process.env.HOME;
  if (home && (clean === home || clean.startsWith(`${home}${sep}`))) {
    const rel = relative(home, clean);
    return rel ? `~${sep}${rel}` : '~';
  }
  if (!isAbsolute(clean)) return clean;
  return `<redacted-dir>${sep}${basename(clean)}`;
}

function getTaskRunsColumns(db: Database.Database): Set<string> {
  return new Set(
    db
      .prepare<[], TableColumn>('PRAGMA table_info(task_runs)')
      .all()
      .map((column) => column.name),
  );
}

function requireColumns(columns: Set<string>, required: string[]): void {
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`task_runs is missing required column(s): ${missing.join(', ')}`);
  }
}

function selectColumn(columns: Set<string>, column: string, optional = false): string {
  if (columns.has(column)) return column;
  if (optional) return `NULL AS ${column}`;
  throw new Error(`task_runs is missing required column: ${column}`);
}

function buildFailedRowsSql(columns: Set<string>): string {
  requireColumns(columns, ['request_id', 'solver_type', 'impl_name', 'state_updated_at', 'state', 'failure_reason']);
  const select = [
    selectColumn(columns, 'request_id'),
    selectColumn(columns, 'task_id', true),
    selectColumn(columns, 'attempt_index', true),
    selectColumn(columns, 'solver_type'),
    selectColumn(columns, 'task_role', true),
    selectColumn(columns, 'impl_name'),
    selectColumn(columns, 'solver_net_manifest_cid', true),
    selectColumn(columns, 'state_updated_at'),
    selectColumn(columns, 'failure_reason'),
  ].join(', ');
  return `
      SELECT ${select}
      FROM task_runs
      WHERE state = 'FAILED'
        AND (@all = 1 OR state_updated_at >= @sinceMs)
      ORDER BY state_updated_at DESC
    `;
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
    const sql = buildFailedRowsSql(getTaskRunsColumns(db));
    const raw = db.prepare(sql).all({
      all: args.all ? 1 : 0,
      sinceMs: sinceMs ?? 0,
    }) as FailedRow[];

    const rows: ClassifiedRow[] = raw.map((r) => {
      const { bucket, ruleId } = classify(r.failure_reason);
      return {
        requestId: displayField('req', r.request_id, args.unsafeRaw) ?? '—',
        taskId: displayField('task', r.task_id, args.unsafeRaw),
        attemptIndex: r.attempt_index,
        solverType: displayText(r.solver_type, args.unsafeRaw),
        taskRole: displayText(r.task_role, args.unsafeRaw),
        implName: displayField('impl', r.impl_name, args.unsafeRaw),
        manifestCid: displayField('cid', r.solver_net_manifest_cid, args.unsafeRaw),
        tsIso: new Date(r.state_updated_at).toISOString(),
        bucket,
        ruleId,
        reason120: compactReason(r.failure_reason, args.unsafeRaw),
      };
    });

    const total = rows.length;
    const counts: Record<string, number> = Object.fromEntries(ALL_BUCKETS.map((b) => [b, 0]));
    for (const r of rows) counts[r.bucket] += 1;
    const windowDesc = windowDescription(args, sinceMs, total);
    const inBucket = (r: ClassifiedRow): boolean => !args.bucket || r.bucket === args.bucket;

    if (args.json) {
      const out = {
        asOf: new Date().toISOString(),
        dbPath: displayDbPath(dbPath, args.unsafeRaw),
        window: {
          mode: args.all ? 'all' : args.since ? 'since' : 'days',
          days: args.all || args.since ? undefined : args.days,
          since: sinceMs ? new Date(sinceMs).toISOString() : undefined,
          description: windowDesc,
        },
        total,
        counts,
        rows: args.drilldown ? rows.filter(inBucket) : undefined,
      };
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    // Human count table — sorted descending by count.
    console.log(`Failure-cause audit  (db: ${displayDbPath(dbPath, args.unsafeRaw)})`);
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
      const drill = rows.filter(inBucket);
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
              `cid=${r.manifestCid ?? '—'}  req=${r.requestId}  task=${r.taskId ?? '—'}`,
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
