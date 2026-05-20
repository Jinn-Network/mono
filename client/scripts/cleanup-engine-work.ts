#!/usr/bin/env node
/**
 * One-shot engine working-directory cleanup (issue #320).
 *
 * The daemon provisions a heavy scratch directory per task under
 * `engine.workingDirRoot` (default `~/.jinn-client/engine/work/<requestId>/`).
 * Until the work-dir reaper shipped, nothing removed these — operators
 * accumulated hundreds of dirs / tens of GB.
 *
 * This script clears the existing backlog. It is SAFE TO RUN ON A LIVE
 * OPERATOR: it opens the daemon's SQLite store read-only, and removes a
 * directory only when it is provably safe:
 *
 *   - the matching task run is in a terminal state (COMPLETE / FAILED), or
 *   - the directory has no DB row at all AND is older than --orphan-age
 *     (default 24h) — i.e. it cannot be a task the daemon is mid-claim on.
 *
 * A directory whose task is still in-flight is NEVER removed.
 *
 * The daemon's own reaper makes this script unnecessary going forward; it
 * exists to drain the pre-fix backlog in one pass.
 *
 * Usage:
 *   yarn cleanup:engine-work                     # dry run — prints what would go
 *   yarn cleanup:engine-work -- --apply          # actually delete
 *   yarn cleanup:engine-work -- --apply --orphan-age 168h
 *   yarn cleanup:engine-work -- --config ./my-config.json --apply
 *
 * Flags:
 *   --apply            Perform deletions. Without it the script is a dry run.
 *   --orphan-age <dur> Age threshold for dirs with no DB row. Accepts `30m`,
 *                      `24h`, `7d`, or a raw millisecond count. Default 24h.
 *   --config <path>    Config file path (same resolution as the daemon).
 */

import { config as dotenvConfig } from 'dotenv';
import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from '../src/config.js';
import {
  reapWorkDirs,
  DEFAULT_ORPHAN_MAX_AGE_MS,
} from '../src/harnesses/engine/work-dir-reaper.js';
import { TERMINAL_STATES, type TaskRunState } from '../src/harnesses/engine/state.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseDuration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!m) throw new Error(`invalid --orphan-age value: ${raw}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'm': return n * 60 * 1000;
    case 's': return n * 1000;
    default:  return n; // bare number → milliseconds
  }
}

function getFlagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// ── Terminal-set extraction ───────────────────────────────────────────────────

/**
 * Read the task_runs table read-only and split request IDs into terminal vs
 * in-flight. Returns null when the DB file does not exist (fresh operator) so
 * the caller can fall back to age-only reaping.
 */
function loadIdSets(dbPath: string): {
  terminal: Set<string>;
  inFlight: Set<string>;
} | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const hasTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_runs'`)
      .get();
    if (!hasTable) return { terminal: new Set(), inFlight: new Set() };
    const rows = db
      .prepare(`SELECT request_id, state FROM task_runs`)
      .all() as Array<{ request_id: string; state: string }>;
    const terminal = new Set<string>();
    const inFlight = new Set<string>();
    for (const r of rows) {
      if (TERMINAL_STATES.has(r.state as TaskRunState)) terminal.add(r.request_id);
      else inFlight.add(r.request_id);
    }
    return { terminal, inFlight };
  } finally {
    db.close();
  }
}

// ── Disk-usage helper (best effort, for the human-readable summary) ───────────

function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      total += st.isDirectory() ? dirSizeBytes(p) : st.size;
    } catch {
      /* vanished — ignore */
    }
  }
  return total;
}

function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v < 10 && u > 0 ? 1 : 0)}${units[u]}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const orphanAgeRaw = getFlagValue(argv, '--orphan-age');
  const orphanMaxAgeMs = orphanAgeRaw
    ? parseDuration(orphanAgeRaw)
    : DEFAULT_ORPHAN_MAX_AGE_MS;

  const configPath = getConfigPathFromArgs(argv);
  const config = loadConfig(configPath);
  const workingDirRoot = config.engine.workingDirRoot;
  const dbPath = config.dbPath;

  console.log('Jinn engine work-dir cleanup (#320)');
  console.log(`  working dir root: ${workingDirRoot}`);
  console.log(`  daemon DB:        ${dbPath}`);
  console.log(`  orphan max age:   ${(orphanMaxAgeMs / 3_600_000).toFixed(1)}h`);
  console.log(`  mode:             ${apply ? 'APPLY (will delete)' : 'dry run (no deletions)'}`);

  if (!existsSync(workingDirRoot)) {
    console.log('  → working dir root does not exist; nothing to do.');
    return;
  }

  const idSets = loadIdSets(dbPath);
  if (!idSets) {
    console.log('  → no daemon DB found; treating every dir as an orphan (age-gated only).');
  }
  const terminal = idSets?.terminal ?? new Set<string>();
  const inFlight = idSets?.inFlight ?? new Set<string>();

  // Pre-compute the would-remove set so the dry run reports sizes accurately.
  const entries = readdirSync(workingDirRoot).filter((name) => {
    try {
      return statSync(join(workingDirRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  const now = Date.now();
  const candidates: string[] = [];
  for (const name of entries) {
    if (inFlight.has(name)) continue;
    const isTerminal = terminal.has(name);
    if (isTerminal) {
      candidates.push(name);
      continue;
    }
    // Orphan — age-gate it. Prefer birthtime (creation) over mtime so a
    // continuously-written orphan still ages out; fall back to mtime where
    // the platform does not record birthtime (birthtimeMs === 0). Matches
    // the daemon reaper in work-dir-reaper.ts.
    try {
      const st = statSync(join(workingDirRoot, name));
      const ageRefMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
      if (now - ageRefMs >= orphanMaxAgeMs) candidates.push(name);
    } catch {
      /* vanished — skip */
    }
  }

  // Size each candidate once, up front. The dry run reports this as the
  // reclaimable estimate; the --apply path sums the subset actually removed.
  const candidateSizes = new Map(
    candidates.map((name) => [name, dirSizeBytes(join(workingDirRoot, name))]),
  );
  const reclaimable = [...candidateSizes.values()].reduce((a, b) => a + b, 0);

  console.log(
    `  scanned ${entries.length} dir(s); ${candidates.length} removable ` +
    `(~${humanBytes(reclaimable)} reclaimable); ${inFlight.size} in-flight protected.`,
  );

  if (candidates.length === 0) {
    console.log('  → nothing to remove.');
    return;
  }

  if (!apply) {
    console.log('  Would remove:');
    for (const name of candidates.slice(0, 50)) console.log(`    - ${name}`);
    if (candidates.length > 50) console.log(`    … and ${candidates.length - 50} more`);
    console.log('  Re-run with --apply to delete.');
    return;
  }

  const report = reapWorkDirs({
    workingDirRoot,
    terminalRequestIds: terminal,
    inFlightRequestIds: inFlight,
    orphanMaxAgeMs,
  });

  const freed = report.removed.reduce(
    (sum, name) => sum + (candidateSizes.get(name) ?? 0),
    0,
  );
  console.log(`  removed ${report.removed.length} dir(s); ${humanBytes(freed)} freed.`);
  if (report.errors.length > 0) {
    console.log(`  ${report.errors.length} dir(s) could not be removed:`);
    for (const e of report.errors) console.log(`    - ${e.requestId}: ${e.error}`);
    process.exitCode = 1;
  }
}

main();
