// SPDX-License-Identifier: Apache-2.0

import type { BackendCapabilities } from "@jinn-network/task-execution-backend";
import type { LauncherContract } from "@jinn-network/task-execution-launchers";
import { compareCodeUnitStrings } from "@jinn-network/task-execution-protocol";
import type { WorkspaceKind } from "@jinn-network/task-execution-workspace";

export type RecorderAvailability = BackendCapabilities["evidenceCapture"];

export interface CapabilityProvisionerConfig {
  readonly taskProfiles: readonly string[];
  readonly workspaceKinds: readonly WorkspaceKind[];
  readonly inputMediaTypes: readonly string[];
  readonly outputMediaTypes: readonly string[];
  readonly maxArtifactBytes?: number;
  readonly isolation: readonly string[];
}

export interface TrustKeyConfig {
  readonly observationSigningKeyConfigured?: boolean;
  readonly deliverySigningKeyConfigured?: boolean;
}

export interface AssembleCapabilitiesInput {
  readonly launchers: readonly LauncherContract[];
  readonly provisioner: CapabilityProvisionerConfig;
  readonly recorderAvailability: RecorderAvailability;
  readonly trustKeys: TrustKeyConfig;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnitStrings);
}

/** Static assembled statements only; binary/auth/version readiness belongs to `preflight()`. */
export function assembleCapabilities(
  input: AssembleCapabilitiesInput,
): BackendCapabilities {
  const launcherProfiles = new Set(
    input.launchers.flatMap((launcher) => [
      ...launcher.capabilities().taskProfiles,
    ]),
  );
  const taskProfiles = sortedUnique(
    input.provisioner.taskProfiles.filter((profile) => launcherProfiles.has(profile)),
  );

  const inventoryByKey = new Map<string, string[]>();
  for (const launcher of input.launchers) {
    for (const support of launcher.capabilities().runPinning.keys) {
      const inventory = inventoryByKey.get(support.key) ?? [];
      inventory.push(...support.inventory);
      inventoryByKey.set(support.key, inventory);
    }
  }

  return {
    taskProfiles,
    inputMediaTypes: sortedUnique(input.provisioner.inputMediaTypes),
    outputMediaTypes: sortedUnique(input.provisioner.outputMediaTypes),
    ...(input.provisioner.maxArtifactBytes === undefined
      ? {}
      : { maxArtifactBytes: input.provisioner.maxArtifactBytes }),
    cancel: true,
    watch: true,
    preflight: true,
    fetchArtifact: true,
    confidentialInputs: true,
    signedObservations: input.trustKeys.observationSigningKeyConfigured === true,
    signedDeliveries: input.trustKeys.deliverySigningKeyConfigured === true,
    evidenceCapture: input.recorderAvailability,
    deadlineEnforcement: true,
    isolation: sortedUnique(input.provisioner.isolation),
    attempts: {
      maxTotal: [1, 1],
      maxConcurrent: [1, 1],
    },
    runPinning: {
      keys: [...inventoryByKey]
        .sort(([left], [right]) => compareCodeUnitStrings(left, right))
        .map(([key, inventory]) => ({
          key,
          inventory: sortedUnique(inventory),
          posture: "enforced",
        })),
    },
  };
}
