// SPDX-License-Identifier: Apache-2.0

/**
 * The component's gate (Task 10, `docs/superpowers/plans/2026-07-30-evaluator-adapters.md`):
 * both adapters driven through the REAL `runEvaluationHarness` — real workspace layout, real
 * unsigned `ResultEvaluationStatement` at `out/verdict`. The host signs those exact bytes after
 * validating them; no signing key enters the evaluator child. No mocking of the harness itself; only the
 * injected `GraderReportSource` / `ResolutionSnapshotSource` ports (Findings A/B) are supplied,
 * exactly as a host would supply them via the evaluation context (§8.3 supporting context).
 *
 * The workspace-building helper mirrors `evaluation-harness/src/runtime.test.ts:110-236`
 * (same file names: `task.sealed`, `subject-task.json`, `subject-delivery.json`, a Result
 * subject, `evaluation-spec.json`, `evaluation-context.json`, `dispatch-context.json`, plus an
 * host-selected evaluator registration).
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVALUATION_HARNESS_EXIT_INVALID_INPUT,
  EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE,
  defineEvaluatorRegistration,
  runEvaluationHarness,
  type EvaluationHarnessDeployment,
  type EvaluatorRegistration,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  deriveEvaluationTask,
  sealEvaluationSpec,
  type DeterministicProcessBlock,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import type { WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  evaluatorAdaptersParserAllowlist,
  PREDICTION_PARSER,
  SWE_REBENCH_PARSER,
} from "./parser-identity.js";
import { PREDICTION_FIXTURES } from "./prediction/fixtures.js";
import { SWE_REBENCH_FIXTURES } from "./swe-rebench/fixtures.js";
import { contextGraderReportSource } from "./swe-rebench/adapter.js";
import {
  contextResolutionSnapshotSource,
  predictionEvaluationSpecMeasurements,
  predictionEvaluationSpecVerdictRule,
} from "./prediction/adapter.js";
import {
  createPredictionEvaluatorRegistration,
  createSweRebenchEvaluatorRegistration,
} from "./registrations.js";

const encoder = new TextEncoder();
const temporaryRoots: string[] = [];

const digestHex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const digestString = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${digestHex(bytes)}`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

// --- canonical specs, built from the pinned parser identities ----------------------------

function sweRebenchSpec(
  transitions: { readonly failToPass: readonly string[]; readonly passToPass: readonly string[] },
): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: SWE_REBENCH_PARSER.id,
      digest: { sha256: SWE_REBENCH_PARSER.digest.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      image: { name: "swe-rebench-image", digest: { sha256: "a".repeat(64) } },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [],
      parser: SWE_REBENCH_PARSER,
      transitions: {
        failToPass: [...transitions.failToPass],
        passToPass: [...transitions.passToPass],
      },
      timeout: 1800,
    },
    measurements: [{ name: "passed", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
    unscorable: [{ name: "environment-setup-failure", disposition: "retryable-infrastructure" }],
    evidenceConventions: { requiredRefs: [] },
  } as EvaluationSpec;
}

function predictionSpec(): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: PREDICTION_PARSER.id,
      digest: { sha256: PREDICTION_PARSER.digest.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      image: { name: "prediction-image", digest: { sha256: "b".repeat(64) } },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [],
      parser: PREDICTION_PARSER,
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    },
    measurements: predictionEvaluationSpecMeasurements(),
    verdictRule: predictionEvaluationSpecVerdictRule(),
    unscorable: [],
    evidenceConventions: { requiredRefs: [] },
  } as EvaluationSpec;
}

// --- workspace construction, mirroring evaluation-harness/src/runtime.test.ts:110-236 ----

async function buildWorkspace(options: {
  readonly specification: EvaluationSpec;
  readonly resultName: string;
  readonly resultBytes: Uint8Array;
  readonly context: Record<string, unknown>;
}): Promise<{ readonly paths: WorkspacePaths }> {
  const root = await mkdtemp(join(tmpdir(), "jinn-evaluator-adapters-conformance-"));
  temporaryRoots.push(root);
  const paths: WorkspacePaths = {
    root,
    input: join(root, "input"),
    work: join(root, "work"),
    out: join(root, "out"),
    logs: join(root, "logs"),
    harnessState: join(root, "harness-state"),
    secrets: join(root, "secrets"),
    tmp: join(root, "tmp"),
    meta: join(root, "meta"),
  };
  await Promise.all(Object.values(paths).map((path) =>
    mkdir(path, { recursive: true })
  ));

  const sealed = sealEvaluationSpec(options.specification);
  const subjectTaskBytes = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: "https://jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "4".repeat(64) },
    },
    instructions: "Solve the task.",
    outputs: [{
      name: options.resultName,
      mediaType: "application/octet-stream",
      required: true,
    }],
    evaluation: {
      name: "evaluation-spec.json",
      digest: { sha256: sealed.digest.slice("sha256:".length) },
    },
  });
  const deliveryBytes = sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt: "urn:uuid:33333333-3333-4333-8333-333333333333",
    task: documentDigest(subjectTaskBytes),
    outputs: [{
      name: options.resultName,
      mediaType: "application/octet-stream",
      digest: { sha256: digestHex(options.resultBytes) },
    }],
    outcome: "fulfilled",
    createdAt: "2026-07-29T12:00:00.000Z",
  });
  const evaluationTask = deriveEvaluationTask({
    subjectTask: { name: "subject-task.json", digest: digestString(subjectTaskBytes) },
    subjectDelivery: { name: "subject-delivery.json", digest: digestString(deliveryBytes) },
    subjectResults: [{ name: options.resultName, digest: digestString(options.resultBytes) }],
    evaluationSpecDigest: sealed.digest,
  });

  await Promise.all([
    writeFile(join(paths.input, "task.sealed"), evaluationTask.bytes),
    writeFile(join(paths.input, "subject-task.json"), subjectTaskBytes),
    writeFile(join(paths.input, "subject-delivery.json"), deliveryBytes),
    writeFile(join(paths.input, options.resultName), options.resultBytes),
    writeFile(join(paths.input, "evaluation-spec.json"), sealed.bytes),
    writeFile(
      join(paths.input, "evaluation-context.json"),
      JSON.stringify(options.context),
    ),
    writeFile(
      join(paths.input, "dispatch-context.json"),
      JSON.stringify({
        taskDigest: evaluationTask.digest,
        submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
        nonce: "evaluation-nonce",
        attempt: "urn:uuid:22222222-2222-4222-8222-222222222222",
      }),
    ),
    writeFile(join(paths.meta, "attempt.json"), '{"safe":"metadata"}'),
    writeFile(join(paths.logs, "harness.ndjson"), '{"safe":"log"}\n'),
  ]);

  return { paths };
}

// --- deployment wiring -----------------------------------------------------------------

const sweRebenchRegistration = createSweRebenchEvaluatorRegistration({
  evaluatorId: "did:key:z6MkSweRebenchConformanceEvaluator",
  signerHandle: "evaluator-agent-key.pem",
  evaluationMethod: { name: "swe-rebench-evaluator", digest: { sha256: "5".repeat(64) } },
  graderReportSource: contextGraderReportSource(),
});

const predictionRegistration = createPredictionEvaluatorRegistration({
  evaluatorId: "did:key:z6MkPredictionConformanceEvaluator",
  signerHandle: "evaluator-agent-key.pem",
  evaluationMethod: { name: "prediction-evaluator", digest: { sha256: "6".repeat(64) } },
  resolutionSnapshotSource: contextResolutionSnapshotSource(),
});

function deployment(
  registrations: readonly EvaluatorRegistration[],
  parserAllowlist: ReadonlySet<string>,
): EvaluationHarnessDeployment {
  return {
    registrations: [...registrations],
    parserAllowlist,
    maxClaimEvidenceBytes: 1024 * 1024,
    evidenceWriter: {
      async putClaimEvidence({ name, bytes, mediaType }) {
        return {
          name,
          digest: { sha256: digestHex(bytes) },
          ...(mediaType === undefined ? {} : { mediaType }),
        };
      },
    },
  };
}

const BOTH_ADAPTERS = deployment(
  [sweRebenchRegistration, predictionRegistration],
  evaluatorAdaptersParserAllowlist(),
);

async function readVerdictStatement(paths: WorkspacePaths): Promise<{
  readonly predicateType: string;
  readonly predicate: { readonly verdict: string; readonly [key: string]: unknown };
}> {
  const statementBytes = await readFile(join(paths.out, "verdict"));
  return JSON.parse(statementBytes.toString("utf8")) as {
    predicateType: string;
    predicate: { verdict: string; [key: string]: unknown };
  };
}

function sweRebenchFixture(name: string) {
  const fixture = SWE_REBENCH_FIXTURES.find((entry) => entry.name === name);
  if (fixture === undefined) throw new Error(`unknown swe-rebench fixture: ${name}`);
  return fixture;
}

function predictionFixture(name: string) {
  const fixture = PREDICTION_FIXTURES.find((entry) => entry.name === name);
  if (fixture === undefined) throw new Error(`unknown prediction fixture: ${name}`);
  return fixture;
}

describe("evaluator adapters conform to the real evaluation harness", () => {
  test("case 1 — swe-rebench pass produces an unsigned host-sealable statement with predicate pass", async () => {
    const fixture = sweRebenchFixture("resolved-all-transitions");
    const { paths } = await buildWorkspace({
      specification: sweRebenchSpec(fixture.transitions),
      resultName: "result.patch",
      resultBytes: encoder.encode("diff --git a/a b/a\n"),
      context: { graderReport: fixture.report, graderLog: fixture.log },
    });

    const exitCode = await runEvaluationHarness(paths, BOTH_ADAPTERS);
    expect(exitCode).toBe(0);

    const statement = await readVerdictStatement(paths);
    expect(statement.predicateType).toBe(
      "https://jinn.network/attestations/result-evaluation/v1",
    );
    expect(statement.predicate.verdict).toBe("pass");
  });

  test("case 2 — swe-rebench fail produces predicate verdict fail", async () => {
    const fixture = sweRebenchFixture("unresolved-fail-to-pass-still-failing");
    const { paths } = await buildWorkspace({
      specification: sweRebenchSpec(fixture.transitions),
      resultName: "result.patch",
      resultBytes: encoder.encode("diff --git a/a b/a\n"),
      context: { graderReport: fixture.report, graderLog: fixture.log },
    });

    const exitCode = await runEvaluationHarness(paths, BOTH_ADAPTERS);
    expect(exitCode).toBe(0);

    const statement = await readVerdictStatement(paths);
    expect(statement.predicate.verdict).toBe("fail");
  });

  test("case 3 — swe-rebench ungradeable is an operational failure and writes no verdict (unscorable is never a silent zero)", async () => {
    const fixture = sweRebenchFixture("ungradeable-docker-unavailable");
    const { paths } = await buildWorkspace({
      specification: sweRebenchSpec(fixture.transitions),
      resultName: "result.patch",
      resultBytes: encoder.encode("diff --git a/a b/a\n"),
      context: { graderReport: fixture.report, graderLog: fixture.log },
    });

    const exitCode = await runEvaluationHarness(paths, BOTH_ADAPTERS);
    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE);
    await expect(readFile(join(paths.out, "verdict"))).rejects.toThrow();
  });

  test.each([
    ["scored-yes-solver-beats-consensus", "pass"],
    ["rejected-submission-outside-window", "fail"],
    ["inconclusive-market-unresolved", "inconclusive"],
  ] as const)(
    "case 4 — prediction fixture %s yields verdict %s via the spec's own verdictRule",
    async (name, expectedVerdict) => {
      const fixture = predictionFixture(name);
      const { paths } = await buildWorkspace({
        specification: predictionSpec(),
        resultName: "prediction-result.json",
        resultBytes: fixture.resultBytes,
        context: {
          resolutionSnapshot: fixture.snapshot,
          market: fixture.market,
          window: fixture.window,
          consensusProbabilityYes: fixture.consensusProbabilityYes,
        },
      });

      const exitCode = await runEvaluationHarness(paths, BOTH_ADAPTERS);
      expect(exitCode).toBe(0);

      const statement = await readVerdictStatement(paths);
      expect(statement.predicate.verdict).toBe(expectedVerdict);
    },
  );

  test("case 5 — a digest-drifted parser is refused by the deployment allowlist before any registration is consulted (E16)", async () => {
    // The gate under test is `enforceParserAllowlist`, called BEFORE `selectRegistration`
    // (runtime.ts:755-756). It is module-private with no export, so the only way to prove it
    // fires — rather than merely proving *some* refusal happens — is to give the deployment a
    // registration that would happily serve ANY specification (`specificationCompatibility:
    // () => true`) and confirm its `evaluate` is still never invoked. If the allowlist gate
    // were skipped or bypassed, this wildcard registration would accept the drifted spec and
    // the run would succeed; it does not.
    const fixture = sweRebenchFixture("resolved-all-transitions");
    const canonical = sweRebenchSpec(fixture.transitions);
    const drifted: EvaluationSpec = {
      ...canonical,
      familyBlock: {
        ...(canonical.familyBlock as DeterministicProcessBlock),
        parser: { ...SWE_REBENCH_PARSER, digest: `sha256:${"0".repeat(64)}` },
      },
    };
    const wildcardEvaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>(
      async () => ({
        detailedOutcome: {},
        verdict: "pass",
        evaluatedAt: "2026-07-30T00:00:00.000Z",
        measurements: [{ name: "passed", value: true }],
      }),
    );
    const wildcardRegistration = defineEvaluatorRegistration({
      registrationId: "wildcard-would-accept-anything",
      adapter: { evaluate: wildcardEvaluate },
      evaluationMethod: { name: "wildcard", digest: { sha256: "7".repeat(64) } },
      specificationCompatibility: () => true,
      evaluatorIdentity: { id: "did:key:z6MkWildcardConformanceEvaluator" },
      signer: { handle: "evaluator-agent-key.pem" },
      outcomeValidator: (evaluation) => evaluation,
      interruptionBehavior: "repeatable",
    });

    const { paths } = await buildWorkspace({
      specification: drifted,
      resultName: "result.patch",
      resultBytes: encoder.encode("diff --git a/a b/a\n"),
      context: { graderReport: fixture.report, graderLog: fixture.log },
    });

    const exitCode = await runEvaluationHarness(
      paths,
      deployment([wildcardRegistration], evaluatorAdaptersParserAllowlist()),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(wildcardEvaluate).not.toHaveBeenCalled();
    await expect(readFile(join(paths.out, "verdict"))).rejects.toThrow();
  });

  test("case 6 — a verdict is written exactly once per workspace (atomicExclusiveWrite seal-once)", async () => {
    const fixture = sweRebenchFixture("resolved-all-transitions");
    const { paths } = await buildWorkspace({
      specification: sweRebenchSpec(fixture.transitions),
      resultName: "result.patch",
      resultBytes: encoder.encode("diff --git a/a b/a\n"),
      context: { graderReport: fixture.report, graderLog: fixture.log },
    });

    const first = await runEvaluationHarness(paths, BOTH_ADAPTERS);
    expect(first).toBe(0);

    const second = await runEvaluationHarness(paths, BOTH_ADAPTERS);
    expect(second).toBe(EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE);
  });
});
