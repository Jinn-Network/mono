import type { OperatorCardRole } from './OperatorCard.js';

/**
 * The operator's joined SolverNets per spec §12. Tasks 21/22 finish the
 * migration from the legacy short-name-keyed `solverNets` shape to the
 * `manifestCid`-keyed shape; until then, Overview accepts both.
 *
 * New shape:    { '<manifestCid>': { name, manifestCid, roles: ['solver'|'evaluator'], harness?, ... } }
 * Legacy shape: { '<shortName>':   { enabled: boolean, roles?: ['solving'|'evaluating'], ... } }
 */
export interface BootstrapWithSolverNets {
  solverNets?: Record<
    string,
    {
      name?: string;
      manifestCid?: string;
      enabled?: boolean;
      roles?: string[];
      harness?: string;
    }
  >;
  joinedSolverNets?: Record<
    string,
    {
      name?: string;
      manifestCid?: string;
      roles?: string[];
      /**
       * Harness name bound to this joined entry. Used to route the card to a
       * dedicated SolverNet-scoped status payload when one exists, e.g.
       * `prediction-v1-baseline` ⇒ `predictionV1.totals`.
       */
      harness?: string;
    }
  >;
}

export type ScopedStatusKey = 'predictionV1';

export interface JoinedSolverNet {
  /** Display name for the OperatorCard. */
  name: string;
  /** Manifest CID / config key used for deep-linking into the joined config. */
  configId?: string;
  /** Roles narrowed to OperatorCard's `solving` / `evaluating` vocabulary. */
  roles: OperatorCardRole[];
  /**
   * UI-internal routing key for SolverNet-scoped status payloads. Derived from
   * the join entry's harness or the legacy short-name bootstrap path without
   * re-exposing `solverType` in the SPA model.
   */
  scopedStatusKey?: ScopedStatusKey;
}

export interface WaitingMessageTaskRunTotals {
  observedTasks?: number;
  activeTaskRuns?: number;
  completed?: number;
  failed?: number;
}

/**
 * Map a join entry's `harness` name to the dedicated SolverNet-scoped status
 * payload that Overview can consume. Currently only the prediction harness is
 * registered here — other SolverNets have no scoped payload yet.
 */
function scopedStatusKeyForHarness(harness: string | undefined): ScopedStatusKey | undefined {
  if (harness === 'prediction-v1-baseline') return 'predictionV1';
  return undefined;
}

function mapRolesToOperatorVocab(roles: string[]): OperatorCardRole[] {
  const mapped: OperatorCardRole[] = [];
  for (const r of roles) {
    if (r === 'solving' || r === 'solver') {
      if (!mapped.includes('solving')) mapped.push('solving');
    } else if (r === 'evaluating' || r === 'evaluator') {
      if (!mapped.includes('evaluating')) mapped.push('evaluating');
    }
  }
  return mapped;
}

/**
 * Detect whether the operator has joined any SolverNet. Returns the first
 * joined entry projected into OperatorCard's prop shape. The explicit
 * `joinedSolverNets` config block wins over the legacy `solverNets` map. The new
 * manifestCid-keyed shape (any entry with non-empty `roles`) wins over the
 * legacy `enabled` flag; both are accepted during the Tasks 21/22 migration
 * (spec §12). The predictionV1 status payload is a final-fallback signal
 * for daemons that haven't been restarted since this migration landed.
 */
export function detectJoinedSolverNet(
  joinedSolverNets: BootstrapWithSolverNets['joinedSolverNets'] | undefined,
  bootstrapSolverNets: BootstrapWithSolverNets['solverNets'] | undefined,
  predictionEnabled: boolean,
  predictionRoles: string[] | undefined,
): JoinedSolverNet | null {
  if (joinedSolverNets) {
    for (const [key, entry] of Object.entries(joinedSolverNets)) {
      if (!entry || typeof entry !== 'object') continue;
      const rawRoles = Array.isArray(entry.roles) ? entry.roles : [];
      if (rawRoles.length === 0) continue;
      const roles = mapRolesToOperatorVocab(rawRoles);
      const scopedStatusKey = scopedStatusKeyForHarness(entry.harness);
      return {
        name: entry.name ?? entry.manifestCid ?? key,
        configId: entry.manifestCid ?? key,
        roles: roles.length > 0 ? roles : ['solving'],
        ...(scopedStatusKey ? { scopedStatusKey } : {}),
      };
    }
  }

  if (bootstrapSolverNets) {
    for (const [key, entry] of Object.entries(bootstrapSolverNets)) {
      if (!entry || typeof entry !== 'object') continue;
      const looksLikeCid =
        entry.manifestCid !== undefined ||
        key.startsWith('baf') ||
        key.startsWith('Qm');
      if (!looksLikeCid) continue;
      const rawRoles = Array.isArray(entry.roles) ? entry.roles : [];
      if (rawRoles.length === 0) continue;
      const roles = mapRolesToOperatorVocab(rawRoles);
      const scopedStatusKey = scopedStatusKeyForHarness(entry.harness);
      return {
        name: entry.name ?? key,
        configId: entry.manifestCid ?? key,
        roles: roles.length > 0 ? roles : ['solving'],
        ...(scopedStatusKey ? { scopedStatusKey } : {}),
      };
    }
    for (const [key, entry] of Object.entries(bootstrapSolverNets)) {
      if (!entry || typeof entry !== 'object') continue;
      const rawRoles = Array.isArray(entry.roles) ? entry.roles : [];
      const roles = mapRolesToOperatorVocab(rawRoles);
      if (entry.enabled !== true && roles.length === 0) continue;
      const scopedStatusKey =
        scopedStatusKeyForHarness(entry.harness) ??
        (key === 'prediction' ? 'predictionV1' : undefined);
      return {
        name: entry.name ?? key,
        configId: entry.manifestCid ?? key,
        roles: roles.length > 0 ? roles : ['solving'],
        ...(scopedStatusKey ? { scopedStatusKey } : {}),
      };
    }
  }

  const mappedPredictionRoles = mapRolesToOperatorVocab(predictionRoles ?? []);
  if (predictionEnabled || mappedPredictionRoles.length > 0) {
    return {
      name: 'prediction',
      configId: 'prediction',
      roles: mappedPredictionRoles.length > 0 ? mappedPredictionRoles : ['solving'],
      scopedStatusKey: 'predictionV1',
    };
  }
  return null;
}

export function operatorWaitingMessage(
  joined: JoinedSolverNet | null,
  taskRunTotals: WaitingMessageTaskRunTotals | undefined,
  predictionDescription: string | undefined,
): string | undefined {
  const hasGenericRuns =
    (taskRunTotals?.observedTasks ?? 0) > 0 ||
    (taskRunTotals?.activeTaskRuns ?? 0) > 0 ||
    (taskRunTotals?.completed ?? 0) > 0 ||
    (taskRunTotals?.failed ?? 0) > 0;
  if (hasGenericRuns) {
    if ((taskRunTotals?.activeTaskRuns ?? 0) > 0) {
      return 'Working on current run.';
    }
    return 'Waiting for the next available run.';
  }
  if (joined?.scopedStatusKey === 'predictionV1') {
    return predictionDescription;
  }
  return undefined;
}
