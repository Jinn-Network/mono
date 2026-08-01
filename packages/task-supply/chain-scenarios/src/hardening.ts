// SPDX-License-Identifier: Apache-2.0

import type { Predicate } from "@jinn-network/task-execution-profiles";

import { ScenarioError } from "./errors.js";
import { eventSignatureTopic0, predicateId } from "./predicates.js";
import type {
  ChainScenarioCandidate,
  ChainDerivationEnvironment,
  EnvironmentCompatibility,
  HardeningChecklist,
  ScenarioTemplate,
} from "./template.js";
import { buildProbeRoleAddresses } from "./template.js";

type HardeningCandidateSurface = Pick<ChainScenarioCandidate, "predicateDraft" | "roleAddresses">;

function unhardened(message: string): never {
  throw new ScenarioError("unhardened-template", message);
}

function assertUniquePredicateIds(predicates: readonly Predicate[], listName: string): void {
  const seen = new Set<string>();
  for (const predicate of predicates) {
    const id = predicateId(predicate);
    if (id === undefined) {
      unhardened(`${listName} predicate is missing a checklist id (label).`);
    }
    if (seen.has(id)) {
      unhardened(`duplicate predicate id "${id}" in ${listName}.`);
    }
    seen.add(id);
  }
}

function roleForAddress(
  roleAddresses: Readonly<Record<string, string>>,
  address: string | undefined,
): string | undefined {
  if (address === undefined) return undefined;
  for (const [role, mapped] of Object.entries(roleAddresses)) {
    if (mapped === address) return role;
  }
  return undefined;
}

function findPredicateById(predicates: readonly Predicate[], id: string): Predicate | undefined {
  return predicates.find((predicate) => predicateId(predicate) === id);
}

function assertRequiredProtocolEvents(
  candidate: HardeningCandidateSurface,
  checklist: HardeningChecklist,
): void {
  for (const entry of checklist.requiredProtocolEvents) {
    const predicate = findPredicateById(candidate.predicateDraft.successPredicates, entry.predicateId);
    if (predicate === undefined || predicate.kind !== "eventEmitted") {
      unhardened(
        `required protocol event "${entry.predicateId}" has no matching eventEmitted success predicate.`,
      );
    }
    const emitted = predicate as Predicate & { kind: "eventEmitted"; topic0: string; source?: string };
    if (emitted.topic0 !== eventSignatureTopic0(entry.signature)) {
      unhardened(
        `required protocol event "${entry.predicateId}" signature does not match the emitted predicate.`,
      );
    }
    const contractRole = roleForAddress(candidate.roleAddresses, emitted.source);
    if (contractRole !== entry.contractRole) {
      unhardened(
        `required protocol event "${entry.predicateId}" contract role "${entry.contractRole}" `
          + `does not match the emitted predicate source.`,
      );
    }
  }
}

function forbiddenTargetsCoverRoles(
  predicate: Predicate,
  roles: readonly string[],
  roleAddresses: Readonly<Record<string, string>>,
): boolean {
  if (predicate.kind === "addressForbidden") {
    const targets = new Set(predicate.targets);
    return roles.every((role) => {
      const address = roleAddresses[role];
      return address !== undefined && targets.has(address);
    });
  }
  if (predicate.kind === "eventForbidden") {
    return roles.length === 0;
  }
  return false;
}

function assertForbiddenRoutes(
  candidate: HardeningCandidateSurface,
  checklist: HardeningChecklist,
): void {
  for (const entry of checklist.forbiddenRoutes) {
    const predicate = findPredicateById(candidate.predicateDraft.safetyConstraints, entry.predicateId);
    if (
      predicate === undefined
      || (predicate.kind !== "addressForbidden" && predicate.kind !== "eventForbidden")
      || !forbiddenTargetsCoverRoles(predicate, entry.addressRoles, candidate.roleAddresses)
    ) {
      unhardened(
        `forbidden route "${entry.predicateId}" has no matching addressForbidden or eventForbidden `
          + "safety constraint covering the named roles.",
      );
    }
  }
}

function assertExcludedSignerRoles(
  candidate: HardeningCandidateSurface,
  checklist: HardeningChecklist,
): void {
  const signerRoles = candidate.predicateDraft.envelopeTightenings?.signerRoles ?? [];
  for (const entry of checklist.excludedAccountRoles) {
    if (signerRoles.includes(entry.role)) {
      unhardened(
        `excluded signer role "${entry.role}" appears in the tightened envelope signerRoles.`,
      );
    }
  }
}

function assertTimeAdvancementBound(
  candidate: HardeningCandidateSurface,
  checklist: HardeningChecklist,
): void {
  const bound = checklist.timeAdvancementBound.maxChainSeconds;
  const timePredicate = candidate.predicateDraft.successPredicates.find(
    (predicate) => predicate.kind === "timeBound"
      && "metric" in predicate
      && predicate.metric === "completedWithinChainSeconds",
  );
  if (timePredicate === undefined || timePredicate.kind !== "timeBound") {
    unhardened("time advancement bound requires a completedWithinChainSeconds timeBound success predicate.");
  }
  const predicateSeconds = Number(timePredicate.maximum);
  if (!Number.isFinite(predicateSeconds) || predicateSeconds > bound) {
    unhardened(
      `time advancement bound ${bound}s is tighter than the emitted timeBound predicate (${predicateSeconds}s).`,
    );
  }
  const envelopeSeconds = Number(candidate.predicateDraft.envelopeTightenings?.maxChainSecondsAdvanced);
  if (!Number.isFinite(envelopeSeconds) || envelopeSeconds > bound) {
    unhardened(
      `time advancement bound ${bound}s is tighter than envelopeTightenings.maxChainSecondsAdvanced `
        + `(${candidate.predicateDraft.envelopeTightenings?.maxChainSecondsAdvanced ?? "unset"}).`,
    );
  }
}

function assertResidualRisk(checklist: HardeningChecklist): void {
  if (checklist.acknowledgedResidualRisk.trim().length === 0) {
    unhardened("hardening checklist residual risk acknowledgement must be non-empty.");
  }
}

export function assertCandidateHardened(
  candidate: HardeningCandidateSurface,
  checklist: HardeningChecklist,
): void {
  assertUniquePredicateIds(candidate.predicateDraft.successPredicates, "successPredicates");
  assertUniquePredicateIds(candidate.predicateDraft.safetyConstraints, "safetyConstraints");
  assertRequiredProtocolEvents(candidate, checklist);
  assertForbiddenRoutes(candidate, checklist);
  assertExcludedSignerRoles(candidate, checklist);
  assertTimeAdvancementBound(candidate, checklist);
}

function collectProbeRoles(template: {
  readonly compatibility: EnvironmentCompatibility;
  readonly hardening: HardeningChecklist;
}): string[] {
  const roles = new Set<string>([
    ...template.compatibility.requiredProtocolRoles,
    ...template.compatibility.requiredSignerRoles,
    ...template.hardening.forbiddenRoutes.flatMap((route) => route.addressRoles),
    ...template.hardening.excludedAccountRoles.map((entry) => entry.role),
    ...template.hardening.requiredProtocolEvents.map((entry) => entry.contractRole),
  ]);
  return [...roles];
}

function buildCompatibilityProbe<TParams>(
  template: ScenarioTemplate<TParams>,
): { readonly params: TParams; readonly env: ChainDerivationEnvironment } {
  const roleAddresses = buildProbeRoleAddresses(collectProbeRoles(template));
  const params = template.parameterSchema.parse({});
  const env: ChainDerivationEnvironment = {
    recordBytes: new Uint8Array(),
    record: {} as ChainDerivationEnvironment["record"],
    recordDigest: `sha256:${"0".repeat(64)}`,
    chainRecord: {
      stateMaterialization: { closureClass: "closed-state", fidelityClass: "local" },
      capabilityEnvelope: {
        limits: { maxChainSecondsAdvance: 9_999_999 },
        signerRoles: [],
      },
    } as unknown as ChainDerivationEnvironment["chainRecord"],
    roleAddresses,
  };
  return { params, env };
}

export function assertTemplateHardened<TParams>(template: ScenarioTemplate<TParams>): void {
  assertResidualRisk(template.hardening);
  const probe = buildCompatibilityProbe(template);
  const predicateDraft = template.predicateTemplate(probe.params, probe.env);
  assertCandidateHardened(
    { predicateDraft, roleAddresses: probe.env.roleAddresses },
    template.hardening,
  );
}
