import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

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
  const byDesiredState = Object.fromEntries(
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
    const state = byDesiredState[row.desired_state_id];
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
    const state = byDesiredState[desiredStateId];
    return sum + (
      state.successfulRestorations > 0 && state.successfulEvaluations > 0
        ? 1
        : 0
    );
  }, 0);

  return {
    rows,
    byDesiredState,
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
