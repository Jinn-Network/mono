// SPDX-License-Identifier: Apache-2.0

import {
  environmentRecordDigest,
  sealEnvironmentRecord,
} from "@jinn-network/environment-record";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";
import type {
  AdmissionCandidate,
  EnvironmentRunObservation,
  EnvironmentRunRequest,
  RunInEnvironmentPort,
} from "./admit.js";
import { ADMISSION_RECEIPT_SCHEMA_VERSION, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import type { DifferentialAdmissionReceiptV3 } from "./receipt.js";
import { ADMISSION_REFUSAL_CODES } from "./refusals.js";

const digest = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const BROKEN = { passed: ["keeps"], failed: ["target"], passedMatch: false } as const;
const FIXED = { passed: ["keeps", "target"], failed: [], passedMatch: true } as const;

const MANIFEST = digest("1");
const PARSER = digest("3");
const GOLD = digest("5");

/** A policy-valid receipt over one discriminating test path. */
export function goldenReceipt(): DifferentialAdmissionReceiptV3 {
  return {
    schemaVersion: ADMISSION_RECEIPT_SCHEMA_VERSION,
    admissionPolicyVersion: DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion,
    issuer: "https://spec.jinn.network/agents/admission-1",
    task: {
      documentDigest: digest("1"),
      evaluationSpecDigest: digest("2"),
      statementDigest: digest("3"),
      testMaterialDigests: [digest("4")],
      transitions: { failToPass: ["target"], passToPass: ["keeps"] },
    },
    goldPatchHash: digest("5"),
    testPaths: [{
      testPath: "tests/unit/test_thing.py",
      commandHash: digest("6"),
      broken: [{ ...BROKEN, passed: [...BROKEN.passed], failed: [...BROKEN.failed] },
               { ...BROKEN, passed: [...BROKEN.passed], failed: [...BROKEN.failed] }],
      fixed: [{ ...FIXED, passed: [...FIXED.passed], failed: [...FIXED.failed] },
              { ...FIXED, passed: [...FIXED.passed], failed: [...FIXED.failed] }],
      failToPass: ["target"],
      passToPass: ["keeps"],
    }],
    environment: {
      recordDigest: digest("7"),
      inlineMatch: { fields: ["image", "parser", "platform"], specKeyPresent: true },
    },
    evalSemanticsVersion: "4",
  };
}

/**
 * A sealed, tier-0 imported environment record: one image, one platform, one targetable test
 * command, one pinned parser.
 */
export function goldenEnvironmentRecordBytes(): Uint8Array {
  return sealEnvironmentRecord({
    kind: "https://spec.jinn.network/records/environment/v1",
    source: { repo: "owner/name", repoUrl: "https://github.com/owner/name", commit: "a".repeat(40) },
    image: {
      manifestDigest: MANIFEST,
      platform: "linux/amd64",
      reference: `ghcr.io/example/env@${MANIFEST}`,
    },
    workspace: "/testbed",
    invocations: { test: [{ bin: "python", args: ["-m", "pytest", "-rA"], cwd: "/testbed" }] },
    parser: { id: "pytest-log", version: "3", digest: PARSER },
    build: { reproducibilityTier: 0, provider: { id: "upstream-import", version: "1" } },
    rights: { sourceLicense: "MIT" },
  } as never);
}

/**
 * An EvaluationSpec whose inline deterministic-process block matches the golden record. The block
 * mirrors `DETERMINISTIC_PROCESS_SHAPE` in
 * packages/task-execution/profiles/src/evaluation-spec/family-blocks.ts field for field — this
 * fixture is the compatibility proof for the local reader in inline-match.ts (design §3.3
 * forbids importing profiles).
 */
export function goldenEvaluationSpecBytes(blockOverrides: Record<string, unknown> = {}): Uint8Array {
  // Canonical bytes — exactly what `sealEvaluationSpec` emits, and what admission requires: the
  // receipt's evaluation-spec subject is the digest of these bytes.
  return canonicalJsonBytes({
    protocol: "https://spec.jinn.network/profiles/evaluation-spec/v1",
    family: "deterministic-process",
    familyBlock: {
      image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST.slice(7) } },
      platform: "linux/amd64",
      workspace: { path: "/testbed" },
      testMaterial: [{ name: "test-patch", digest: { sha256: digest("4").slice(7) }, accessClass: "public" }],
      parser: { id: "pytest-log", version: "3", digest: PARSER },
      transitions: { failToPass: ["target"], passToPass: ["keeps"] },
      timeout: 1800,
      "network.jinn.environment.record": {
        digest: { sha256: environmentRecordDigest(goldenEnvironmentRecordBytes()).slice(7) },
      },
      ...blockOverrides,
    },
  });
}

export function goldenCandidate(overrides: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    taskDocumentDigest: digest("1"),
    statementDigest: digest("3"),
    testMaterialDigests: [digest("4")],
    transitions: { failToPass: ["target"], passToPass: ["keeps"] },
    goldPatchHash: GOLD,
    evaluationSpecBytes: goldenEvaluationSpecBytes(),
    testPaths: ["tests/unit/test_thing.py"],
    evalSemanticsVersion: "4",
    ...overrides,
  };
}

/** The mandatory adversarial fixture (design §7.1): inline image != referenced record. */
export function mismatchedImageCandidate(): AdmissionCandidate {
  const other = digest("2");
  return goldenCandidate({
    evaluationSpecBytes: goldenEvaluationSpecBytes({
      image: { uri: `ghcr.io/example/env@${other}`, digest: { sha256: other.slice(7) } },
    }),
  });
}

/**
 * The unsolvable-pair fixture (design §7.1, first bullet): the candidate declares — and its spec
 * grades — a fail-to-pass assertion the gold patch never flips. Paired with `scriptedRunner()`,
 * whose gold side flips `target` only, so `phantom` is declared and never proven.
 */
export function unprovenTransitionsCandidate(): AdmissionCandidate {
  const transitions = { failToPass: ["target", "phantom"], passToPass: ["keeps"] };
  return goldenCandidate({
    transitions,
    evaluationSpecBytes: goldenEvaluationSpecBytes({ transitions }),
  });
}

/** A pure runner whose per-side answers are scripted; it never touches a container. */
export function scriptedRunner(
  script: Partial<Record<"none" | "gold", EnvironmentRunObservation>> = {},
): RunInEnvironmentPort {
  return async (request: EnvironmentRunRequest) => {
    const gold = request.patch.kind === "gold";
    return script[request.patch.kind] ?? {
      passed: gold ? ["keeps", "target"] : ["keeps"],
      failed: gold ? [] : ["target"],
      passedMatch: gold,
      appliedPatchDigest: gold ? GOLD : null,
    };
  };
}

/**
 * The blind-empty-side fixture (design §7.1, second bullet): the empty side parses nothing at all
 * — a collection error, a broken container — while the gold side reports everything passing.
 * Absence is not discrimination, so this must never be admitted.
 */
export function blindEmptySideRunner(): RunInEnvironmentPort {
  return async (request: EnvironmentRunRequest) => {
    const gold = request.patch.kind === "gold";
    return {
      passed: gold ? ["keeps", "target"] : [],
      failed: [],
      passedMatch: gold,
      appliedPatchDigest: gold ? GOLD : null,
    };
  };
}

/** Honors the patch binding on both sides and returns the same inert reading everywhere. */
function inertRunner(): RunInEnvironmentPort {
  return async (request: EnvironmentRunRequest) => ({
    passed: ["keeps"],
    failed: [],
    passedMatch: true,
    appliedPatchDigest: request.patch.kind === "gold" ? GOLD : null,
  });
}

/**
 * Honors the patch binding, but its first run disagrees with every later one — so the *only*
 * defect it introduces is repeat instability.
 */
function flakyRunner(): RunInEnvironmentPort {
  let call = 0;
  return async (request: EnvironmentRunRequest) => ({
    passed: call++ === 0 ? ["keeps"] : ["keeps", "flake"],
    failed: ["target"],
    passedMatch: false,
    appliedPatchDigest: request.patch.kind === "gold" ? GOLD : null,
  });
}

function throwingRunner(): RunInEnvironmentPort {
  return async () => {
    throw new Error("container runtime unavailable");
  };
}

export interface AdmissionRefusalScenario {
  readonly runner: RunInEnvironmentPort;
  readonly candidate: () => AdmissionCandidate;
  readonly recordBytes: () => Uint8Array;
}

/** One scenario per refusal code, so a consumer can prove the taxonomy is reachable and closed. */
scriptedRunner.refusalScenarios = {
  // Two test paths, one runner reading: `keeps` is claimed by both paths.
  "duplicate-assertion-id": {
    runner: scriptedRunner(),
    candidate: () =>
      goldenCandidate({ testPaths: ["tests/unit/test_thing.py", "tests/unit/test_other.py"] }),
    recordBytes: goldenEnvironmentRecordBytes,
  },
  "env-record-mismatch": {
    runner: scriptedRunner(),
    candidate: mismatchedImageCandidate,
    recordBytes: goldenEnvironmentRecordBytes,
  },
  "execution-failed": {
    runner: throwingRunner(),
    candidate: goldenCandidate,
    recordBytes: goldenEnvironmentRecordBytes,
  },
  "invalid-candidate": {
    runner: scriptedRunner(),
    candidate: () => goldenCandidate({ testPaths: ["../escape.py"] }),
    recordBytes: goldenEnvironmentRecordBytes,
  },
  "invalid-environment-record": {
    runner: scriptedRunner(),
    candidate: goldenCandidate,
    recordBytes: () => new TextEncoder().encode("{not json"),
  },
  "no-discrimination": {
    runner: inertRunner(),
    candidate: goldenCandidate,
    recordBytes: goldenEnvironmentRecordBytes,
  },
  "transitions-mismatch": {
    runner: scriptedRunner(),
    candidate: unprovenTransitionsCandidate,
    recordBytes: goldenEnvironmentRecordBytes,
  },
  "unstable-observations": {
    runner: flakyRunner(),
    candidate: goldenCandidate,
    recordBytes: goldenEnvironmentRecordBytes,
  },
} as Record<string, AdmissionRefusalScenario>;

export interface TaskAdmissionConformanceSubject {
  readonly admitCandidate: typeof import("./admit.js").admitCandidate;
  readonly goldenCandidate: typeof goldenCandidate;
  readonly goldenEnvironmentRecordBytes: typeof goldenEnvironmentRecordBytes;
  readonly goldenReceipt: typeof goldenReceipt;
  readonly mismatchedImageCandidate: typeof mismatchedImageCandidate;
  readonly scriptedRunner: typeof scriptedRunner;
  readonly verifyReceipt: typeof import("./receipt.js").verifyDifferentialAdmissionReceiptV3;
}

/** The admission conformance kit (spec §11). Green before derivation builds on this package. */
export function describeTaskAdmissionConformance(
  label: string,
  subject: TaskAdmissionConformanceSubject,
): void {
  describe(`task admission conformance (${label})`, () => {
    const deps = { issuer: "https://spec.jinn.network/agents/kit", runInEnvironment: subject.scriptedRunner() };

    it("admits a discriminating candidate against its own environment record", async () => {
      const result = await subject.admitCandidate(
        deps, subject.goldenCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      expect("receipt" in result).toBe(true);
    });

    it("refuses env-record-mismatch when the inline image is not the referenced record's", async () => {
      const result = await subject.admitCandidate(
        deps, subject.mismatchedImageCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      expect("refusal" in result && result.refusal.code).toBe("env-record-mismatch");
    });

    it("records that the inline-match check ran", async () => {
      const result = await subject.admitCandidate(
        deps, subject.goldenCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      if (!("receipt" in result)) throw new Error("expected a receipt");
      expect(result.receipt.environment.inlineMatch).toStrictEqual({
        fields: ["image", "parser", "platform"], specKeyPresent: true,
      });
    });

    it("carries the gold patch as a digest and never as bytes", async () => {
      const result = await subject.admitCandidate(
        deps, subject.goldenCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      if (!("receipt" in result)) throw new Error("expected a receipt");
      expect(result.receipt.goldPatchHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(result.receipt)).not.toContain("diff --git");
    });

    it("round-trips the golden receipt, and its own, through policy validation", async () => {
      const golden = subject.goldenReceipt();
      expect(subject.verifyReceipt(golden)).toStrictEqual(golden);
      const result = await subject.admitCandidate(
        deps, subject.goldenCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      if (!("receipt" in result)) throw new Error("expected a receipt");
      expect(subject.verifyReceipt(result.receipt)).toStrictEqual(result.receipt);
    });

    it("reaches every code in the closed refusal taxonomy", async () => {
      const reached = new Set<string>();
      for (const scenario of Object.values(subject.scriptedRunner.refusalScenarios)) {
        const result = await subject.admitCandidate(
          { issuer: "https://spec.jinn.network/agents/kit", runInEnvironment: scenario.runner },
          scenario.candidate(),
          scenario.recordBytes(),
        );
        if ("refusal" in result) reached.add(result.refusal.code);
      }
      expect([...reached].sort()).toStrictEqual([...ADMISSION_REFUSAL_CODES]);
    });

    it("proves the candidate's own declared transitions, not merely some transition", async () => {
      const result = await subject.admitCandidate(
        deps, unprovenTransitionsCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      expect("refusal" in result && result.refusal.code).toBe("transitions-mismatch");
    });

    it("refuses an empty side that produced no reading at all", async () => {
      const result = await subject.admitCandidate(
        { issuer: "https://spec.jinn.network/agents/kit", runInEnvironment: blindEmptySideRunner() },
        subject.goldenCandidate(),
        subject.goldenEnvironmentRecordBytes(),
      );
      expect("refusal" in result).toBe(true);
    });
  });
}

export { admitChainCandidate } from "./chain-admit.js";
export { verifyChainAdmissionReceiptV1 } from "./chain-receipt.js";
export * from "./chain-testing.js";
