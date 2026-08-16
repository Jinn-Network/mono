/**
 * `LearnerHarness.supports()` routing policy.
 *
 * The learner used to return `true` for every non-evaluation SolverType, with a
 * two-item blocklist bolted on and a comment calling itself architectural debt.
 * That posture collides with controlled arms: a campaign cannot compare policies
 * on a route the learner silently claims regardless of configuration, and an arm
 * that wraps a SolverType nobody assigned it is not the policy anyone pinned.
 *
 * Routing is therefore explicit (product design §10, "Learner migration"): the
 * operator names the SolverTypes this learner serves, and an unconfigured
 * learner claims nothing. The shipped wrap-everything behaviour survives behind
 * a compatibility flag so existing deployments keep working while they migrate.
 *
 * Authority: docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md §10.
 */

/** Compatibility flag restoring the shipped wrap-every-SolverType routing. */
export const LEGACY_DEFAULT_ROUTING_ENV = 'JINN_LEARNER_DEFAULT_ROUTING';

/**
 * SolverTypes the learner must never claim, in either routing mode.
 *
 * These have first-party restoration Harnesses that return typed
 * `solutionPayload` objects. The learner emits phase artifacts for its own
 * pipeline; letting it claim these specialist tasks can run the CLI but fail
 * packaging when the phase artifacts are absent. This is a packaging
 * constraint, not a routing preference — so an operator allowlist entry does
 * NOT override it.
 *
 * Related: jinn-mono-kzlj (deferred — Prediction frozen per DR-2026-05-11-a).
 * kzlj is scoped to `prediction.v1`; `prediction.apy.v0` needs the same
 * migration when the apy SolverNet's freeze lifts. Both entries can be dropped
 * once `jinn-prediction-plugin` gains a submission-shape skill (the way
 * `swe-rebench-v2-runtime` has `plan/SKILL.md`) and the harvest's
 * `prediction.v1` special path is migrated to the generic
 * `.execute/solution-payload.json` path.
 */
export const UNSUPPORTABLE_SOLVER_TYPES: readonly string[] = [
  'prediction.v1',
  'prediction.apy.v0',
];

export interface LearnerRoutingConfig {
  /**
   * The SolverTypes this learner serves. Absent or empty means it claims
   * nothing — silence is not consent to wrap the whole network.
   */
  solverTypes?: readonly string[];
  /**
   * Compatibility: restore the shipped wrap-every-non-evaluation-SolverType
   * routing. Deprecated; retired once explicit routing is configured in every
   * deployment. When unset, {@link LEGACY_DEFAULT_ROUTING_ENV} is consulted.
   */
  legacyDefaultRouting?: boolean;
}

export interface SupportsSpec {
  solverType: string;
  role?: 'restoration' | 'evaluation';
}

function envFlagEnabled(): boolean {
  const raw = process.env[LEGACY_DEFAULT_ROUTING_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

/**
 * Whether legacy default routing is in force. An explicit config value is
 * authoritative in both directions; only an absent one falls through to the
 * environment.
 */
export function legacyDefaultRoutingEnabled(config: LearnerRoutingConfig | undefined): boolean {
  if (config?.legacyDefaultRouting !== undefined) return config.legacyDefaultRouting;
  return envFlagEnabled();
}

/** One-time-per-process deprecation notice, so logs name the flag exactly once. */
let deprecationWarned = false;

export function routingSupports(
  config: LearnerRoutingConfig | undefined,
  spec: SupportsSpec,
  harnessName: string,
): boolean {
  // The learner is a restoration harness. Evaluation is a different authority
  // and outranks every routing decision below.
  if (spec.role === 'evaluation') return false;
  if (UNSUPPORTABLE_SOLVER_TYPES.includes(spec.solverType)) return false;

  if (legacyDefaultRoutingEnabled(config)) {
    if (!deprecationWarned) {
      deprecationWarned = true;
      console.warn(
        `[learner:${harnessName}] ${LEGACY_DEFAULT_ROUTING_ENV} is enabled — this harness claims ` +
          'every non-evaluation SolverType. That default is deprecated (product design §10); ' +
          'configure an explicit SolverType allowlist and drop the flag.',
      );
    }
    return true;
  }

  return (config?.solverTypes ?? []).includes(spec.solverType);
}
