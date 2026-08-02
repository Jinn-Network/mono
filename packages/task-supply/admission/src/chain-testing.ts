// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";
import type {
  ChainAdmissionCandidate,
  ChainAdmissionDeps,
} from "./chain-admit.js";
import type {
  ChainObservation,
  ChainObservationPort,
  ChainObservationRequest,
} from "./chain-observations.js";
import { CHAIN_ADMISSION_REFUSAL_CODES } from "./chain-refusals.js";
import {
  CHAIN_ADMISSION_POLICY_V1,
  CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION,
} from "./identifiers.js";
import type { ChainAdmissionReceiptV1 } from "./chain-receipt.js";
import { admitCandidate } from "./admit.js";
import {
  goldenCandidate as goldenSweCandidate,
  goldenEnvironmentRecordBytes,
  goldenEvaluationSpecBytes,
  scriptedRunner,
} from "./testing.js";

const digest = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const RECORD_HEX = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMPOSITE_RECORD = digest("a");
const OTHER_RECORD_HEX = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REFERENCE_SCRIPT = digest("5");

const BASELINE_PREDICATES = [
  { id: "health-factor-above-1.5", satisfied: true },
  { id: "borrow-event-emitted", satisfied: false },
] as const;

const SOLVED_PREDICATES = [
  { id: "health-factor-above-1.5", satisfied: true },
  { id: "borrow-event-emitted", satisfied: true },
] as const;

const SAFETY_OK = [{ id: "no-unlimited", satisfied: true }] as const;

function observation(
  successPredicates: readonly { id: string; satisfied: boolean }[],
  options: {
    readonly safetyConstraints?: readonly { id: string; satisfied: boolean }[];
    readonly conjunction?: boolean;
    readonly outOfSliceReads?: number;
    readonly envelopeExceeded?: boolean;
    readonly appliedScriptDigest?: `sha256:${string}` | null;
  } = {},
): ChainObservation {
  const conjunction = options.conjunction ?? successPredicates.every((outcome) => outcome.satisfied);
  return {
    successPredicates: [...successPredicates],
    safetyConstraints: [...(options.safetyConstraints ?? SAFETY_OK)],
    conjunction,
    outOfSliceReads: options.outOfSliceReads ?? 0,
    envelopeExceeded: options.envelopeExceeded ?? false,
    appliedScriptDigest: options.appliedScriptDigest ?? null,
  };
}

/** A policy-valid chain admission receipt over a discriminating do-nothing/reference pair. */
export function goldenChainReceipt(): ChainAdmissionReceiptV1 {
  const doNothing = observation(BASELINE_PREDICATES, { appliedScriptDigest: null });
  const reference = observation(SOLVED_PREDICATES, {
    appliedScriptDigest: REFERENCE_SCRIPT,
  });
  return {
    schemaVersion: CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION,
    admissionPolicyVersion: CHAIN_ADMISSION_POLICY_V1.admissionPolicyVersion,
    family: "state-predicate",
    issuer: "https://jinn.network/agents/admission-1",
    task: {
      documentDigest: digest("1"),
      evaluationSpecDigest: digest("2"),
      statementDigest: digest("3"),
    },
    referenceScriptDigest: REFERENCE_SCRIPT,
    observations: {
      doNothing: [doNothing, doNothing],
      reference: [reference, reference],
    },
    environment: { compositeRecordDigest: COMPOSITE_RECORD },
    sliceSufficiency: { referenceOutOfSliceReads: 0 },
    evalSemanticsVersion: "1",
  };
}

/**
 * A canonical `state-predicate` EvaluationSpec mirroring the family block CE2 emits, field for
 * field, so a drift in CE2's block breaks this fixture rather than silently breaking the reader.
 */
export function goldenStatePredicateSpecBytes(
  blockOverrides: Record<string, unknown> = {},
): Uint8Array {
  return canonicalJsonBytes({
    family: "state-predicate",
    familyBlock: {
      environmentRecord: {
        digest: { sha256: COMPOSITE_RECORD.slice(7) },
        mediaType: "application/vnd.jinn.crypto-environment.v1+json",
      },
      predicateSemanticsVersion: "1",
      successPredicates: [
        {
          kind: "txOutcome",
          label: "health-factor-above-1.5",
          selector: { all: true },
          status: "success",
        },
        {
          kind: "txOutcome",
          label: "borrow-event-emitted",
          selector: { all: true },
          status: "success",
        },
      ],
      safetyConstraints: [
        { kind: "approvalConstraint", label: "no-unlimited", noUnlimited: true },
      ],
      measurements: [],
      timeout: 600,
      ...blockOverrides,
    },
  });
}

export function goldenDeterministicProcessSpecBytes(): Uint8Array {
  return goldenEvaluationSpecBytes();
}

export function goldenChainCandidate(
  overrides: Partial<ChainAdmissionCandidate> = {},
): ChainAdmissionCandidate {
  return {
    taskDocumentDigest: digest("1"),
    statementDigest: digest("3"),
    referenceScriptDigest: REFERENCE_SCRIPT,
    evaluationSpecBytes: goldenStatePredicateSpecBytes(),
    evalSemanticsVersion: "1",
    ...overrides,
  };
}

/** A pure port whose per-side answers are scripted; it never touches a chain instance. */
export function scriptedChainPort(
  script: Partial<Record<"do-nothing" | "reference", ChainObservation>> = {},
): ChainObservationPort {
  return async (request: ChainObservationRequest) => {
    const reference = request.script.kind === "reference";
    return script[request.script.kind] ?? observation(
      reference ? SOLVED_PREDICATES : BASELINE_PREDICATES,
      { appliedScriptDigest: reference ? REFERENCE_SCRIPT : null },
    );
  };
}

function satisfiedAtBaselinePort(): ChainObservationPort {
  return async (request: ChainObservationRequest) => {
    const reference = request.script.kind === "reference";
    const predicates = reference ? SOLVED_PREDICATES : [
      { id: "health-factor-above-1.5", satisfied: true },
      { id: "borrow-event-emitted", satisfied: true },
    ];
    return observation(predicates, {
      conjunction: true,
      appliedScriptDigest: reference ? REFERENCE_SCRIPT : null,
    });
  };
}

function throwingChainPort(): ChainObservationPort {
  return async () => {
    throw new Error("chain instance unavailable");
  };
}

function contradictoryPort(): ChainObservationPort {
  return async (request: ChainObservationRequest) => {
    const reference = request.script.kind === "reference";
    return observation(
      reference ? SOLVED_PREDICATES : BASELINE_PREDICATES,
      {
        conjunction: true,
        appliedScriptDigest: reference ? REFERENCE_SCRIPT : null,
      },
    );
  };
}

function unsolvedReferencePort(): ChainObservationPort {
  return async (request: ChainObservationRequest) => {
    const reference = request.script.kind === "reference";
    return observation(
      reference ? BASELINE_PREDICATES : BASELINE_PREDICATES,
      { appliedScriptDigest: reference ? REFERENCE_SCRIPT : null },
    );
  };
}

function safetyViolatingPort(): ChainObservationPort {
  return async (request: ChainObservationRequest) => {
    const reference = request.script.kind === "reference";
    return observation(
      reference ? SOLVED_PREDICATES : BASELINE_PREDICATES,
      {
        safetyConstraints: [{ id: "no-unlimited", satisfied: !reference }],
        appliedScriptDigest: reference ? REFERENCE_SCRIPT : null,
      },
    );
  };
}

function outOfSlicePort(): ChainObservationPort {
  return async (request: ChainObservationRequest) => {
    const reference = request.script.kind === "reference";
    return observation(
      reference ? SOLVED_PREDICATES : BASELINE_PREDICATES,
      {
        outOfSliceReads: reference ? 1 : 0,
        appliedScriptDigest: reference ? REFERENCE_SCRIPT : null,
      },
    );
  };
}

function flakyChainPort(): ChainObservationPort {
  let call = 0;
  return async (request: ChainObservationRequest) => {
    const reference = request.script.kind === "reference";
    const predicates = reference
      ? (call++ === 0 ? SOLVED_PREDICATES : [{ id: "health-factor-above-1.5", satisfied: false }, { id: "borrow-event-emitted", satisfied: true }])
      : BASELINE_PREDICATES;
    return observation(predicates, {
      appliedScriptDigest: reference ? REFERENCE_SCRIPT : null,
    });
  };
}

export interface ChainAdmissionRefusalScenario {
  readonly port: ChainObservationPort;
  readonly candidate: () => ChainAdmissionCandidate;
  readonly compositeDigest: () => `sha256:${string}`;
}

scriptedChainPort.refusalScenarios = {
  "do-nothing-satisfies": {
    port: satisfiedAtBaselinePort(),
    candidate: goldenChainCandidate,
    compositeDigest: () => COMPOSITE_RECORD,
  },
  "env-record-mismatch": {
    port: scriptedChainPort(),
    candidate: () => goldenChainCandidate({
      evaluationSpecBytes: goldenStatePredicateSpecBytes({
        environmentRecord: {
          digest: { sha256: OTHER_RECORD_HEX },
          mediaType: "application/vnd.jinn.crypto-environment.v1+json",
        },
      }),
    }),
    compositeDigest: () => COMPOSITE_RECORD,
  },
  "execution-failed": {
    port: throwingChainPort(),
    candidate: goldenChainCandidate,
    compositeDigest: () => COMPOSITE_RECORD,
  },
  "inconsistent-observation": {
    port: contradictoryPort(),
    candidate: goldenChainCandidate,
    compositeDigest: () => COMPOSITE_RECORD,
  },
  "invalid-candidate": {
    port: scriptedChainPort(),
    candidate: () => goldenChainCandidate({ evaluationSpecBytes: goldenDeterministicProcessSpecBytes() }),
    compositeDigest: () => COMPOSITE_RECORD,
  },
  "reference-unsatisfied": {
    port: unsolvedReferencePort(),
    candidate: goldenChainCandidate,
    compositeDigest: () => COMPOSITE_RECORD,
  },
  "safety-violated": {
    port: safetyViolatingPort(),
    candidate: goldenChainCandidate,
    compositeDigest: () => COMPOSITE_RECORD,
  },
  "slice-insufficient": {
    port: outOfSlicePort(),
    candidate: goldenChainCandidate,
    compositeDigest: () => COMPOSITE_RECORD,
  },
  "unstable-observations": {
    port: flakyChainPort(),
    candidate: goldenChainCandidate,
    compositeDigest: () => COMPOSITE_RECORD,
  },
} as Record<string, ChainAdmissionRefusalScenario>;

export interface ChainAdmissionConformanceSubject {
  readonly admitChainCandidate: typeof import("./chain-admit.js").admitChainCandidate;
  readonly goldenChainCandidate: typeof goldenChainCandidate;
  readonly goldenChainReceipt: typeof goldenChainReceipt;
  readonly scriptedChainPort: typeof scriptedChainPort;
  readonly verifyChainReceipt: typeof import("./chain-receipt.js").verifyChainAdmissionReceiptV1;
}

/** The chain admission conformance kit. Green before derivation builds on this package. */
export function describeChainAdmissionConformance(
  label: string,
  subject: ChainAdmissionConformanceSubject,
): void {
  describe(`chain admission conformance (${label})`, () => {
    const deps: ChainAdmissionDeps = {
      issuer: "https://jinn.network/agents/kit",
      observeChain: subject.scriptedChainPort(),
    };

    it("admits a well-formed chain candidate", async () => {
      const result = await subject.admitChainCandidate(
        deps,
        subject.goldenChainCandidate(),
        COMPOSITE_RECORD,
      );
      expect("receipt" in result).toBe(true);
    });

    it("admits a candidate whose do-nothing side has individually satisfied predicates", async () => {
      const result = await subject.admitChainCandidate(
        deps,
        subject.goldenChainCandidate(),
        COMPOSITE_RECORD,
      );
      if (!("receipt" in result)) throw new Error("expected a receipt");
      expect(
        result.receipt.observations.doNothing[0]!.successPredicates.some((predicate) => predicate.satisfied),
      ).toBe(true);
    });

    it("carries the reference script as a digest and contains no script content", async () => {
      const result = await subject.admitChainCandidate(
        deps,
        subject.goldenChainCandidate(),
        COMPOSITE_RECORD,
      );
      if (!("receipt" in result)) throw new Error("expected a receipt");
      expect(result.receipt.referenceScriptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const json = JSON.stringify(result.receipt);
      expect(json).not.toContain("transactionIntent");
      expect(json).not.toMatch(/0x[0-9a-f]{64,}/);
    });

    it("reaches every code in the closed chain refusal taxonomy", async () => {
      const reached = new Set<string>();
      for (const scenario of Object.values(subject.scriptedChainPort.refusalScenarios)) {
        const result = await subject.admitChainCandidate(
          { issuer: "https://jinn.network/agents/kit", observeChain: scenario.port },
          scenario.candidate(),
          scenario.compositeDigest(),
        );
        if ("refusal" in result) reached.add(result.refusal.code);
      }
      expect([...reached].sort()).toStrictEqual([...CHAIN_ADMISSION_REFUSAL_CODES]);
    });

    it("refuses a deterministic-process spec at the chain entry point", async () => {
      const result = await subject.admitChainCandidate(
        deps,
        subject.goldenChainCandidate({ evaluationSpecBytes: goldenDeterministicProcessSpecBytes() }),
        COMPOSITE_RECORD,
      );
      expect("refusal" in result && result.refusal.code).toBe("invalid-candidate");
    });

    it("round-trips the golden receipt through policy validation", async () => {
      const golden = subject.goldenChainReceipt();
      expect(subject.verifyChainReceipt(golden)).toStrictEqual(golden);
      const result = await subject.admitChainCandidate(
        deps,
        subject.goldenChainCandidate(),
        COMPOSITE_RECORD,
      );
      if (!("receipt" in result)) throw new Error("expected a receipt");
      expect(subject.verifyChainReceipt(result.receipt)).toStrictEqual(result.receipt);
    });
  });

  describe(`cross-family admission (${label})`, () => {
    it("still refuses a chain spec at the SWE entry point", async () => {
      const result = await admitCandidate(
        { issuer: "https://jinn.network/agents/kit", runInEnvironment: scriptedRunner() },
        goldenSweCandidate({ evaluationSpecBytes: goldenStatePredicateSpecBytes() }),
        goldenEnvironmentRecordBytes(),
      );
      expect("refusal" in result).toBe(true);
    });
  });
}
