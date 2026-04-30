import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

/**
 * SQLite stores `artifacts.created_at` via the default CURRENT_TIMESTAMP
 * format: `YYYY-MM-DD HH:MM:SS` (space separator, no fractional seconds, no
 * trailing 'Z'). ISO 8601 timestamps from JS (e.g. new Date().toISOString())
 * use `T` and `Z`. SQLite's TEXT comparison is lexicographic, and 'T' > ' ',
 * so `created_at >= '2026-04-30T10:18:50.041Z'` excludes EVERY row dated
 * `'2026-04-30 ...'` regardless of clock order.
 *
 * Convert ISO 8601 to the SQLite TEXT format before binding so the
 * comparison is meaningful.
 */
export function isoToSqliteTimestamp(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return iso;
  // Match `YYYY-MM-DDTHH:MM:SS(.sss)?Z?` and rewrite to `YYYY-MM-DD HH:MM:SS`.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/);
  if (!m) return iso;
  return `${m[1]} ${m[2]}`;
}

export function normalizeTags(rawTags) {
  if (Array.isArray(rawTags)) {
    return rawTags.map((tag) => String(tag));
  }
  if (typeof rawTags !== 'string' || rawTags.trim() === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(rawTags);
    return Array.isArray(parsed) ? parsed.map((tag) => String(tag)) : [];
  } catch {
    return [];
  }
}

export function summarizeArtifactRows(rows, desiredStateIds) {
  const byRestorationJob = Object.fromEntries(
    desiredStateIds.map((id) => [id, {
      restorationArtifacts: 0,
      successfulRestorations: 0,
      evaluationArtifacts: 0,
      successfulEvaluations: 0,
      latestArtifactAt: null,
      requestIds: [],
    }]),
  );

  for (const row of rows) {
    const state = byRestorationJob[row.desired_state_id];
    if (!state) continue;
    const tagSet = new Set(normalizeTags(row.tags));
    if (tagSet.has('restoration-result')) {
      state.restorationArtifacts += 1;
      if (row.outcome === 'SUCCESS') {
        state.successfulRestorations += 1;
      }
    }
    if (tagSet.has('evaluation-verdict')) {
      state.evaluationArtifacts += 1;
      if (row.outcome === 'SUCCESS') {
        state.successfulEvaluations += 1;
      }
    }
    if (row.request_id && !state.requestIds.includes(row.request_id)) {
      state.requestIds.push(row.request_id);
    }
    state.latestArtifactAt = row.created_at ?? null;
  }

  const completedCycles = desiredStateIds.reduce((sum, desiredStateId) => {
    const state = byRestorationJob[desiredStateId];
    return sum + (
      state.successfulRestorations > 0 && state.successfulEvaluations > 0
        ? 1
        : 0
    );
  }, 0);

  return {
    rows,
    byRestorationJob,
    completedCycles,
  };
}

export function readArtifactProgress(dbPath, desiredStateIds) {
  if (!existsSync(dbPath)) {
    return summarizeArtifactRows([], desiredStateIds);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const placeholders = desiredStateIds.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT desired_state_id, request_id, title, tags, outcome, created_at
         FROM artifacts
        WHERE desired_state_id IN (${placeholders})
        ORDER BY created_at ASC`,
    ).all(...desiredStateIds);

    return summarizeArtifactRows(rows, desiredStateIds);
  } finally {
    db.close();
  }
}

/**
 * Aggregate artifacts produced after `runStartAt` (ISO 8601), grouped by
 * `desired_state_id`. A cycle is complete when both a `restoration-result`
 * SUCCESS and an `evaluation-verdict` SUCCESS row exist for the same
 * `desired_state_id`.
 *
 * The on-chain restoration and evaluation phases each get their own
 * `request_id` (separate mech submissions), but they share the
 * `pred-v0-auto-<bucket>` `desired_state_id` from the auto-generator
 * template. Grouping by `desired_state_id` therefore matches the cycle, not
 * the phase.
 */
export function summarizeRunWindowArtifacts(rows, runStartAt) {
  const byDesiredStateId = new Map();
  // Compare as strings in SQLite TEXT format. Using Date.parse() on SQLite's
  // `YYYY-MM-DD HH:MM:SS` format treats it as LOCAL time, while ISO inputs
  // with `Z` are UTC — a TZ-offset's worth of rows would silently drop. Both
  // SQL and JS sides now agree on lexicographic SQLite-format comparison.
  const sinceSqlite = typeof runStartAt === 'string'
    ? isoToSqliteTimestamp(runStartAt)
    : runStartAt;
  for (const row of rows) {
    if (!row.desired_state_id) continue;
    if (typeof sinceSqlite === 'string' && row.created_at) {
      if (row.created_at < sinceSqlite) continue;
    }
    let entry = byDesiredStateId.get(row.desired_state_id);
    if (!entry) {
      entry = {
        desiredStateId: row.desired_state_id,
        restorationRequestId: null,
        evaluationRequestId: null,
        restorationOk: false,
        evaluationOk: false,
        latestArtifactAt: null,
      };
      byDesiredStateId.set(row.desired_state_id, entry);
    }
    const tags = new Set(normalizeTags(row.tags));
    if (tags.has('restoration-result')) {
      if (row.outcome === 'SUCCESS') entry.restorationOk = true;
      if (row.request_id) entry.restorationRequestId = row.request_id;
    }
    if (tags.has('evaluation-verdict')) {
      if (row.outcome === 'SUCCESS') entry.evaluationOk = true;
      if (row.request_id) entry.evaluationRequestId = row.request_id;
    }
    entry.latestArtifactAt = row.created_at ?? entry.latestArtifactAt;
  }
  const entries = Array.from(byDesiredStateId.values());
  return {
    rows,
    byDesiredStateId: entries,
    completedCycles: entries.filter((e) => e.restorationOk && e.evaluationOk).length,
  };
}

/**
 * Read artifacts produced after `runStartAt` whose desired_state_id matches
 * the auto-generated `prediction.v0` prefix, then summarise as run-window
 * cycles. Returns the same shape regardless of whether the DB exists.
 */
export function readRunWindowArtifactProgress(dbPath, runStartAt) {
  if (!existsSync(dbPath)) {
    return summarizeRunWindowArtifacts([], runStartAt);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT desired_state_id, request_id, title, tags, outcome, created_at
         FROM artifacts
        WHERE desired_state_id LIKE 'pred-v0-auto-%'
          AND created_at >= ?
        ORDER BY created_at ASC`,
    ).all(isoToSqliteTimestamp(runStartAt));
    return summarizeRunWindowArtifacts(rows, runStartAt);
  } finally {
    db.close();
  }
}
