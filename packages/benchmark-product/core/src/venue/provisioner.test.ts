import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes, parseDsseEnvelope, type DsseSigner } from "@jinn-network/trust-core";
import { EVALUATION_TASK_PROFILE_URI } from "@jinn-network/task-execution-profiles";
import type { LocalProvisionerInput } from "@jinn-network/task-execution-backend-local";
import type { DeclaredOutputSlot, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { sha256Hex } from "../workspace/sealed-store.js";
import {
  createEvaluationCellRegistry,
  createLocalProvisioner,
  EVALUATOR_REQUIREMENT_KEY,
  type EvaluationCellMaterials,
  type EvaluationCellRegistry,
} from "./provisioner.js";
import { readVerdictEnvelope } from "./signing.js";

const EVALUATOR_1 = "urn:jinn:benchmark-product:local-venue:evaluator-1";
const EVALUATOR_2 = "urn:jinn:benchmark-product:local-venue:evaluator-2";

const VERDICT_OUTPUT: readonly DeclaredOutputSlot[] = [
  { name: "verdict", mediaType: "application/vnd.in-toto+json", required: true },
];

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fakeSigner(keyid: string): DsseSigner {
  return async () => [{ keyid, signature: new Uint8Array([1, 2, 3]) }];
}

function workspacePathsUnder(root: string): WorkspacePaths {
  return {
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
}

const SEALED_TASK_BYTES = encode(JSON.stringify({ profile: { uri: EVALUATION_TASK_PROFILE_URI } }));
const EVALUATION_SPEC_BYTES = encode(JSON.stringify({ family: "deterministic-process" }));

function registeredMaterials(registry: EvaluationCellRegistry): EvaluationCellMaterials {
  const materials: EvaluationCellMaterials = {
    subjectTaskBytes: encode("subject-task"),
    subjectDeliveryBytes: encode("subject-delivery"),
    resultArtifacts: [{ name: "prediction", bytes: encode("result") }],
    evaluationSpecBytes: EVALUATION_SPEC_BYTES,
    evaluationContextBytes: encode(JSON.stringify({ outcome: "yes" })),
  };
  registry.register(sha256Hex(SEALED_TASK_BYTES), materials);
  return materials;
}

function evaluationInput(requirements: Record<string, unknown> | undefined): LocalProvisionerInput {
  return {
    sealedTaskBytes: SEALED_TASK_BYTES,
    dispatchContextBytes: encode("{}"),
    task: { profile: { uri: EVALUATION_TASK_PROFILE_URI } } as LocalProvisionerInput["task"],
    submission: (requirements === undefined
      ? {}
      : { requirements }) as LocalProvisionerInput["submission"],
    attempt: {
      attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000001",
      nonce: "provisioner-test",
      attemptNumber: 1,
    } as LocalProvisionerInput["attempt"],
  };
}

function verdictStatementBytes(evaluatorId: string): Uint8Array {
  return canonicalJsonBytes({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "subject-task.json", digest: { sha256: "c".repeat(64) } }],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: evaluatorId },
      evaluationSpecification: {
        name: "evaluation-spec.json",
        digest: { sha256: sha256Hex(EVALUATION_SPEC_BYTES) },
      },
      taskSubject: "subject-task.json",
      resultSubjects: ["prediction"],
      verdict: "pass",
      measurements: [{ name: "integrity", value: true }],
      evaluatedAt: "2026-08-06T00:00:00.000Z",
    },
  });
}

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "bp21-provisioner-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("createLocalProvisioner evaluator selection", () => {
  it("fails loud at setup when the evaluation Submission carries no evaluator requirement", async () => {
    const registry = createEvaluationCellRegistry();
    registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [{ id: EVALUATOR_1, signer: fakeSigner("key-1") }],
    });
    const selected = selector(evaluationInput(undefined));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await expect(selected.contract.setup(undefined as never, paths, []))
      .rejects.toThrow(EVALUATOR_REQUIREMENT_KEY);
  });

  it("fails loud at setup when the named evaluator is not one of the venue's", async () => {
    const registry = createEvaluationCellRegistry();
    registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [{ id: EVALUATOR_1, signer: fakeSigner("key-1") }],
    });
    const selected = selector(evaluationInput({ [EVALUATOR_REQUIREMENT_KEY]: EVALUATOR_2 }));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await expect(selected.contract.setup(undefined as never, paths, []))
      .rejects.toThrow(EVALUATOR_2);
  });

  it("seals the harvested verdict with the SELECTED evaluator's id and signer", async () => {
    const registry = createEvaluationCellRegistry();
    const materials = registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [
        { id: EVALUATOR_1, signer: fakeSigner("key-1") },
        { id: EVALUATOR_2, signer: fakeSigner("key-2") },
      ],
    });
    const selected = selector(evaluationInput({ [EVALUATOR_REQUIREMENT_KEY]: EVALUATOR_2 }));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await selected.contract.setup(undefined as never, paths, []);

    // Without the test-only variation hook, the registered context bytes land verbatim.
    expect(new Uint8Array(readFileSync(join(paths.input, "evaluation-context.json"))))
      .toEqual(materials.evaluationContextBytes);

    writeFileSync(join(paths.out, "verdict"), verdictStatementBytes(EVALUATOR_2));
    const harvested = await selected.contract.harvest(paths, VERDICT_OUTPUT);
    expect(harvested.manifest.map((entry) => entry.path)).toEqual(["verdict"]);

    const envelopeBytes = new Uint8Array(readFileSync(join(paths.out, "verdict")));
    expect(parseDsseEnvelope(envelopeBytes).signatures[0]?.keyid).toBe("key-2");
    expect(readVerdictEnvelope(envelopeBytes).evaluatorId).toBe(EVALUATOR_2);
  });

  it("refuses at harvest a statement claiming a DIFFERENT evaluator than the attempt ran under", async () => {
    const registry = createEvaluationCellRegistry();
    registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [
        { id: EVALUATOR_1, signer: fakeSigner("key-1") },
        { id: EVALUATOR_2, signer: fakeSigner("key-2") },
      ],
    });
    const selected = selector(evaluationInput({ [EVALUATOR_REQUIREMENT_KEY]: EVALUATOR_1 }));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await selected.contract.setup(undefined as never, paths, []);

    writeFileSync(join(paths.out, "verdict"), verdictStatementBytes(EVALUATOR_2));
    await expect(selected.contract.harvest(paths, VERDICT_OUTPUT)).rejects.toThrow();
  });

  it("applies the test-only context-variation hook for the selected evaluator", async () => {
    const registry = createEvaluationCellRegistry();
    registeredMaterials(registry);
    const selector = createLocalProvisioner({
      registry,
      evaluators: [
        { id: EVALUATOR_1, signer: fakeSigner("key-1") },
        { id: EVALUATOR_2, signer: fakeSigner("key-2") },
      ],
      evaluationContextVariationForTesting: (evaluatorId, contextBytes) =>
        encode(JSON.stringify({ evaluatorId, original: sha256Hex(contextBytes) })),
    });
    const selected = selector(evaluationInput({ [EVALUATOR_REQUIREMENT_KEY]: EVALUATOR_2 }));
    const paths = workspacePathsUnder(join(workspaceRoot, "attempt"));
    await selected.contract.setup(undefined as never, paths, []);

    const written = JSON.parse(readFileSync(join(paths.input, "evaluation-context.json"), "utf8")) as {
      readonly evaluatorId: string;
    };
    expect(written.evaluatorId).toBe(EVALUATOR_2);
  });
});
