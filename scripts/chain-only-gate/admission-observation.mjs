// SPDX-License-Identifier: Apache-2.0
/**
 * Host-side ChainObservationPort composition for the chain-only gate (F-GATE-3).
 *
 * Admission stays attestation-agnostic: the host runs the family's pure
 * `evaluatePredicates` over a CanonicalChainObservation produced for each
 * script side, then projects the outcome into the ChainObservation shape.
 */

/**
 * @param {{
 *   evaluatePredicates: Function,
 *   predicateBlock: unknown,
 *   observationFor: (kind: 'do-nothing' | 'reference') => unknown,
 *   referenceDigest: `sha256:${string}`,
 * }} opts
 * @returns {import('@jinn-network/task-supply-admission').ChainObservationPort}
 */
export function createEvaluateObservationPort(opts) {
  /** Admission requires byte-identical repeats; cache live observations per script kind. */
  const cache = new Map();
  return async (request) => {
    const kind = request.script.kind === "reference" ? "reference" : "do-nothing";
    let canonical = cache.get(kind);
    if (canonical === undefined) {
      canonical = await opts.observationFor(kind);
      cache.set(kind, canonical);
    }
    const outcome = opts.evaluatePredicates(canonical, opts.predicateBlock);

    const successPredicates = outcome.evaluations
      .filter((entry) => entry.slot === "success")
      .map((entry) => ({
        id: entry.label ?? `${entry.slot}-${entry.index}`,
        satisfied: entry.state === "satisfied",
      }));

    const safetyConstraints = outcome.evaluations
      .filter((entry) => entry.slot === "safety")
      .map((entry) => ({
        id: entry.label ?? `${entry.slot}-${entry.index}`,
        satisfied: entry.state === "satisfied",
      }));

    return {
      successPredicates,
      safetyConstraints,
      conjunction: outcome.successPredicatesSatisfied,
      outOfSliceReads: 0,
      envelopeExceeded: false,
      appliedScriptDigest: kind === "reference" ? opts.referenceDigest : null,
    };
  };
}
