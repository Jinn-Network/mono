import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SWE_REBENCH_PARSER } from "@jinn-network/task-execution-evaluator-adapters";
import {
  canonicalJsonBytes,
  graderProgramDigest,
} from "@jinn-network/task-execution-oci-grader";
import {
  parseEvaluationSpec,
  type DeterministicProcessBlock,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  TASK_EXECUTION_PROTOCOL_URI,
} from "@jinn-network/task-execution-protocol";
import { parseDsseEnvelope } from "@jinn-network/trust-core";
import { convertSweBenchRows } from "../intake/swebench.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import {
  createLocalVenue,
  EVALUATION_HARNESS_PIN,
  EVALUATOR_REQUIREMENT_KEY,
} from "./venue.js";
import { readVerdictEnvelope } from "./signing.js";

const NOW = () => "2026-08-12T00:00:00.000Z";
const FAR_FUTURE_DEADLINE = "2099-01-01T00:00:00.000Z";
const IMAGE_DIGEST = "a".repeat(64);
const IMAGE = `registry.example.invalid/jinn/swe-rebench@sha256:${IMAGE_DIGEST}`;
const FAIL_TO_PASS = "tests/test_widget.py::test_fixed";

function submissionFor(taskSha256: string, evaluatorId: string): Uint8Array {
  return sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: `urn:uuid:${randomUUID()}`,
    task: { digest: { sha256: taskSha256 } },
    requester: `urn:uuid:${randomUUID()}`,
    idempotencyKey: randomUUID(),
    nonce: randomUUID(),
    deadline: FAR_FUTURE_DEADLINE,
    requirements: {
      harness: EVALUATION_HARNESS_PIN,
      [EVALUATOR_REQUIREMENT_KEY]: evaluatorId,
    },
  });
}

function sealedRowMaterial(): { readonly bytes: Uint8Array; readonly descriptor: Record<string, unknown> } {
  const bytes = canonicalJsonBytes({
    FAIL_TO_PASS: [FAIL_TO_PASS],
    PASS_TO_PASS: ["tests/test_widget.py::test_existing"],
    base_commit: "b".repeat(40),
    install_config: {
      install: ["python -m pip install -e ."],
      log_parser: "parse_log_pytest",
      test_cmd: ["pytest -q"],
    },
    instance_id: "acme__widget-1",
    test_patch: "diff --git a/tests/test_widget.py b/tests/test_widget.py\n",
  });
  return {
    bytes,
    descriptor: {
      name: "swe-rebench-evaluation-row",
      mediaType: "application/json",
      content: Buffer.from(bytes).toString("base64"),
      digest: { sha256: sha256Hex(bytes) },
    },
  };
}

function gradingFixture() {
  const material = sealedRowMaterial();
  const converted = convertSweBenchRows([{
    instance_id: "acme__widget-1",
    repo: "acme/widget",
    base_commit: "b".repeat(40),
    problem_statement: "Fix the widget.",
    language: "python",
    image: {
      name: "swe-rebench-image",
      uri: `docker://${IMAGE}`,
      digest: { sha256: IMAGE_DIGEST },
    },
    testMaterial: [material.descriptor],
    parser: SWE_REBENCH_PARSER,
    transitions: {
      failToPass: [FAIL_TO_PASS],
      passToPass: ["tests/test_widget.py::test_existing"],
    },
    timeout: 60,
  }], {
    name: "P3b product grader",
    description: "Injected-runtime integration fixture",
    version: "1.0.0",
  });
  const task = converted.imported.tasks[0]!;
  const evaluationSpec = converted.evaluationSpecs[0]!;
  const patchBytes = new TextEncoder().encode("diff --git a/widget.py b/widget.py\n");
  const deliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: `urn:uuid:${randomUUID()}`,
    task: documentDigest(task.bytes),
    outputs: [{
      name: "patch",
      mediaType: "text/x-diff",
      digest: { sha256: sha256Hex(patchBytes) },
    }],
    outcome: "fulfilled",
    createdAt: NOW(),
  });
  return { deliveryBytes, evaluationSpec, material, patchBytes, task };
}

async function writeFakeRuntime(
  root: string,
  options: { readonly imageDisappearsAfterFirstInspect?: boolean } = {},
): Promise<{ readonly path: string; readonly log: string }> {
  const path = join(root, "fake-oci-runtime.mjs");
  const log = join(root, "fake-oci-runtime.ndjson");
  const emittedVerdict = JSON.stringify({
    log: "1 passed",
    report: {
      error: "",
      exit_code: 0,
      failed_from_pass_to_pass: [],
      from_fail_to_pass: [FAIL_TO_PASS],
      instance_id: "acme__widget-1",
    },
  });
  await writeFile(path, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
let priorCalls = [];
try {
  priorCalls = readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
} catch {}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "image" && args[1] === "inspect") {
  const priorInspects = priorCalls.filter((call) => call[0] === "image" && call[1] === "inspect").length;
  process.exit(${options.imageDisappearsAfterFirstInspect === true ? "priorInspects === 0 ? 0 : 1" : "0"});
}
if (args[0] !== "run") process.exit(2);
const outputMount = args.find((entry) => entry.startsWith("type=bind,src=") && entry.endsWith(",dst=/jinn/out"));
if (outputMount === undefined) process.exit(3);
const output = outputMount.slice("type=bind,src=".length, -",dst=/jinn/out".length);
writeFileSync(join(output, "verdict"), ${JSON.stringify(emittedVerdict)});
`, { mode: 0o700 });
  await chmod(path, 0o700);
  return { path, log };
}

describe("SWE-rebench grading on the product local venue", () => {
  it("requires both a sealed network declaration and an explicit host grant before pre-staging", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "p3b-product-grader-network-"));
    const runtime = await writeFakeRuntime(workspaceDir);
    const venue = createLocalVenue({
      workspaceDir,
      now: NOW,
      sweRebenchGrader: { dockerPath: runtime.path },
    });
    try {
      const material = sealedRowMaterial();
      const converted = convertSweBenchRows([{
        instance_id: "acme__widget-1",
        repo: "acme/widget",
        base_commit: "b".repeat(40),
        problem_statement: "Fix the widget.",
        language: "python",
        image: {
          name: "swe-rebench-image",
          uri: `docker://${IMAGE}`,
          digest: { sha256: IMAGE_DIGEST },
        },
        testMaterial: [material.descriptor],
        parser: SWE_REBENCH_PARSER,
        transitions: { failToPass: [FAIL_TO_PASS], passToPass: [] },
        timeout: 60,
      }], { name: "P3b network gate", description: "Network refusal fixture", version: "1.0.0" });
      const task = converted.imported.tasks[0]!;
      const specDocument = parseEvaluationSpec(converted.evaluationSpecs[0]!.bytes) as unknown as {
        familyBlock: Record<string, unknown>;
      };
      specDocument.familyBlock["network.jinn.oci-grader.requires-public-network"] = true;
      const specBytes = canonicalJsonBytes(specDocument);
      const taskDocument = JSON.parse(new TextDecoder().decode(task.bytes)) as {
        evaluation: { digest: { sha256: string } };
      } & Record<string, unknown>;
      taskDocument.evaluation.digest.sha256 = sha256Hex(specBytes);
      const taskBytes = canonicalJsonBytes(taskDocument);
      const patchBytes = new TextEncoder().encode("diff --git a/widget.py b/widget.py\n");
      const deliveryBytes = sealDelivery({
        protocol: TASK_EXECUTION_PROTOCOL_URI,
        attempt: `urn:uuid:${randomUUID()}`,
        task: documentDigest(taskBytes),
        outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: sha256Hex(patchBytes) } }],
        outcome: "fulfilled",
        createdAt: NOW(),
      });

      await expect(venue.prepareEvaluationCell({
        subjectTaskBytes: taskBytes,
        subjectDeliveryBytes: deliveryBytes,
        resultArtifacts: [{ name: "patch", bytes: patchBytes }],
        evaluationSpecBytes: specBytes,
      })).rejects.toThrow(/explicit host allowPublicNetwork opt-in/u);
      await expect(readFile(runtime.log, "utf8")).rejects.toThrow();
    } finally {
      await venue.shutdown();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("pre-stages the sealed image and emits a real OCI-grader verdict with pull and network disabled", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "p3b-product-grader-"));
    const runtime = await writeFakeRuntime(workspaceDir);
    const venue = createLocalVenue({
      workspaceDir,
      now: NOW,
      sweRebenchGrader: { dockerPath: runtime.path },
    });
    const deploymentSource = await readFile(join(workspaceDir, "venue", "evaluation-deployment.mjs"), "utf8");
    expect(deploymentSource).toContain(runtime.path);
    expect(deploymentSource).toContain('imagePullPolicy: "never"');
    try {
      const { deliveryBytes, evaluationSpec, material, patchBytes, task } = gradingFixture();

      const prepared = await venue.prepareEvaluationCell({
        subjectTaskBytes: task.bytes,
        subjectDeliveryBytes: deliveryBytes,
        resultArtifacts: [{ name: "patch", bytes: patchBytes }],
        evaluationSpecBytes: evaluationSpec.bytes,
      });

      // Pre-staging is a parent-side operation and completes before any evaluation Submission.
      const preDispatchCalls = (await readFile(runtime.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(preDispatchCalls).toEqual([["image", "inspect", IMAGE]]);

      const submission = submissionFor(prepared.taskSha256, venue.evaluators[0]!.id);
      const ack = await venue.backend.submit(prepared.taskBytes, submission);
      expect(ack.accepted, JSON.stringify(ack)).toBe(true);
      if (!ack.accepted) throw new Error("unreachable");
      await venue.backend.drain();

      const snapshot = await venue.backend.observe(ack.submission);
      const runtimeCallsAfterDispatch = await readFile(runtime.log, "utf8");
      expect(
        snapshot.descriptor.derived,
        `${JSON.stringify(snapshot.observations)}\nRuntime calls:\n${runtimeCallsAfterDispatch}`,
      ).toMatchObject({
        state: "delivered",
        terminal: true,
      });
      const deliveries = await venue.backend.deliveries(snapshot.descriptor.attempt);
      const verdictDeliveryBytes = await venue.backend.fetchDelivery(deliveries[0]!);
      const verdictDelivery = JSON.parse(new TextDecoder().decode(verdictDeliveryBytes)) as {
        readonly outputs: readonly { readonly digest: { readonly sha256: string } }[];
      };
      const envelopeBytes = await venue.backend.fetchArtifact({
        digest: { sha256: verdictDelivery.outputs[0]!.digest.sha256 },
      });
      const view = readVerdictEnvelope(envelopeBytes);
      expect(view.verdict).toBe("pass");
      expect(view.evaluationSpecificationSha256).toBe(evaluationSpec.digest);

      const statement = JSON.parse(new TextDecoder().decode(parseDsseEnvelope(envelopeBytes).payloadBytes)) as {
        readonly predicate: {
          readonly evidence: readonly {
            readonly digest: { readonly sha256: string };
            readonly uri: string;
          }[];
          readonly evaluationMethod: { readonly digest: { readonly sha256: string } };
          readonly evaluationSpecification: { readonly digest: { readonly sha256: string } };
        };
      };
      expect(`sha256:${statement.predicate.evaluationMethod.digest.sha256}`).toBe(graderProgramDigest());
      expect(statement.predicate.evaluationSpecification.digest.sha256).toBe(evaluationSpec.digest);
      expect(statement.predicate.evidence).toEqual([expect.objectContaining({
        digest: { sha256: sha256Hex(new TextEncoder().encode("1 passed")) },
        uri: "data:text/plain; charset=utf-8;base64,MSBwYXNzZWQ=",
      })]);

      // The referenced sealed EvalSpec carries the other method-defining inputs byte-for-byte.
      const parsedSpec = parseEvaluationSpec(evaluationSpec.bytes);
      const block = parsedSpec.familyBlock as DeterministicProcessBlock;
      expect(block.image).toMatchObject({
        uri: `docker://${IMAGE}`,
        digest: { sha256: IMAGE_DIGEST },
      });
      expect(block.testMaterial).toContainEqual(expect.objectContaining(material.descriptor));
      expect(block.parser).toEqual(SWE_REBENCH_PARSER);
      expect(block.timeout).toBe(60);

      const calls = (await readFile(runtime.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls.filter((args) => args[0] === "image" && args[1] === "inspect")).toHaveLength(2);
      expect(calls.filter((args) => args[0] === "pull")).toHaveLength(0);
      const run = calls.find((args) => args[0] === "run");
      expect(run).toBeDefined();
      expect(run).toEqual(expect.arrayContaining(["--pull", "never", "--network", "none", IMAGE]));
    } finally {
      await venue.shutdown();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses the swe-rebench evaluator when the run is locked to apex-swe-dev", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "apex-swe-dev-refuses-swe-rebench-"));
    const venue = createLocalVenue({
      workspaceDir,
      now: NOW,
      evaluationRuntime: { adapterId: "apex-swe-dev", selectionManifestSha256: "a".repeat(64) },
    });
    try {
      const { deliveryBytes, evaluationSpec, patchBytes, task } = gradingFixture();
      await expect(venue.prepareEvaluationCell({
        subjectTaskBytes: task.bytes,
        subjectDeliveryBytes: deliveryBytes,
        resultArtifacts: [{ name: "patch", bytes: patchBytes }],
        evaluationSpecBytes: evaluationSpec.bytes,
      })).rejects.toThrow(/APEX-SWE-dev official suite refuses the swe-rebench evaluator/u);
    } finally {
      await venue.shutdown();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("accounts an image lost after parent pre-stage without granting the child pull authority", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "p3b-product-grader-lost-image-"));
    const runtime = await writeFakeRuntime(workspaceDir, { imageDisappearsAfterFirstInspect: true });
    const venue = createLocalVenue({
      workspaceDir,
      now: NOW,
      sweRebenchGrader: { dockerPath: runtime.path },
    });
    try {
      const { deliveryBytes, evaluationSpec, patchBytes, task } = gradingFixture();
      const prepared = await venue.prepareEvaluationCell({
        subjectTaskBytes: task.bytes,
        subjectDeliveryBytes: deliveryBytes,
        resultArtifacts: [{ name: "patch", bytes: patchBytes }],
        evaluationSpecBytes: evaluationSpec.bytes,
      });

      // The parent sees the digest locally and completes pre-stage before dispatch.
      const preDispatchCalls = (await readFile(runtime.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(preDispatchCalls).toEqual([["image", "inspect", IMAGE]]);

      const ack = await venue.backend.submit(
        prepared.taskBytes,
        submissionFor(prepared.taskSha256, venue.evaluators[0]!.id),
      );
      expect(ack.accepted, JSON.stringify(ack)).toBe(true);
      if (!ack.accepted) throw new Error("unreachable");
      await venue.backend.drain();

      // The child re-inspection now misses. The evaluator exits as an accounted operational
      // failure; it never runs the grader and, critically, never attempts a registry pull.
      const snapshot = await venue.backend.observe(ack.submission);
      expect(snapshot.descriptor.derived, JSON.stringify(snapshot.observations)).toMatchObject({
        state: "failed",
        terminal: true,
      });
      const calls = (await readFile(runtime.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls).toEqual([
        ["image", "inspect", IMAGE],
        ["image", "inspect", IMAGE],
      ]);
      expect(calls.some((args) => args[0] === "pull")).toBe(false);
      expect(calls.some((args) => args[0] === "run")).toBe(false);
    } finally {
      await venue.shutdown();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }, 60_000);
});
