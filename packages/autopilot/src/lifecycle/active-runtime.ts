import type { AttemptManifest } from './attempt-workspace.js';
import type { LifecycleControllerDeps } from './controller.js';
import type { CredentialPool } from './credentials.js';
import type { NewWorkAction } from './types.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';

export interface ActiveRuntimeResult {
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly reasons?: readonly string[];
}

export interface ActiveRuntimeHandlers {
  implementation(
    action: Extract<NewWorkAction, { kind: 'claim-implementation' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  review(
    action: Extract<NewWorkAction, { kind: 'claim-review' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  updateBranch?(
    action: Extract<NewWorkAction, { kind: 'update-branch' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  fileReconcileChild?(
    action: Extract<NewWorkAction, { kind: 'file-reconcile-child' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  merge(
    action: Extract<NewWorkAction, { kind: 'merge' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
}

export interface ActiveRuntimeOptions {
  readonly credentials: CredentialPool;
  readonly caps: {
    readonly implementation: number;
    readonly review: number;
  };
  readonly implementationPreferredLogin: string;
  readonly implementationBackpressureThreshold: number;
  /**
   * jinn-mono#1883: canary safety knob (`JINN_AUTOPILOT_ONLY_ISSUES`).
   * `undefined` means unrestricted — the pre-existing behavior. When set,
   * new-work claim scheduling in the controller is restricted to issue
   * numbers in this set; reconciliation of existing items is unaffected.
   */
  readonly onlyIssues?: ReadonlySet<number>;
  readonly readLocalAttempts: () => readonly AttemptManifest[];
  readonly preflight: () => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  readonly handlers: ActiveRuntimeHandlers;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function reason(result: ActiveRuntimeResult): string | undefined {
  if (result.reason !== undefined) return result.reason;
  if (result.detail !== undefined) return result.detail;
  if (result.reasons !== undefined && result.reasons.length > 0) {
    return result.reasons.join(', ');
  }
  return undefined;
}

export function makeActiveRuntime(
  options: ActiveRuntimeOptions,
): NonNullable<LifecycleControllerDeps['active']> {
  const caps = {
    implementation: nonNegative(options.caps.implementation, 'implementation cap'),
    review: nonNegative(options.caps.review, 'review cap'),
  };
  const readLocalState = () => {
    const attempts = options.readLocalAttempts();
    const activeByPhase = {
      implementation: attempts.filter((attempt) => attempt.phase === 'implement').length,
      review: attempts.filter((attempt) => attempt.phase === 'review').length,
    };
    const occupied = new Set(
      attempts.map((attempt) => attempt.selectedLogin.toLowerCase()),
    );
    return {
      remaining: {
        implementation: Math.max(0, caps.implementation - activeByPhase.implementation),
        review: Math.max(0, caps.review - activeByPhase.review),
      },
      availableLogins: options.credentials.logins().filter(
        (login) => !occupied.has(login.toLowerCase()),
      ),
      implementationPreferredLogin: options.implementationPreferredLogin,
    };
  };

  return {
    preflight: options.preflight,
    readLocalState,
    implementationBackpressureThreshold:
      nonNegative(
        options.implementationBackpressureThreshold,
        'implementation backpressure threshold',
      ),
    ...(options.onlyIssues === undefined ? {} : { onlyIssues: options.onlyIssues }),
    async executeAction(action, snapshot) {
      const local = readLocalState();
      const phase = action.kind === 'claim-implementation'
        ? 'implementation'
        : action.kind === 'claim-review'
          ? 'review'
          : null;
      if (phase !== null && local.remaining[phase] === 0) {
        return { outcome: 'skipped', reason: 'local phase capacity is full' };
      }
      if (local.availableLogins.length === 0) {
        return { outcome: 'skipped', reason: 'no local credential lane is free' };
      }
      const credentials = options.credentials.restrictedTo(local.availableLogins);
      const result = action.kind === 'claim-implementation'
        ? await options.handlers.implementation(action, credentials, snapshot)
        : action.kind === 'claim-review'
          ? await options.handlers.review(action, credentials, snapshot)
          : action.kind === 'update-branch'
            ? options.handlers.updateBranch === undefined
              ? { status: 'skipped', detail: 'update-branch handler unavailable' }
              : await options.handlers.updateBranch(action, credentials, snapshot)
            : action.kind === 'file-reconcile-child'
              ? options.handlers.fileReconcileChild === undefined
                ? { status: 'skipped', detail: 'file-reconcile-child handler unavailable' }
                : await options.handlers.fileReconcileChild(action, credentials, snapshot)
              : action.kind === 'merge'
                ? await options.handlers.merge(action, credentials, snapshot)
                : {
                    status: 'skipped',
                    detail: `action ${(action as { kind: string }).kind} is not wired`,
                  };
      const detail = reason(result);
      return {
        outcome: result.status,
        ...(detail === undefined ? {} : { reason: detail }),
      };
    },
  };
}
