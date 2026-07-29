// SPDX-License-Identifier: Apache-2.0

import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-discovery";
import { validateResultEvaluation } from "@jinn-network/evidence-protocol";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
} from "@jinn-network/task-execution-backend-local";
import {
  buildEvaluationTaskProfile,
  deriveEvaluationTask,
  EVALUATION_SPEC_FORMAT_URI,
  parserAllowlistKey,
  sealEvaluationSpec,
  sealTaskProfile,
  type DeterministicProcessBlock,
  type EvaluationSpec,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import type { CapabilityGrant } from "@jinn-network/task-execution-workspace";
import {
  harvest,
  type ProvisionerContract,
  type TaskView,
  type WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  evaluationLauncher,
  makeEvaluationLauncher,
} from "./launcher.js";
import {
  defineEvaluatorRegistration,
  type EvaluatorRegistration,
} from "./registration.js";

const roots: string[] = [];
const backends: LocalTaskExecutionBackend[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const execFileAsync = promisify(execFile);
const compiledHarnessEntrypoint = fileURLToPath(
  new URL("../dist/bin.js", import.meta.url),
);
const evaluationProfile = buildEvaluationTaskProfile();
const sealedEvaluationProfile = sealTaskProfile(evaluationProfile);
const profileStore: ProfileStore = {
  get(digest) {
    return digest === sealedEvaluationProfile.digest
      ? evaluationProfile
      : undefined;
  },
};

beforeAll(async () => {
  // The public launcher spawns the packaged JavaScript entrypoint. Compile that entrypoint before
  // this integration suite because package CI intentionally runs tests before its final build.
  await execFileAsync(process.execPath, [
    fileURLToPath(
      new URL("../node_modules/typescript/bin/tsc", import.meta.url),
    ),
    "-p",
    fileURLToPath(new URL("../tsconfig.build.json", import.meta.url)),
  ]);
});

afterEach(async () => {
  for (const backend of backends.splice(0)) backend.close();
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function specification(): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: "4",
    family: "deterministic-process",
    grader: {
      name: "control-grader",
      digest: { sha256: "1".repeat(64) },
      accessClass: "private",
    },
    familyBlock: {
      image: {
        name: "control-image",
        digest: { sha256: "2".repeat(64) },
      },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [],
      parser: {
        id: "jinn.parser.launcher-integration",
        version: "1.0.0",
        digest: `sha256:${"3".repeat(64)}`,
      },
      transitions: { failToPass: [], passToPass: [] },
      timeout: 30,
    },
    measurements: [
      { name: "passed", type: "boolean", required: true },
    ],
    verdictRule: {
      threshold: { measurement: "passed", op: "eq", value: true },
    },
    unscorable: [],
    evidenceConventions: { requiredRefs: [] },
  };
}

interface Documents {
  readonly evaluationTask: Uint8Array;
  readonly subjectTask: Uint8Array;
  readonly subjectDelivery: Uint8Array;
  readonly subjectResult: Uint8Array;
  readonly specification: EvaluationSpec;
  readonly specificationBytes: Uint8Array;
  readonly submission: Uint8Array;
}

function documents(): Documents {
  const spec = specification();
  const sealedSpecification = sealEvaluationSpec(spec);
  const subjectTask = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: "https://jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "4".repeat(64) },
    },
    instructions: "Produce the subject result.",
    outputs: [{
      name: "result.patch",
      mediaType: "text/x-diff",
      required: true,
    }],
    evaluation: {
      name: "evaluation-spec.json",
      digest: {
        sha256: sealedSpecification.digest.slice("sha256:".length),
      },
    },
  });
  const subjectResult = encoder.encode("diff --git a/control b/control\n");
  const subjectDelivery = sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt: "urn:uuid:11111111-1111-4111-8111-111111111111",
    task: documentDigest(subjectTask),
    outputs: [{
      name: "result.patch",
      mediaType: "text/x-diff",
      digest: { sha256: sha256(subjectResult).slice("sha256:".length) },
    }],
    outcome: "fulfilled",
    createdAt: "2026-07-29T12:00:00.000Z",
  });
  const evaluationTask = deriveEvaluationTask({
    subjectTask: {
      name: "subject-task.json",
      digest: sha256(subjectTask),
    },
    subjectDelivery: {
      name: "subject-delivery.json",
      digest: sha256(subjectDelivery),
    },
    subjectResults: [{
      name: "result.patch",
      digest: sha256(subjectResult),
    }],
    evaluationSpecDigest: sealedSpecification.digest,
  }).bytes;
  const submission = sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: `urn:uuid:${crypto.randomUUID()}`,
    task: {
      digest: {
        sha256: documentDigest(evaluationTask).slice("sha256:".length),
      },
    },
    requester: "urn:uuid:22222222-2222-4222-8222-222222222222",
    idempotencyKey: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    deadline: "2099-01-01T00:00:00.000Z",
    capabilityGrants: {
      "evaluator-agent-key": {
        reference: "test:evaluator-agent-key",
      },
    },
    requirements: {
      harness: {
        id: "evaluation-harness",
        version: "0.1.0",
      },
    },
  });
  return {
    evaluationTask,
    subjectTask,
    subjectDelivery,
    subjectResult,
    specification: spec,
    specificationBytes: sealedSpecification.bytes,
    submission,
  };
}

function evaluatorRegistration(): EvaluatorRegistration {
  return defineEvaluatorRegistration({
    registrationId: "launcher-integration-evaluator",
    adapter: {
      async evaluate() {
        return {
          detailedOutcome: { integration: true },
          verdict: "pass",
          evaluatedAt: "2026-07-29T12:01:00.000Z",
          measurements: [{ name: "passed", value: true }],
        };
      },
    },
    evaluationMethod: {
      name: "evaluation-harness-launcher-integration",
      digest: { sha256: "6".repeat(64) },
      uri: "https://jinn.network/software/evaluation-harness/integration-v1",
    },
    specificationCompatibility: (value) =>
      value.family === "deterministic-process",
    evaluatorIdentity: {
      id: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
    },
    signer: { handle: "evaluator-agent-key.pem" },
    outcomeValidator: (value) => value,
    interruptionBehavior: "repeatable",
  });
}

interface BackendFixture {
  readonly backend: LocalTaskExecutionBackend;
  readonly pathsByAttempt: Map<string, WorkspacePaths>;
}

async function backendFixture(
  root: string,
  docs: Documents,
  privateKeyText: string,
  options: {
    readonly crashAfterDeliveryCheckpoint?: () => void;
  } = {},
): Promise<BackendFixture> {
  const pathsByAttempt = new Map<string, WorkspacePaths>();
  const registration = evaluatorRegistration();
  const deploymentModule = join(root, "evaluation-deployment.mjs");
  await writeFile(
    deploymentModule,
    `
export const evaluationHarnessDeployment = {
  registrations: [{
    registrationId: "launcher-integration-evaluator",
    adapter: {
      async evaluate() {
        return {
          detailedOutcome: { integration: true },
          verdict: "pass",
          evaluatedAt: "2026-07-29T12:01:00.000Z",
          measurements: [{ name: "passed", value: true }],
        };
      },
    },
    evaluationMethod: {
      name: "evaluation-harness-launcher-integration",
      digest: { sha256: "${"6".repeat(64)}" },
      uri: "https://jinn.network/software/evaluation-harness/integration-v1",
    },
    specificationCompatibility(value) {
      return value.family === "deterministic-process";
    },
    evaluatorIdentity: {
      id: "did:key:z6MkhzYwRj8TvZEp41ApnVVDN5a5hBCk8tQYp4w7vGkVn5F8",
    },
    signer: { handle: "evaluator-agent-key.pem" },
    outcomeValidator(value) { return value; },
    interruptionBehavior: "repeatable",
  }],
  parserAllowlist: new Set([
    ${JSON.stringify(parserAllowlistKey(
      (docs.specification.familyBlock as DeterministicProcessBlock).parser,
    ))},
  ]),
  maxClaimEvidenceBytes: 1024,
  evidenceWriter: {
    async putClaimEvidence() {
      throw new TypeError("launcher integration produces no new claim evidence");
    },
  },
};
`,
  );
  const launcher = makeEvaluationLauncher({
    deploymentModule: pathToFileURL(deploymentModule).href,
    entrypoint: compiledHarnessEntrypoint,
    interruptionBehavior: registration.interruptionBehavior,
  });
  const repository = new InMemoryEvidenceRepository();
  const backend = makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "https://jinn.network/software/backend-local/evaluation-test",
    executor: "https://jinn.network/software/evaluation-harness",
    profileStore,
    launchers: [launcher],
    provisioner(input) {
      const provisioner: ProvisionerContract = {
        workspaceKind: () => "dir",
        async setup(_view, paths, grants) {
          pathsByAttempt.set(input.attempt.attemptUri, paths);
          await Promise.all(
            Object.values(paths).map((path) =>
              mkdir(path, { recursive: true })
            ),
          );
          expect(grants).toEqual([{
            key: "evaluator-agent-key",
            descriptor: { reference: "test:evaluator-agent-key" },
          }]);
          await Promise.all([
            writeFile(join(paths.input, "task.sealed"), input.sealedTaskBytes),
            writeFile(
              join(paths.input, "dispatch-context.json"),
              input.dispatchContextBytes,
            ),
            writeFile(
              join(paths.input, "subject-task.json"),
              docs.subjectTask,
            ),
            writeFile(
              join(paths.input, "subject-delivery.json"),
              docs.subjectDelivery,
            ),
            writeFile(join(paths.input, "result.patch"), docs.subjectResult),
            writeFile(
              join(paths.input, "evaluation-spec.json"),
              docs.specificationBytes,
            ),
            writeFile(
              join(paths.input, "evaluation-context.json"),
              '{"source":"launcher-integration"}',
            ),
            // Test host resolution: the Submission carried only the opaque reference above.
            writeFile(
              join(paths.secrets, registration.signer.handle),
              privateKeyText,
              { mode: 0o600 },
            ),
          ]);
        },
        executionEnv: ({ env }) => ({ ...env }),
        async harvest(paths, outputs) {
          const result = await harvest(paths, outputs);
          await Promise.all([
            rm(paths.secrets, { recursive: true, force: true }),
            rm(paths.tmp, { recursive: true, force: true }),
          ]);
          return result;
        },
      };
      return {
        id: "evaluation-test-dir-v1",
        contract: provisioner,
      };
    },
    provisionerCapabilities: {
      taskProfiles: [evaluationProfile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json", "text/x-diff"],
      outputMediaTypes: ["application/vnd.in-toto+json"],
      isolation: ["process"],
    },
    capabilityGrants(grants) {
      return Object.entries(grants).map(([key, descriptor]) => ({
        key,
        descriptor,
      } satisfies CapabilityGrant));
    },
    recorderAvailability: "always",
    evidence: {
      repository,
      catalog: new InMemoryEvidenceCatalog(),
      async awaitIndexed(reference) {
        return { status: "not-announced", reference };
      },
    },
    faults: {
      afterDeliveryCheckpoint: options.crashAfterDeliveryCheckpoint,
    },
    now: () => "2026-07-29T12:02:00.000Z",
  });
  backends.push(backend);
  return { backend, pathsByAttempt };
}

async function textFiles(root: string): Promise<string> {
  let output = "";
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    output += entry.isDirectory()
      ? await textFiles(path)
      : await readFile(path, "utf8");
  }
  return output;
}

describe("evaluationLauncher", () => {
  test("is a pure evaluation-profile launcher with only reference/path configuration", () => {
    const launcher = makeEvaluationLauncher({
      deploymentModule: "file:///host/evaluation-deployment.mjs",
      entrypoint: "/opt/jinn/evaluation-harness/bin.js",
      nodeExecutable: "/opt/jinn/node",
    });
    const docs = documents();
    const view: TaskView = {
      task: JSON.parse(decoder.decode(docs.evaluationTask)) as TaskView["task"],
      effectiveRequirements: {},
      profile: evaluationProfile,
    };
    const paths: WorkspacePaths = {
      root: "/attempts/evaluation-1",
      input: "/attempts/evaluation-1/input",
      work: "/attempts/evaluation-1/work",
      out: "/attempts/evaluation-1/out",
      logs: "/attempts/evaluation-1/logs",
      harnessState: "/attempts/evaluation-1/harness-state",
      secrets: "/attempts/evaluation-1/secrets",
      tmp: "/attempts/evaluation-1/tmp",
      meta: "/attempts/evaluation-1/meta",
    };
    const attempt: AttemptIdentity = {
      attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000004",
      nonce: "launcher-purity",
      attemptNumber: 1,
    };
    const first = launcher.plan(view, paths, attempt);
    const second = launcher.plan(view, paths, attempt);

    expect(evaluationLauncher.id).toBe("evaluation-harness");
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      argv: ["/opt/jinn/node", "/opt/jinn/evaluation-harness/bin.js"],
      cwd: paths.work,
      validExitCodes: [0],
      resultContract: {
        envelopeFormat: "jinn-result-evaluation-dsse-v1",
        structuredOutputArtifact: "out/verdict",
      },
      interruptionBehavior: "repeatable",
    });
    expect(first.env).toEqual({
      JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE:
        "file:///host/evaluation-deployment.mjs",
      JINN_ATTEMPT_ROOT: paths.root,
      JINN_ATTEMPT_INPUT: paths.input,
      JINN_ATTEMPT_WORK: paths.work,
      JINN_ATTEMPT_OUT: paths.out,
      JINN_ATTEMPT_LOGS: paths.logs,
      JINN_ATTEMPT_HARNESS_STATE: paths.harnessState,
      JINN_ATTEMPT_SECRETS: paths.secrets,
      JINN_ATTEMPT_META: paths.meta,
      TMPDIR: paths.tmp,
    });
    expect(Object.keys(first.env)).toEqual(
      expect.arrayContaining([
        "JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE",
        "JINN_ATTEMPT_SECRETS",
      ]),
    );
    expect(JSON.stringify(first)).not.toMatch(
      /PRIVATE KEY|evaluator-agent-key\.pem/u,
    );
    expect(first.blameExitCodes).toEqual([
      {
        match: { exitCode: 65 },
        blame: "task",
        reasonCode: "invalid-evaluation-input",
      },
      {
        match: { exitCode: 70 },
        blame: "infrastructure",
        reasonCode: "evaluation-operational-failure",
      },
      {
        match: { exitCode: 78 },
        blame: "infrastructure",
        reasonCode: "evaluation-harness-configuration",
      },
    ]);
    expect(launcher.capabilities().taskProfiles).toEqual([
      evaluationProfile.profile,
    ]);
    expect(launcher.capabilities().outputMediaTypes).toEqual([
      "application/vnd.in-toto+json",
    ]);
  });

  test("runs an evaluator-signed ordinary Attempt through the assembled backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-evaluation-launcher-"));
    roots.push(root);
    const docs = documents();
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyText = String(
      privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const fixture = await backendFixture(root, docs, privateKeyText);

    const ack = await fixture.backend.submit(
      docs.evaluationTask,
      docs.submission,
    );
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    await fixture.backend.drain();
    const snapshot = await fixture.backend.observe(ack.submission);
    expect(
      snapshot.descriptor.derived,
      JSON.stringify(snapshot.observations),
    ).toMatchObject({
      state: "delivered",
      terminal: true,
    });
    expect(
      snapshot.observations.every((observation) =>
        !observation.type.includes("evaluation.attempt")
      ),
    ).toBe(true);
    const paths = fixture.pathsByAttempt.get(snapshot.descriptor.attempt);
    expect(paths).toBeDefined();
    const verdictBytes = await readFile(join(paths!.out, "verdict"));
    const resultEvaluation = validateResultEvaluation(verdictBytes);
    expect(
      resultEvaluation.conforms,
      JSON.stringify(resultEvaluation.diagnostics),
    ).toBe(true);

    const refs = await fixture.backend.deliveries(
      snapshot.descriptor.attempt,
    );
    expect(refs).toHaveLength(1);
    const delivery = JSON.parse(
      decoder.decode(await fixture.backend.fetchDelivery(refs[0]!)),
    ) as {
      outputs: readonly {
        name: string;
        digest: { sha256: string };
      }[];
      evidenceRecords?: readonly unknown[];
      executionIds?: readonly string[];
    };
    expect(delivery.outputs).toEqual([{
      name: "verdict",
      digest: { sha256: sha256(verdictBytes).slice("sha256:".length) },
    }]);
    expect(delivery.evidenceRecords).toHaveLength(1);
    expect(delivery.executionIds).toHaveLength(1);
    await expect(readFile(join(paths!.secrets, "evaluator-agent-key.pem")))
      .rejects.toThrow();
    expect(await textFiles(root)).not.toContain(privateKeyText);
  });

  test("reuses the backend seal-once Delivery checkpoint after a scripted crash", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "jinn-evaluation-launcher-recover-"),
    );
    roots.push(root);
    const docs = documents();
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyText = String(
      privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    let crash = true;
    const first = await backendFixture(root, docs, privateKeyText, {
      crashAfterDeliveryCheckpoint() {
        if (crash) throw new Error("scripted process crash after checkpoint");
      },
    });
    const ack = await first.backend.submit(
      docs.evaluationTask,
      docs.submission,
    );
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    await first.backend.drain();
    const initial = await first.backend.observe(ack.submission);
    const attempt = initial.descriptor.attempt;
    const paths = first.pathsByAttempt.get(attempt);
    expect(paths).toBeDefined();
    const verdictBytes = await readFile(join(paths!.out, "verdict"));
    expect(validateResultEvaluation(verdictBytes).conforms).toBe(true);
    const checkpoint = await readFile(
      first.backend.deliveryCheckpointPath(attempt),
    );

    first.backend.close();
    backends.splice(backends.indexOf(first.backend), 1);
    crash = false;
    const recovered = await backendFixture(root, docs, privateKeyText, {
      crashAfterDeliveryCheckpoint() {
        if (crash) throw new Error("unreachable");
      },
    });
    expect(await recovered.backend.recover(attempt)).toEqual({
      classification: "matching",
    });
    const refs = await recovered.backend.deliveries(attempt);
    expect(refs).toHaveLength(1);
    expect(
      Buffer.from(await recovered.backend.fetchDelivery(refs[0]!)),
    ).toEqual(checkpoint);
    const delivery = JSON.parse(decoder.decode(checkpoint)) as {
      outputs: readonly { name: string; digest: { sha256: string } }[];
    };
    expect(delivery.outputs).toEqual([{
      name: "verdict",
      digest: { sha256: sha256(verdictBytes).slice("sha256:".length) },
    }]);
  });
});
