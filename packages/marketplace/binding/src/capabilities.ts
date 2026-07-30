// SPDX-License-Identifier: MIT

import type { BackendCapabilities, RunPinningKeySupport } from "@jinn-network/task-execution-backend";
import type { ComparisonClass } from "@jinn-network/task-execution-protocol";

/**
 * The "fixed core-key classes" half of `mergeRequirements`'s `keyClasses` map (program §7.3:
 * "keyClasses = the fixed core-key classes plus the resolved profile document's `requirementKeys`
 * classes, assembled by the caller" -- each backend assembles its own; no shared export exists
 * yet). Per the profiles design §5/§5.1: `harness` and `model` are `constraint` (the Task names an
 * admissible set, the Submission pins a member); `isolationPolicy` rides the core `isolation`
 * class key as a `constraint`; `loadout` is `addable` (free when the Task declares no loadout
 * constraint). `effort` is `floor` and comes from the resolved task-profile document's own
 * `requirementKeys` (`repository-work/1.0` declares it), not repeated here.
 */
export const MARKETPLACE_CORE_KEY_CLASSES: Record<string, ComparisonClass> = {
  harness: "constraint",
  model: "constraint",
  isolationPolicy: "constraint",
  loadout: "addable",
};

/**
 * Today-mode's operational ceiling for `attempts.maxTotal`/`maxConcurrent` capability bounds --
 * an arbitrary-but-generous operational number (NOT a protocol-frozen value; the on-chain
 * `maxClaims` parameter is a `uint32`). `maxConcurrent` shares the SAME ceiling as `maxTotal`
 * (design §6.1/§7: "today-mode bounds (`maxConcurrent == maxTotal`)") because the deployed chain
 * enforces only `maxClaims` -- there is no separate on-chain concurrency parameter, so this
 * binding never declares a concurrency ceiling narrower or wider than the total-attempts ceiling.
 */
const TODAY_MODE_ATTEMPT_CEILING = 10_000;

/**
 * The run-pinning keys this binding conveys under the marketplace's `attested` posture (profiles
 * §5.2): pinning is a claim-eligibility constraint conveyed to claimants, verified after the fact
 * against the Evidence Runtime Observation -- never enforced by the binding itself (it cannot
 * execute the work). `inventory: ["*"]` because the marketplace does not itself restrict which
 * harness/model/loadout/isolation an operator claims with; it only relays the pin.
 */
const ATTESTED_RUN_PINNING_KEYS: RunPinningKeySupport[] = ["harness", "model", "loadout", "isolationPolicy"].map(
  (key) => ({ key, inventory: ["*"], posture: "attested" }),
);

/**
 * `capabilities()` (design §7): declares the today-mode bounds (`maxConcurrent == maxTotal`;
 * first-verdict finalization is enforced by `honorOrRejectToday`, not restated here as a
 * boolean -- no such field exists on `BackendCapabilities`) and the `attested` run-pinning
 * posture. `cancel` is advertised exactly when the completed requester backend receives its
 * lifecycle ports (program §7.54); unrelated optional verbs remain false.
 */
export async function marketplaceCapabilities(
  options: { readonly cancel?: boolean } = {},
): Promise<BackendCapabilities> {
  return {
    taskProfiles: [],
    inputMediaTypes: [],
    outputMediaTypes: [],
    cancel: options.cancel === true,
    watch: false,
    preflight: false,
    fetchArtifact: false,
    confidentialInputs: false,
    signedObservations: false,
    signedDeliveries: true,
    evidenceCapture: "always",
    deadlineEnforcement: false,
    isolation: ["none"],
    attempts: {
      maxTotal: [1, TODAY_MODE_ATTEMPT_CEILING],
      maxConcurrent: [1, TODAY_MODE_ATTEMPT_CEILING],
    },
    runPinning: { keys: ATTESTED_RUN_PINNING_KEYS },
  };
}
