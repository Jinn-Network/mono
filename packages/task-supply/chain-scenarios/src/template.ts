// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEnvironmentRecord,
  CryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import { z } from "zod";

import type { Sha256Digest } from "./digest.js";
import type { ScenarioPredicate } from "./predicates.js";
import type { CapabilityEnvelope, ReferenceScript } from "./solution-script.js";

/** What a record must offer for a template to be parameterizable against it (design §7). */
export interface EnvironmentCompatibility {
  /** Durable supply requires closed-state; the constraint is declared, not assumed. */
  readonly closureClass: "closed-state";
  readonly fidelityClasses: readonly ("local" | "anchored-subset" | "full-state")[];
  /** Address-book roles the record must instantiate (`pool`, `collateral-token`, …). */
  readonly requiredProtocolRoles: readonly string[];
  /** Fixture account roles the record's envelope must grant a signer for. */
  readonly requiredSignerRoles: readonly string[];
  /** Minimum envelope headroom the intended path needs. */
  readonly minimumEnvelope: CapabilityEnvelope;
}

/**
 * Design §7's authoring obligation, made checkable. Every field names WHY, because a
 * checklist whose entries carry no reason decays into a box-tick within two templates.
 */
export interface HardeningChecklist {
  readonly requiredProtocolEvents: readonly {
    readonly predicateId: string;
    readonly contractRole: string;
    readonly signature: string;
    readonly why: string;
  }[];
  readonly forbiddenRoutes: readonly {
    readonly predicateId: string;
    readonly addressRoles: readonly string[];
    readonly why: string;
  }[];
  readonly excludedAccountRoles: readonly { readonly role: string; readonly why: string }[];
  readonly timeAdvancementBound: { readonly maxChainSeconds: number; readonly why: string };
  readonly acknowledgedResidualRisk: string;
}

/**
 * CE5 extends profiles' envelope tightenings with signer-role tightening for hardening.
 * `parameterize` strips `signerRoles` before sealing the state-predicate block.
 */
export interface ScenarioEnvelopeTightenings {
  readonly maxTransactions?: string;
  readonly maxAggregateNativeValueWei?: string;
  readonly maxGasTotal?: string;
  readonly maxBlocksAdvanced?: string;
  readonly maxChainSecondsAdvanced?: string;
  readonly signerRoles?: readonly string[];
}

export interface StatePredicateDraft {
  readonly successPredicates: readonly ScenarioPredicate[];
  readonly safetyConstraints: readonly ScenarioPredicate[];
  readonly measurements: readonly {
    readonly name: string;
    readonly observe: { readonly kind: string; readonly [key: string]: unknown };
  }[];
  readonly envelopeTightenings?: ScenarioEnvelopeTightenings;
}

/**
 * A described composite world, in the three forms this package needs. Task 9 owns the
 * loader; task 6 defines the shape so hardening can build a compatibility probe.
 */
export interface ChainDerivationEnvironment {
  readonly recordBytes: Uint8Array;
  readonly record: CryptoEnvironmentRecord;
  readonly recordDigest: Sha256Digest;
  /** The chain world the composite references; compatibility checks read this, not the composite. */
  readonly chainRecord: ChainEnvironmentRecord;
  readonly roleAddresses: Readonly<Record<string, string>>;
}

export interface ScenarioLineage {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly parameterDigest: Sha256Digest;
  readonly environmentRecordDigest: Sha256Digest;
}

export interface ScenarioStatePredicateBlock {
  readonly environmentRecord: {
    readonly digest: { readonly sha256: string };
    readonly mediaType: string;
    readonly name?: string;
  };
  readonly predicateSemanticsVersion: "1";
  readonly successPredicates: readonly ScenarioPredicate[];
  readonly safetyConstraints: readonly ScenarioPredicate[];
  readonly measurements: StatePredicateDraft["measurements"];
  readonly envelopeTightenings?: Omit<ScenarioEnvelopeTightenings, "signerRoles">;
  readonly timeout: number;
}

export interface ChainScenarioCandidate {
  /** Bare hex — stable identity for pool deduplication. */
  readonly id: string;
  readonly lineage: ScenarioLineage;
  readonly instructions: string;
  readonly predicateDraft: StatePredicateDraft;
  readonly predicateBlock: ScenarioStatePredicateBlock;
  readonly roleAddresses: Readonly<Record<string, string>>;
  readonly referenceScript: ReferenceScript;
  readonly referenceScriptDigest: Sha256Digest;
  readonly sourceCommitment: Sha256Digest;
  readonly rights: { readonly sourceLicense: string };
  readonly timeout: number;
}

export interface ScenarioTemplate<TParams> {
  readonly id: string;
  readonly version: string;
  readonly compatibility: EnvironmentCompatibility;
  readonly parameterSchema: z.ZodType<TParams>;
  readonly instructionTemplate: (params: TParams, env: ChainDerivationEnvironment) => string;
  readonly predicateTemplate: (params: TParams, env: ChainDerivationEnvironment) => StatePredicateDraft;
  readonly referenceSolution: (params: TParams, env: ChainDerivationEnvironment) => ReferenceScript;
  readonly hardening: HardeningChecklist;
  readonly rights: { readonly sourceLicense: string };
  readonly timeout: number;
}

export function isScenarioTemplate(value: unknown): value is ScenarioTemplate<never> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as ScenarioTemplate<never>;
  return typeof candidate.id === "string"
    && typeof candidate.version === "string"
    && candidate.compatibility !== undefined
    && candidate.parameterSchema !== undefined
    && typeof candidate.instructionTemplate === "function"
    && typeof candidate.predicateTemplate === "function"
    && typeof candidate.referenceSolution === "function"
    && candidate.hardening !== undefined
    && typeof candidate.timeout === "number";
}

export function resolveRoleAddress(
  env: ChainDerivationEnvironment,
  role: string,
): string {
  const address = env.roleAddresses[role];
  if (address === undefined) {
    throw new Error(`role "${role}" is not present in the compatibility probe address book`);
  }
  return address;
}

export function syntheticProbeAddress(index: number): string {
  const suffix = index.toString(16).padStart(2, "0");
  return `0x00000000000000000000000000000000000000${suffix}`;
}

export function buildProbeRoleAddresses(roles: readonly string[]): Readonly<Record<string, string>> {
  const addresses: Record<string, string> = {};
  roles.forEach((role, index) => {
    addresses[role] = syntheticProbeAddress(index + 1);
  });
  return addresses;
}
