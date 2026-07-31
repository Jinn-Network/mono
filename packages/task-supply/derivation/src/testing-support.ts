// SPDX-License-Identifier: Apache-2.0

import {
  environmentRecordDigest,
  sealEnvironmentRecord,
  type EnvironmentRecord,
} from "@jinn-network/environment-record";
import {
  ADMISSION_RECEIPT_SCHEMA_VERSION,
  DIFFERENTIAL_ADMISSION_POLICY_V3,
  type AdmissionRefusalCode,
  type DifferentialAdmissionReceiptV3,
} from "@jinn-network/task-admission";
import type { Candidate } from "./candidate.js";
import { documentDigest } from "./digest.js";
import type { PoolEntry } from "./pool.js";
import type { AdmissionPort, AdmissionRequest } from "./run.js";
import { buildCandidateEvaluationSpec, buildSealedTask } from "./seal-pair.js";
import { computeSourceCommitment } from "./source-commitment.js";
import {
  IMPORT_STRATEGY_ID,
  PERMISSIVE_LICENSE_ALLOWLIST,
  type ImportStrategyInputs,
  type UpstreamRebenchRow,
} from "./strategies/import.js";
import { loadDerivationEnvironment, type DerivationEnvironment } from "./strategy.js";

const IMAGE_MANIFEST = `sha256:${"1".repeat(64)}`;
const PARSER_DIGEST = `sha256:${"2".repeat(64)}`;

/**
 * One fixture environment (design §4.2). Kept in code rather than JSON so a C1 schema
 * change breaks this at typecheck instead of at fixture-parse time.
 */
export function buildFixtureEnvironmentRecordBody(): EnvironmentRecord {
  return {
    kind: "https://jinn.network/records/environment/1.0",
    source: {
      repo: "acme/widget",
      repoUrl: "https://github.com/acme/widget",
      commit: "3".repeat(40),
    },
    image: {
      manifestDigest: IMAGE_MANIFEST,
      platform: "linux/amd64",
      reference: `registry.example/acme/widget@${IMAGE_MANIFEST}`,
    },
    workspace: "/testbed",
    invocations: {
      test: [{ bin: "python", args: ["-m", "pytest", "-q"], cwd: "/testbed" }],
    },
    parser: {
      id: "pytest",
      version: "1",
      digest: PARSER_DIGEST,
      uri: "https://example.invalid/parsers/pytest",
    },
    build: { reproducibilityTier: 0, provider: { id: "upstream-import", version: "1" } },
    rights: { sourceLicense: "Apache-2.0", basis: "upstream-permissive-filter" },
    lineage: {
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        keys: ["acme__widget-1234"],
      },
    },
  } satisfies EnvironmentRecord;
}

const MATERIAL_BYTES = new TextEncoder().encode(
  "--- a/tests/test_widget.py\n+++ b/tests/test_widget.py\n@@\n+def test_zero(): ...\n",
);
const GOLD_BYTES = new TextEncoder().encode(
  "--- a/widget.py\n+++ b/widget.py\n@@\n-raise\n+return 0\n",
);

/** One well-formed imported candidate against the fixture environment. */
export function buildFixtureCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "acme__widget-1234",
    statement: "Widget.resize() raises on zero width.\n",
    language: "python",
    testMaterial: [
      {
        name: "test-patch",
        mediaType: "text/x-diff",
        content: Buffer.from(MATERIAL_BYTES).toString("base64"),
        digest: documentDigest(MATERIAL_BYTES),
      },
    ],
    transitions: { failToPass: ["tests/test_widget.py::test_zero"], passToPass: [] },
    timeout: 900,
    goldPatch: GOLD_BYTES,
    provenance: {
      kind: "mined",
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        instanceId: "acme__widget-1234",
      },
    },
    rights: { sourceLicense: "Apache-2.0" },
    ...overrides,
  };
}

/** One upstream row against the fixture environment (`acme/widget@3333…`). */
export function buildFixtureRow(
  overrides: Partial<UpstreamRebenchRow> = {},
): UpstreamRebenchRow {
  return {
    instance_id: "acme__widget-1234",
    repo: "acme/widget",
    base_commit: "3".repeat(40),
    problem_statement: "Widget.resize() raises on zero width.\n",
    language: "python",
    patch: "--- a/widget.py\n+++ b/widget.py\n@@\n-raise\n+return 0\n",
    test_patch: "--- a/tests/test_widget.py\n+++ b/tests/test_widget.py\n@@\n+def test_zero(): ...\n",
    FAIL_TO_PASS: ["tests/test_widget.py::test_zero"],
    PASS_TO_PASS: ["tests/test_widget.py::test_basic"],
    license: "Apache-2.0",
    timeout: 900,
    ...overrides,
  };
}

/** The fixture environment, sealed and loaded — one source of truth for every suite. */
export function buildFixtureEnvironment(): DerivationEnvironment {
  return loadDerivationEnvironment(sealEnvironmentRecord(buildFixtureEnvironmentRecordBody()));
}

/**
 * A pool entry built by actually sealing the fixture candidate against the fixture
 * environment, with a fixed placeholder receipt digest — the pool does not care where a
 * receipt digest came from, only that the entry cites one.
 */
export function buildFixturePoolEntry(overrides: { statement?: string } = {}): PoolEntry {
  const env = buildFixtureEnvironment();
  const candidate = buildFixtureCandidate(
    overrides.statement === undefined ? {} : { statement: overrides.statement },
  );
  const spec = buildCandidateEvaluationSpec(candidate, env);
  const task = buildSealedTask(candidate, env, spec.digest);
  return {
    taskDigest: task.digest,
    taskBytes: task.bytes,
    evaluationSpecDigest: spec.digest,
    evaluationSpecBytes: spec.bytes,
    receiptDigest: `sha256:${"7".repeat(64)}`,
    environmentRecordDigest: env.recordDigest,
    strategyId: IMPORT_STRATEGY_ID,
    provenance: {
      kind: candidate.provenance.kind,
      sourceCommitment: computeSourceCommitment(candidate.provenance.upstream, candidate.statement),
      upstream: candidate.provenance.upstream,
    },
    rights: { sourceLicense: candidate.rights.sourceLicense },
  };
}

/** The strategy inputs every suite uses against the fixture environment. */
export function fixtureImportInputs(rows: UpstreamRebenchRow[]): ImportStrategyInputs {
  return {
    rows,
    upstream: { dataset: "nebius/SWE-rebench", revision: "refs/convert/parquet-2026-05-01" },
    defaultTimeoutSeconds: 900,
    licensePolicy: { allow: PERMISSIVE_LICENSE_ALLOWLIST },
  };
}

export interface StubAdmissionOptions {
  /** candidate id -> refusal code. */
  readonly refuse?: Record<string, string>;
  readonly goldHashOverride?: string;
  readonly throwOn?: string;
}

export interface StubAdmissionPort extends AdmissionPort {
  readonly seen: AdmissionRequest[];
  readonly published: string[];
}

function stubObservation() {
  return { passed: ["keeps"], failed: [], passedMatch: true };
}

/**
 * A scripted admission double. It performs no runs and proves nothing — it exists so this
 * package's own behaviour (refusal handling, gold routing, pool writes) is testable without
 * a container runtime. C3's kit is what tests admission.
 */
export function createStubAdmissionPort(options: StubAdmissionOptions = {}): StubAdmissionPort {
  const seen: AdmissionRequest[] = [];
  const published: string[] = [];
  let counter = 0;

  return {
    seen,
    published,
    async admit(request: AdmissionRequest) {
      seen.push(request);
      if (options.throwOn !== undefined && request.candidateId === options.throwOn) {
        throw new Error("admission port unavailable");
      }
      const refusal = options.refuse?.[request.candidateId];
      if (refusal !== undefined) {
        return { refusal: { code: refusal as AdmissionRefusalCode, detail: "scripted refusal" } };
      }
      const receipt: DifferentialAdmissionReceiptV3 = {
        schemaVersion: ADMISSION_RECEIPT_SCHEMA_VERSION,
        admissionPolicyVersion: DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion,
        issuer: "urn:jinn:test:stub-admission",
        task: {
          documentDigest: request.candidate.taskDocumentDigest,
          evaluationSpecDigest: documentDigest(request.candidate.evaluationSpecBytes),
          statementDigest: request.candidate.statementDigest,
          testMaterialDigests: [...request.candidate.testMaterialDigests],
          transitions: {
            failToPass: [...request.candidate.transitions.failToPass],
            passToPass: [...request.candidate.transitions.passToPass],
          },
        },
        goldPatchHash: (options.goldHashOverride ?? request.candidate.goldPatchHash) as `sha256:${string}`,
        testPaths: request.candidate.testPaths.map((testPath) => ({
          testPath,
          commandHash: `sha256:${"5".repeat(64)}` as const,
          broken: [stubObservation(), stubObservation()],
          fixed: [stubObservation(), stubObservation()],
          failToPass: [...request.candidate.transitions.failToPass],
          passToPass: [...request.candidate.transitions.passToPass],
        })),
        environment: {
          recordDigest: environmentRecordDigest(request.environmentRecordBytes) as `sha256:${string}`,
          inlineMatch: { fields: ["image", "parser", "platform"], specKeyPresent: true },
        },
        evalSemanticsVersion: request.candidate.evalSemanticsVersion,
      };
      return { receipt };
    },
    async publishReceipt() {
      counter += 1;
      const digest = `sha256:${String(counter).padStart(64, "0")}` as const;
      published.push(digest);
      return { digest };
    },
  };
}
