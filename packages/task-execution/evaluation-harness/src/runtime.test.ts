// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResultEvaluationStatementSchema,
} from "@jinn-network/evidence-protocol";
import {
  deriveEvaluationTask,
  EVALUATION_SPEC_FORMAT_URI,
  parserAllowlistKey,
  sealEvaluationSpec,
  type DeterministicProcessBlock,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import type { WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test, vi } from "vitest";
import { documentDigest, sealDelivery, sealTask } from "@jinn-network/task-execution-protocol";
import {
  EVALUATION_HARNESS_EXIT_INVALID_INPUT,
  EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE,
  EVALUATION_HARNESS_EXIT_PROVIDER_UNAVAILABLE,
  runEvaluationHarness,
  type EvaluationHarnessDeployment,
} from "./runtime.js";
import {
  defineEvaluatorRegistration,
  type EvaluatorRegistration,
} from "./registration.js";
import { EvaluationOperationalError } from "./adapter.js";

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

function validSpec(): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: "4",
    family: "deterministic-process",
    grader: {
      name: "grader-bundle",
      digest: { sha256: "1".repeat(64) },
      accessClass: "private",
    },
    familyBlock: {
      image: {
        name: "grader-image",
        digest: { sha256: "2".repeat(64) },
      },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [],
      parser: {
        id: "jinn.parser.control",
        version: "1.0.0",
        digest: `sha256:${"3".repeat(64)}`,
      },
      transitions: { failToPass: [], passToPass: [] },
      timeout: 30,
    },
    measurements: [
      { name: "passed", type: "boolean", required: true },
      { name: "tests", type: "number", required: true },
    ],
    verdictRule: {
      all: [
        { threshold: { measurement: "passed", op: "eq", value: true } },
        { threshold: { measurement: "tests", op: "gte", value: 1 } },
      ],
    },
    unscorable: [{
      name: "grader-infrastructure",
      disposition: "retryable-infrastructure",
    }],
    evidenceConventions: { requiredRefs: ["evaluation-report.json"] },
  };
}

/**
 * The live round-24 receipt shape, verbatim from the native requester's Submission annotation
 * (`client/src/native-requester/requester.ts`): a named, media-typed, sha256-pinned descriptor.
 */
const ADMISSION_RECEIPT_MEDIA_TYPE = "application/vnd.in-toto+json";
const admissionReceiptBytes = encoder.encode(
  '{"payloadType":"application/vnd.in-toto+json","payload":"e30=","signatures":[]}',
);

interface Fixture {
  readonly paths: WorkspacePaths;
  readonly spec: EvaluationSpec;
  readonly specBytes: Uint8Array;
  readonly specDigest: `sha256:${string}`;
  readonly evaluationTaskDigest: `sha256:${string}`;
  readonly subjectTaskRef: { readonly name: string; readonly digest: `sha256:${string}` };
  readonly subjectDeliveryRef: { readonly name: string; readonly digest: `sha256:${string}` };
  readonly subjectResultRefs: readonly {
    readonly name: string;
    readonly digest: `sha256:${string}`;
  }[];
  readonly admissionReceiptDescriptor: {
    readonly name: string;
    readonly mediaType: string;
    readonly digest: { readonly sha256: string };
  };
}

async function makeFixture(options: {
  readonly specification?: EvaluationSpec;
  readonly specificationBytes?: Uint8Array;
  readonly subjectEvaluationDigest?: `sha256:${string}`;
  readonly subjectOutputs?: readonly {
    readonly name: string;
    readonly mediaType: string;
    readonly required: boolean;
  }[];
  /**
   * #40. `true` reproduces the live requester-sealed shape: the sealed evaluation Task carries the
   * fourth `admission-receipt` input descriptor and the provisioner stages its bytes under that
   * name. Default `false` keeps the receipt-free 3-input shape the benchmark-product venue and the
   * policy-optimization host still produce.
   */
  readonly admissionReceipt?: boolean;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "jinn-evaluation-runtime-"));
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

  const spec = options.specification ?? validSpec();
  const sealed = options.specificationBytes === undefined
    ? sealEvaluationSpec(spec)
    : {
        bytes: options.specificationBytes,
        digest: digestString(options.specificationBytes),
      };
  const subjectTaskBytes = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "4".repeat(64) },
    },
    instructions: "Return the requested patch.",
    outputs: options.subjectOutputs ?? [{
      name: "result.patch",
      mediaType: "text/x-diff",
      required: true,
    }],
    evaluation: {
      name: "evaluation-spec.json",
      digest: {
        sha256: (
          options.subjectEvaluationDigest ?? sealed.digest
        ).slice("sha256:".length),
      },
    },
  });
  const resultBytes = encoder.encode("diff --git a/a b/a\n");
  const deliveryBytes = sealDelivery({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    attempt: "urn:uuid:33333333-3333-4333-8333-333333333333",
    task: documentDigest(subjectTaskBytes),
    outputs: [{
      name: "result.patch",
      mediaType: "text/x-diff",
      digest: { sha256: digestHex(resultBytes) },
    }],
    outcome: "fulfilled",
    createdAt: "2026-07-29T12:00:00.000Z",
  });
  const subjectTaskRef = {
    name: "subject-task.json",
    digest: digestString(subjectTaskBytes),
  };
  const subjectDeliveryRef = {
    name: "subject-delivery.json",
    digest: digestString(deliveryBytes),
  };
  const subjectResultRefs = [{
    name: "result.patch",
    digest: digestString(resultBytes),
  }];
  const admissionReceiptDescriptor = {
    name: "admission-receipt",
    mediaType: ADMISSION_RECEIPT_MEDIA_TYPE,
    digest: { sha256: digestHex(admissionReceiptBytes) },
  };
  const evaluationTask = deriveEvaluationTask({
    subjectTask: subjectTaskRef,
    subjectDelivery: subjectDeliveryRef,
    subjectResults: [...subjectResultRefs],
    evaluationSpecDigest: sealed.digest,
    ...(options.admissionReceipt === true
      ? { admissionReceipt: admissionReceiptDescriptor }
      : {}),
  });

  await Promise.all([
    writeFile(join(paths.input, "task.sealed"), evaluationTask.bytes),
    writeFile(join(paths.input, "subject-task.json"), subjectTaskBytes),
    writeFile(join(paths.input, "subject-delivery.json"), deliveryBytes),
    writeFile(join(paths.input, "result.patch"), resultBytes),
    ...(options.admissionReceipt === true
      ? [writeFile(join(paths.input, "admission-receipt"), admissionReceiptBytes)]
      : []),
    writeFile(join(paths.input, "evaluation-spec.json"), sealed.bytes),
    writeFile(
      join(paths.input, "evaluation-context.json"),
      JSON.stringify({ allowedContext: "control" }),
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

  return {
    paths,
    spec,
    specBytes: sealed.bytes,
    specDigest: sealed.digest,
    evaluationTaskDigest: evaluationTask.digest,
    subjectTaskRef,
    subjectDeliveryRef,
    subjectResultRefs,
    admissionReceiptDescriptor,
  };
}

/**
 * Rewrites the staged sealed Task's `inputs` in place. The rewritten bytes are deliberately NOT
 * re-sealed canonically, so this is only ever used for refusals that fire in `readEvaluationTask`
 * — strictly before the derivation byte-compare, which would otherwise mask which check refused.
 */
async function restageTaskInputs(
  fixture: Fixture,
  rewrite: (inputs: unknown[]) => unknown[],
): Promise<void> {
  const path = join(fixture.paths.input, "task.sealed");
  const document = JSON.parse(await readFile(path, "utf8")) as {
    inputs: unknown[];
  };
  document.inputs = rewrite(document.inputs);
  await writeFile(path, encoder.encode(JSON.stringify(document)));
}

function registration(
  evaluate: EvaluatorRegistration["adapter"]["evaluate"],
): EvaluatorRegistration {
  return defineEvaluatorRegistration({
    registrationId: "control-evaluator",
    adapter: { evaluate },
    evaluationMethod: {
      name: "evaluation-harness-control",
      digest: { sha256: "5".repeat(64) },
      uri: "https://spec.jinn.network/software/evaluation-harness/control-v1",
    },
    specificationCompatibility: (specification) =>
      specification.family === "deterministic-process",
    evaluatorIdentity: {
      id: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
    },
    signer: { handle: "evaluator-agent-key.pem" },
    outcomeValidator: (completed) => completed,
    interruptionBehavior: "repeatable",
  });
}

function deployment(
  spec: EvaluationSpec,
  evaluator: EvaluatorRegistration,
  parserAllowed = true,
): EvaluationHarnessDeployment {
  return {
    registrations: [evaluator],
    parserAllowlist: new Set(
      parserAllowed && spec.family === "deterministic-process"
        ? [
            parserAllowlistKey(
              (spec.familyBlock as DeterministicProcessBlock).parser,
            ),
          ]
        : [],
    ),
    maxClaimEvidenceBytes: 1024,
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

async function allFileText(directory: string): Promise<string> {
  let output = "";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    output += entry.isDirectory()
      ? await allFileText(path)
      : await readFile(path, "utf8");
  }
  return output;
}

describe("runEvaluationHarness", () => {
  test("writes the exact crosswalk-stamped Result Evaluation payload for host sealing", async () => {
    const fixture = await makeFixture();
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>(
      async (task, results, specification, context, attempt, signal) => {
        expect(digestString(task.bytes)).toBe(task.descriptor.digest?.sha256
          ? `sha256:${task.descriptor.digest.sha256}`
          : undefined);
        expect(results.map((result) => result.descriptor.name)).toEqual([
          "result.patch",
        ]);
        expect(specification).toEqual(fixture.spec);
        expect(context).toEqual({ allowedContext: "control" });
        expect(attempt).toMatchObject({
          attemptUri: "urn:uuid:22222222-2222-4222-8222-222222222222",
          nonce: "evaluation-nonce",
          attemptNumber: 1,
        });
        expect(signal.aborted).toBe(false);
        return {
          detailedOutcome: { control: true },
          verdict: "pass",
          evaluatedAt: "2026-07-29T12:00:00.000Z",
          measurements: [
            { name: "passed", value: true },
            { name: "tests", value: 7, unit: "count" },
          ],
          explanation: "The declared controls passed.",
          claimEvidence: [{
            kind: "descriptor",
            descriptor: {
              name: "evaluation-report.json",
              digest: { sha256: "6".repeat(64) },
              mediaType: "application/json",
            },
          }],
        };
      },
    );

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(0);
    expect(evaluate).toHaveBeenCalledOnce();
    const payloadBytes = await readFile(join(fixture.paths.out, "verdict"));
    const statement = ResultEvaluationStatementSchema.parse(
      JSON.parse(payloadBytes.toString("utf8")),
    ) as {
      predicate: {
        evaluationSpecification: { digest: { sha256: string } };
        evaluationMethod: { digest: { sha256: string } };
        evaluator: { id: string };
        measurements: readonly { name: string; value: unknown }[];
        evidence: readonly { name: string }[];
        verdict: string;
      };
    };
    expect(statement.predicate).toMatchObject({
      verdict: "pass",
      evaluator: {
        id: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
      },
      evaluationSpecification: {
        digest: { sha256: fixture.specDigest.slice("sha256:".length) },
      },
      evaluationMethod: { digest: { sha256: "5".repeat(64) } },
    });
    expect(statement.predicate.measurements.map(({ name }) => name)).toEqual([
      "passed",
      "tests",
    ]);
    expect(statement.predicate.evidence.map(({ name }) => name)).toEqual([
      "evaluation-report.json",
    ]);
    expect(await readdir(fixture.paths.secrets)).toEqual([]);
  });

  test("stores content claim evidence through the injected writer before issuing", async () => {
    const fixture = await makeFixture();
    const claimBytes = encoder.encode('{"passed":true}');
    const writer = vi.fn(async ({ name, bytes, mediaType }: {
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly mediaType?: string;
    }) => ({
      name,
      digest: { sha256: digestHex(bytes) },
      ...(mediaType === undefined ? {} : { mediaType }),
    }));
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>(
      async () => ({
        detailedOutcome: {},
        verdict: "pass",
        evaluatedAt: "2026-07-29T12:00:00.000Z",
        measurements: [
          { name: "passed", value: true },
          { name: "tests", value: 1 },
        ],
        claimEvidence: [{
          kind: "content",
          name: "evaluation-report.json",
          bytes: claimBytes,
          mediaType: "application/json",
        }],
      }),
    );
    const configured = {
      ...deployment(fixture.spec, registration(evaluate)),
      maxClaimEvidenceBytes: 1024,
      evidenceWriter: { putClaimEvidence: writer },
    } as unknown as EvaluationHarnessDeployment;

    expect(configured.evidenceWriter.putClaimEvidence).toBe(writer);
    const exitCode = await runEvaluationHarness(fixture.paths, configured);

    expect(evaluate).toHaveBeenCalledOnce();
    expect(writer).toHaveBeenCalledWith({
      name: "evaluation-report.json",
      bytes: claimBytes,
      mediaType: "application/json",
    }, { signal: undefined });
    expect(exitCode).toBe(0);
  });

  test("rejects over-limit content evidence before writer I/O", async () => {
    const fixture = await makeFixture();
    const writer = vi.fn();
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>(
      async () => ({
        detailedOutcome: {}, verdict: "pass", evaluatedAt: "2026-07-29T12:00:00.000Z",
        measurements: [{ name: "passed", value: true }, { name: "tests", value: 1 }],
        claimEvidence: [{
          kind: "content", name: "evaluation-report.json", bytes: encoder.encode("too-large"),
        }],
      }),
    );
    const configured = {
      ...deployment(fixture.spec, registration(evaluate)),
      maxClaimEvidenceBytes: 1,
      evidenceWriter: { putClaimEvidence: writer },
    } as unknown as EvaluationHarnessDeployment;

    expect(await runEvaluationHarness(fixture.paths, configured))
      .toBe(EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE);
    expect(writer).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });

  test("refuses a parser identity outside the deployment allowlist without invoking it", async () => {
    const fixture = await makeFixture();
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate), false),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });

  test("refuses spec-embedded parser code instead of executing it", async () => {
    const spec = validSpec();
    const poisoned = structuredClone(spec) as EvaluationSpec & {
      familyBlock: EvaluationSpec["familyBlock"] & {
        parser: Record<string, unknown>;
      };
    };
    poisoned.familyBlock.parser["code"] =
      "globalThis.__jinnParserInjectionExecuted = true";
    const poisonedBytes = encoder.encode(JSON.stringify(poisoned));
    const fixture = await makeFixture({
      specification: spec,
      specificationBytes: poisonedBytes,
    });
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    expect(
      (globalThis as Record<string, unknown>).__jinnParserInjectionExecuted,
    ).toBeUndefined();
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });

  test("refuses executable or external-reference fields embedded in a verdict rule", async () => {
    const spec = validSpec();
    const poisoned = structuredClone(spec) as EvaluationSpec & {
      verdictRule: Record<string, unknown>;
    };
    poisoned.verdictRule["code"] = "return process.env.SECRET";
    const fixture = await makeFixture({
      specification: spec,
      specificationBytes: encoder.encode(JSON.stringify(poisoned)),
    });
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });

  test("verifies the subject Task crosswalk instead of merely stamping the spec", async () => {
    const fixture = await makeFixture({
      subjectEvaluationDigest: `sha256:${"f".repeat(64)}`,
    });
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });

  test("refuses a canonical Delivery bound to a different subject Task", async () => {
    const fixture = await makeFixture();
    const foreignTask = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: { digest: { sha256: "a".repeat(64) } },
      instructions: "foreign task",
      outputs: [],
    });
    const foreignDelivery = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:44444444-4444-4444-8444-444444444444",
      task: documentDigest(foreignTask),
      outputs: [{
        name: "result.patch",
        mediaType: "text/x-diff",
        digest: { sha256: digestHex(await readFile(join(fixture.paths.input, "result.patch"))) },
      }],
      outcome: "fulfilled",
      createdAt: "2026-07-29T12:00:00.000Z",
    });
    await writeFile(join(fixture.paths.input, "subject-delivery.json"), foreignDelivery);
    const subjectTask = await readFile(join(fixture.paths.input, "subject-task.json"));
    const result = await readFile(join(fixture.paths.input, "result.patch"));
    const evaluationTask = deriveEvaluationTask({
      subjectTask: { name: "subject-task.json", digest: digestString(subjectTask) },
      subjectDelivery: { name: "subject-delivery.json", digest: digestString(foreignDelivery) },
      subjectResults: [{ name: "result.patch", digest: digestString(result) }],
      evaluationSpecDigest: fixture.specDigest,
    });
    await writeFile(join(fixture.paths.input, "task.sealed"), evaluationTask.bytes);
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });

  test("never invokes the adapter when the exact subject Task repeats an output name", async () => {
    const fixture = await makeFixture({
      subjectOutputs: [
        { name: "result.patch", mediaType: "text/x-diff", required: true },
        { name: "result.patch", mediaType: "text/x-diff", required: false },
      ],
    });
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>(
      async () => ({
        detailedOutcome: {},
        verdict: "pass",
        evaluatedAt: "2026-07-29T12:00:00.000Z",
        measurements: [
          { name: "passed", value: true },
          { name: "tests", value: 1 },
        ],
        claimEvidence: [{
          kind: "descriptor",
          descriptor: {
            name: "evaluation-report.json",
            digest: { sha256: "6".repeat(64) },
          },
        }],
      }),
    );

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });

  /**
   * #39b(a) -- diagnosability. The live gate's first harness run refused its subject and exited
   * 65 in 413ms with BOTH captured harness logs at 0 bytes: the refusal was caught here and
   * converted straight to an exit code, so the only artifact of a fully-diagnosed refusal was a
   * bare number. The reason has to survive the exit.
   *
   * Stderr is the channel deliberately: the backend already captures it and already tails it into
   * the terminal detail (`harnessLogTail` in the local backend's completion path), so one write
   * carries the reason all the way to the operator's audit row. Only the refusal class and its own
   * structural message go out -- never subject bytes, provider diagnostics, or secrets.
   */
  test("writes an input refusal's reason to stderr instead of exiting silently", async () => {
    const fixture = await makeFixture();
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    // The live #39 shape, reconstructed: a Delivery declaring its output by FILENAME against a
    // Task that declares the logical name. Everything else about the subject is exact, so the
    // harness reaches `verifyEvaluationSubject` and refuses there -- the very refusal whose reason
    // the live run lost.
    const subjectTaskBytes = await readFile(join(fixture.paths.input, "subject-task.json"));
    const resultBytes = await readFile(join(fixture.paths.input, "result.patch"));
    const misnamedDelivery = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:33333333-3333-4333-8333-333333333333",
      task: documentDigest(subjectTaskBytes),
      outputs: [{
        name: "result.patch.json",
        mediaType: "text/x-diff",
        digest: { sha256: digestHex(resultBytes) },
      }],
      outcome: "fulfilled",
      createdAt: "2026-07-29T12:00:00.000Z",
    });
    const evaluationTask = deriveEvaluationTask({
      subjectTask: { name: "subject-task.json", digest: digestString(subjectTaskBytes) },
      subjectDelivery: { name: "subject-delivery.json", digest: digestString(misnamedDelivery) },
      subjectResults: [{ name: "result.patch.json", digest: digestString(resultBytes) }],
      evaluationSpecDigest: fixture.specDigest,
    });
    await writeFile(join(fixture.paths.input, "subject-delivery.json"), misnamedDelivery);
    await writeFile(join(fixture.paths.input, "result.patch.json"), resultBytes);
    await writeFile(join(fixture.paths.input, "task.sealed"), evaluationTask.bytes);
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    const stderr = written.join("");
    expect(stderr).toContain("evaluation-harness: refused");
    expect(stderr).toContain("invalid-evaluation-input");
    // The structural reason itself, naming the offending output -- not just a category.
    expect(stderr).toContain(
      "subject Delivery output result.patch.json is not declared by the Task",
    );
  });

  test("writes an operational failure's class to stderr", async () => {
    const fixture = await makeFixture();
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>(
      async () => { throw new Error("adapter blew up with a secret: hunter2"); },
    );

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE);
    const stderr = written.join("");
    expect(stderr).toContain("evaluation-harness: refused");
    expect(stderr).toContain("evaluation-operational-failure");
    // An unclassified failure's message is never safe to echo.
    expect(stderr).not.toContain("hunter2");
  });

  test("rejects a CompletedEvaluation missing a spec-required measurement", async () => {
    const fixture = await makeFixture();
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>(
      async () => ({
        detailedOutcome: {},
        verdict: "pass",
        evaluatedAt: "2026-07-29T12:00:00.000Z",
        measurements: [{ name: "passed", value: true }],
      }),
    );

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE);
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });

  test("gives the exact provider-unavailable contract its typed no-verdict exit", async () => {
    const fixture = await makeFixture();
    const evaluate = vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>(
      async () => {
        throw new EvaluationOperationalError({
          canonicalCode: "UNAVAILABLE",
          reason: "provider-unavailable",
          recoveryAdvice: "new-attempt-required",
          safeDetail: "grader provider unavailable",
        });
      },
    );

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_PROVIDER_UNAVAILABLE);
    expect(evaluate).toHaveBeenCalledOnce();
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });
});

/**
 * #40 -- the admission-receipt binding. The live gate's first-ever grade (round 24, task 1232)
 * refused in 452ms with exit 65 and this on stderr:
 *
 *   evaluation-harness: refused (invalid-evaluation-input): evaluation Task does not equal the
 *   profiles derivation
 *
 * The producer (`deriveAndSealEvaluationSubmission`) extracts the receipt descriptor from the
 * subject Submission's annotation and passes it to `deriveEvaluationTask`, so the sealed Task
 * carries FOUR input descriptors. The harness re-derived from `payload` alone -- which never
 * carries the receipt -- produced the receipt-free 3-input template, and byte-compared. Every
 * other verifier (marketplace named-checks, the CP7 consumer graph) already passed the receipt;
 * the harness was the sole outlier. The byte-compare was right; its inputs were incomplete.
 */
describe("runEvaluationHarness admission-receipt binding (#40)", () => {
  function passingEvaluate() {
    return vi.fn<EvaluatorRegistration["adapter"]["evaluate"]>(async () => ({
      detailedOutcome: {},
      verdict: "pass" as const,
      evaluatedAt: "2026-07-29T12:00:00.000Z",
      measurements: [
        { name: "passed", value: true },
        { name: "tests", value: 1 },
      ],
      claimEvidence: [{
        kind: "descriptor" as const,
        descriptor: {
          name: "evaluation-report.json",
          digest: { sha256: "6".repeat(64) },
        },
      }],
    }));
  }

  function captureStderr(): string[] {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return written;
  }

  test("grades the live receipt-bearing sealed Task instead of refusing its derivation", async () => {
    const fixture = await makeFixture({ admissionReceipt: true });
    const staged = JSON.parse(
      await readFile(join(fixture.paths.input, "task.sealed"), "utf8"),
    ) as { inputs: { name: string }[] };
    // The exact live shape: four inputs, the receipt last, and its bytes staged alongside.
    expect(staged.inputs.map(({ name }) => name)).toEqual([
      "subject-task.json",
      "subject-delivery.json",
      "result.patch",
      "admission-receipt",
    ]);
    const written = captureStderr();
    const evaluate = passingEvaluate();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(written.join("")).not.toContain(
      "evaluation Task does not equal the profiles derivation",
    );
    expect(exitCode).toBe(0);
    expect(evaluate).toHaveBeenCalledOnce();
    await expect(readFile(join(fixture.paths.out, "verdict"))).resolves.toBeDefined();
  });

  test("still grades the receipt-free sealed Task the venue producers emit", async () => {
    const fixture = await makeFixture();
    const staged = JSON.parse(
      await readFile(join(fixture.paths.input, "task.sealed"), "utf8"),
    ) as { inputs: { name: string }[] };
    expect(staged.inputs).toHaveLength(3);
    const evaluate = passingEvaluate();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(0);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  /**
   * The reason the receipt is read positionally rather than by name search: a Delivery output may
   * legitimately be named `admission-receipt`, and a name search would mistake that subject Result
   * for the receipt and refuse a Task that verifies today.
   */
  test("does not mistake a subject Result named admission-receipt for the receipt", async () => {
    const fixture = await makeFixture({
      subjectOutputs: [{
        name: "admission-receipt",
        mediaType: "text/x-diff",
        required: true,
      }],
    });
    const resultBytes = await readFile(join(fixture.paths.input, "result.patch"));
    const subjectTaskBytes = await readFile(join(fixture.paths.input, "subject-task.json"));
    const deliveryBytes = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt: "urn:uuid:33333333-3333-4333-8333-333333333333",
      task: documentDigest(subjectTaskBytes),
      outputs: [{
        name: "admission-receipt",
        mediaType: "text/x-diff",
        digest: { sha256: digestHex(resultBytes) },
      }],
      outcome: "fulfilled",
      createdAt: "2026-07-29T12:00:00.000Z",
    });
    const evaluationTask = deriveEvaluationTask({
      subjectTask: { name: "subject-task.json", digest: digestString(subjectTaskBytes) },
      subjectDelivery: { name: "subject-delivery.json", digest: digestString(deliveryBytes) },
      subjectResults: [{ name: "admission-receipt", digest: digestString(resultBytes) }],
      evaluationSpecDigest: fixture.specDigest,
    });
    await Promise.all([
      writeFile(join(fixture.paths.input, "subject-delivery.json"), deliveryBytes),
      writeFile(join(fixture.paths.input, "admission-receipt"), resultBytes),
      writeFile(join(fixture.paths.input, "task.sealed"), evaluationTask.bytes),
    ]);
    const evaluate = passingEvaluate();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(0);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  test("refuses when the declared receipt descriptor does not pin the staged bytes", async () => {
    const fixture = await makeFixture({ admissionReceipt: true });
    // Canonical by construction, so the derivation byte-compare PASSES and the refusal can only
    // come from the staged-material digest check.
    const tampered = deriveEvaluationTask({
      subjectTask: fixture.subjectTaskRef,
      subjectDelivery: fixture.subjectDeliveryRef,
      subjectResults: [...fixture.subjectResultRefs],
      evaluationSpecDigest: fixture.specDigest,
      admissionReceipt: {
        ...fixture.admissionReceiptDescriptor,
        digest: { sha256: "7".repeat(64) },
      },
    });
    await writeFile(join(fixture.paths.input, "task.sealed"), tampered.bytes);
    const written = captureStderr();
    const evaluate = passingEvaluate();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    expect(written.join("")).toContain(
      "verified input material admission-receipt no longer matches its digest",
    );
    await expect(readFile(join(fixture.paths.out, "verdict"))).rejects.toThrow();
  });

  test("refuses when the sealed Task declares a receipt whose bytes are not staged", async () => {
    const fixture = await makeFixture({ admissionReceipt: true });
    await rm(join(fixture.paths.input, "admission-receipt"));
    const written = captureStderr();
    const evaluate = passingEvaluate();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    expect(written.join("")).toContain(
      "verified input material admission-receipt is unavailable",
    );
  });

  test("refuses a fourth input that is not the admission receipt", async () => {
    const fixture = await makeFixture();
    await restageTaskInputs(fixture, (inputs) => [
      ...inputs,
      { name: "smuggled-input", digest: { sha256: "8".repeat(64) } },
    ]);
    const written = captureStderr();
    const evaluate = passingEvaluate();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    expect(written.join("")).toContain(
      'evaluation Task input after its subject artifacts must be named "admission-receipt"',
    );
  });

  test("refuses inputs that cannot be the derivation of its bound subject artifacts", async () => {
    const fixture = await makeFixture({ admissionReceipt: true });
    await restageTaskInputs(fixture, (inputs) => [...inputs, ...inputs]);
    const written = captureStderr();
    const evaluate = passingEvaluate();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    expect(written.join("")).toContain(
      "evaluation Task inputs do not match its bound subject artifacts",
    );
  });

  test("classifies an underivable receipt descriptor as invalid input, not an operational failure", async () => {
    const fixture = await makeFixture({ admissionReceipt: true });
    // No uri/digest/content: the profiles ResourceDescriptor schema refuses it outright, so the
    // re-derivation cannot even be attempted. That is invalid input (65), never exit 70.
    await restageTaskInputs(fixture, (inputs) => [
      ...inputs.slice(0, 3),
      { name: "admission-receipt", mediaType: ADMISSION_RECEIPT_MEDIA_TYPE },
    ]);
    const written = captureStderr();
    const evaluate = passingEvaluate();

    const exitCode = await runEvaluationHarness(
      fixture.paths,
      deployment(fixture.spec, registration(evaluate)),
    );

    expect(exitCode).toBe(EVALUATION_HARNESS_EXIT_INVALID_INPUT);
    expect(evaluate).not.toHaveBeenCalled();
    expect(written.join("")).toContain(
      "evaluation Task bindings are not a derivable profiles input",
    );
  });
});
