import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BindingResolver, ResolvedBinding } from "@jinn-network/trust-core";
import { ResultEvaluationStatementSchema } from "@jinn-network/evidence-protocol";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-discovery";
import {
  buildEvaluationTaskProfile,
  deriveEvaluationTask,
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  sealEvaluationSpec,
  sealTaskProfile,
  type EvaluationSpec,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import {
  harvest,
  type ProvisionerContract,
  type WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "@jinn-network/task-execution-backend-local";
import {
  makeEvaluationLauncher,
  type EvaluatorRegistration,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  PREDICTION_PARSER,
  predictionEvaluationSpecMeasurements,
  predictionEvaluationSpecVerdictRule,
} from "@jinn-network/task-execution-evaluator-adapters";
import { createFilesystemEvidenceRepository } from "@jinn-network/evidence-repository/fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../../src/store/store.js";
import { NativeEvaluatorStateRepository } from "../../src/daemon/native-evaluator-state.js";
import {
  buildNativeEvaluatorComposition,
  type NativeEvaluatorCompositionInput,
} from "../../src/daemon/native-evaluator-composition.js";
import { openRoleIdentitySet } from "../../src/daemon/role-identities.js";
import {
  PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH,
  PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH,
  PREDICTION_EVALUATOR_METHOD_DESCRIPTOR_PATH,
  predictionEvaluatorMethodDigest,
  predictionEvaluatorModuleDigest,
  writePredictionEvaluatorSidecar,
} from "../../src/native-evaluator/deployment-paths.js";

const AGENT = "urn:jinn:evaluator:prediction-deployment-fixture";
const OTHER_AGENT = "urn:jinn:evaluator:prediction-deployment-fixture-other";
const EVALUATOR_ADDRESS = `0x${"2".repeat(40)}` as const;
const COORDINATOR = `0x${"3".repeat(40)}` as const;
const SIGNER_HANDLE = "prediction-market-evaluator-verdict";
const MODULE_HREF = pathToFileURL(PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH).href;
const roots: string[] = [];
let claimEvidenceRoot: string;

beforeAll(async () => {
  claimEvidenceRoot = await mkdtemp(join(tmpdir(), "jinn-prediction-deployment-evidence-"));
  roots.push(claimEvidenceRoot);
  // Written before the module's first (and only, per resolved-URL import cache) dynamic
  // import in this process. Padded with incidental whitespace to prove the module trims
  // the sidecar's declared agent before using it (regression coverage for a prior bug
  // where an untrimmed value produced a misleading "different persistent agent" error).
  await writePredictionEvaluatorSidecar({ agent: `  ${AGENT}  `, claimEvidenceDir: claimEvidenceRoot });
});

afterAll(async () => {
  await rm(PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, { force: true });
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function binding(key: string): ResolvedBinding {
  return {
    binding: {
      key: { didKey: key, keyid: key },
      scope: ["authorizations", "observations", "deliveries", "verdicts", "settlements"],
      validFrom: "2026-08-01T00:00:00.000Z",
    },
    effectiveStart: "2026-08-01T00:00:00.000Z",
    revocations: [],
  } as ResolvedBinding;
}

async function fixture(input: { readonly agent?: string } = {}) {
  const agent = input.agent ?? AGENT;
  const root = await mkdtemp(join(tmpdir(), "jinn-prediction-deployment-composition-"));
  roots.push(root);
  const resolver: BindingResolver = {
    resolveBinding: async (query) => binding(query.key),
  };
  const roles = await openRoleIdentitySet({
    storePath: join(root, "identity", "roles.enc.json"),
    password: "operator-password",
    agent,
    bindingResolver: resolver,
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
  const evaluationProfile = buildEvaluationTaskProfile();
  const profileDigest = sealTaskProfile(evaluationProfile).digest;
  const store = new Store(":memory:");
  const state = new NativeEvaluatorStateRepository(store, {
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
  const backendConfigs: LocalTaskExecutionBackendConfig[] = [];
  const backend = {
    shutdown: async () => undefined,
    getDeliverySignature: () => undefined,
  } as unknown as LocalTaskExecutionBackend;
  const evidence = {
    repository: {
      capabilities: {},
      putRecord: async () => undefined, getRecord: async () => undefined,
      putArtifact: async () => undefined, getArtifact: async () => undefined,
    },
    catalog: {},
    awaitIndexed: async () => undefined,
  } as unknown as NativeEvaluatorCompositionInput["backend"]["evidence"];
  const moduleDigest = await predictionEvaluatorModuleDigest();
  const evaluationMethodDigest = await predictionEvaluatorMethodDigest();
  const config: NativeEvaluatorCompositionInput = {
    roles,
    state,
    coordinatorAddress: COORDINATOR,
    evaluatorAddress: EVALUATOR_ADDRESS,
    operatorIdentity: {
      safeAddress: EVALUATOR_ADDRESS,
      agentEoa: `0x${"4".repeat(40)}`,
      agentIri: agent,
    },
    deployment: {
      module: PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH,
      moduleDigest,
      signerHandle: SIGNER_HANDLE,
      evaluationMethodDigest,
    },
    backend: {
      stateRoot: join(root, "backend"),
      source: "urn:jinn:evaluator-backend:prediction-deployment-fixture",
      executor: "urn:jinn:evaluation-harness:prediction-v1",
      profileStore: { get: (digest) => digest === profileDigest ? evaluationProfile : undefined },
      launcherDeployment: {
        executable: { path: process.execPath, digest: "a".repeat(64) },
        probe: async () => ({ ready: true, executable: { path: process.execPath, digest: "a".repeat(64) } }),
      },
      workspaceRuntime: {
        assertHarnessGroupEmpty: async () => undefined,
        ensureMetaReserve: async () => undefined,
      },
      evidence,
    },
    publisher: {
      rootDir: join(root, "evaluator-records"),
      publicBaseUrl: "https://evaluator.example/native",
    },
    opportunities: {
      sourceId: "urn:jinn:solver:prediction-deployment-fixture/solver-records",
      read: async () => [],
    },
    subject: { fetcher: { byCid: async () => undefined, byDigest: async () => undefined } },
    authority: { claim: async () => ({}) as never, dependencies: {} as never },
    deadline: () => "2026-08-03T00:00:00.000Z",
    verdictPorts: {} as never,
    chain: {} as never,
    verification: {} as never,
    constructBackend(backendConfig) {
      backendConfigs.push(backendConfig);
      return backend;
    },
  };
  return { root, store, config, backendConfigs };
}

describe("production prediction-market deployment module — real composition path", () => {
  it("loads through buildNativeEvaluatorComposition and satisfies every production check", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    const backendConfig = value.backendConfigs[0]!;
    expect(backendConfig.launchers).toHaveLength(1);
    expect(backendConfig.launchers[0]!.capabilities().taskProfiles).toEqual([
      "https://jinn.network/task-profiles/evaluation-task/1.0",
    ]);
    expect(backendConfig.launchers[0]!.capabilities().hostSecretForwards).toEqual([]);
    await composition.close();
    value.store.close();
  });

  it("refuses a module digest that does not equal the committed file's bytes", async () => {
    const value = await fixture();
    await expect(buildNativeEvaluatorComposition({
      ...value.config,
      deployment: { ...value.config.deployment, moduleDigest: `sha256:${"0".repeat(64)}` },
    })).rejects.toThrow(/module digest mismatch/);
    expect(value.backendConfigs).toEqual([]);
    value.store.close();
  });

  it("refuses an operator agent that does not equal the module's sidecar-declared identity", async () => {
    const value = await fixture({ agent: OTHER_AGENT });
    await expect(buildNativeEvaluatorComposition(value.config))
      .rejects.toThrow(/different persistent agent/);
    expect(value.backendConfigs).toEqual([]);
    value.store.close();
  });

  it("refuses a signerHandle that does not equal the registration's declared handle", async () => {
    const value = await fixture();
    await expect(buildNativeEvaluatorComposition({
      ...value.config,
      deployment: { ...value.config.deployment, signerHandle: "some-other-handle" },
    })).rejects.toThrow(/different host signer handle/);
    expect(value.backendConfigs).toEqual([]);
    value.store.close();
  });

  it("refuses an evaluationMethodDigest that does not equal the descriptor's digest", async () => {
    const value = await fixture();
    await expect(buildNativeEvaluatorComposition({
      ...value.config,
      deployment: { ...value.config.deployment, evaluationMethodDigest: `sha256:${"1".repeat(64)}` },
    })).rejects.toThrow(/method digest changed/);
    expect(value.backendConfigs).toEqual([]);
    value.store.close();
  });
});

describe("production prediction-market deployment module — evidence writer and digests", () => {
  it("round-trips claim evidence bytes through the durable filesystem repository", async () => {
    const module = await import(MODULE_HREF) as {
      readonly evaluationHarnessDeployment: {
        readonly evidenceWriter: {
          putClaimEvidence(input: {
            readonly name: string;
            readonly bytes: Uint8Array;
            readonly mediaType?: string;
          }): Promise<{ readonly name: string; readonly digest: { readonly sha256: string }; readonly mediaType?: string }>;
        };
      };
    };
    const bytes = new TextEncoder().encode("claim evidence round-trip fixture bytes");
    const descriptor = await module.evaluationHarnessDeployment.evidenceWriter.putClaimEvidence({
      name: "claim-evidence.txt",
      bytes,
      mediaType: "text/plain",
    });
    expect(descriptor.name).toBe("claim-evidence.txt");
    expect(descriptor.mediaType).toBe("text/plain");
    expect(descriptor.digest.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const independentRepository = await createFilesystemEvidenceRepository({ rootDir: claimEvidenceRoot });
    const read = await independentRepository.getArtifact({ digest: `sha256:${descriptor.digest.sha256}` });
    expect(read).not.toBeNull();
    expect(Buffer.from(read!).equals(Buffer.from(bytes))).toBe(true);
  });

  it("declares the fixed registrationId, signerHandle, evaluation method uri, and the exact trimmed sidecar agent", async () => {
    const module = await import(MODULE_HREF) as {
      readonly evaluationHarnessDeployment: {
        readonly registrations: readonly {
          readonly registrationId: string;
          readonly signer: { readonly handle: string };
          readonly evaluatorIdentity: { readonly id: string };
          readonly evaluationMethod: { readonly uri?: string; readonly digest: { readonly sha256: string } };
        }[];
      };
    };
    expect(module.evaluationHarnessDeployment.registrations).toHaveLength(1);
    const [registration] = module.evaluationHarnessDeployment.registrations;
    expect(registration!.registrationId).toBe("prediction-market");
    expect(registration!.signer.handle).toBe(SIGNER_HANDLE);
    // Proves the sidecar's whitespace-padded agent (see beforeAll) was trimmed, not used verbatim.
    expect(registration!.evaluatorIdentity.id).toBe(AGENT);
    expect(registration!.evaluationMethod.uri).toBe(
      "https://jinn.network/evaluation-methods/prediction-market/1.0",
    );
    expect(registration!.evaluationMethod.digest.sha256).toBe(
      (await predictionEvaluatorMethodDigest()).slice("sha256:".length),
    );
  });

  it("computes moduleDigest as the exact sha256 of the committed module bytes", async () => {
    const bytes = await readFile(PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH);
    expect(await predictionEvaluatorModuleDigest()).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  });

  it("computes evaluationMethodDigest as the exact sha256 of the committed descriptor bytes", async () => {
    const bytes = await readFile(PREDICTION_EVALUATOR_METHOD_DESCRIPTOR_PATH);
    expect(await predictionEvaluatorMethodDigest()).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  });
});

// --- the mandatory spawn-path proof --------------------------------------------------
//
// Every test above imports the deployment module IN this test process. That is exactly
// the gap that let the original bug through: this module is also imported by a
// genuinely SEPARATE, SPAWNED evaluation-harness child process
// (`packages/task-execution/evaluation-harness/src/runtime.ts`'s
// `deploymentFromEnvironment()`, launched via `makeEvaluationLauncher` +
// `makeLocalTaskExecutionBackend`'s real subprocess shim), whose environment is
// reconstructed from scratch and does NOT inherit this process's `process.env`. The
// only thing that proves the fix is driving a real Attempt through that real spawn.

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
      image: { name: "prediction-spawn-image", digest: { sha256: "b".repeat(64) } },
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

interface PredictionDocuments {
  readonly evaluationTask: Uint8Array;
  readonly subjectTask: Uint8Array;
  readonly subjectDelivery: Uint8Array;
  readonly subjectResult: Uint8Array;
  readonly specificationBytes: Uint8Array;
  readonly submission: Uint8Array;
  readonly context: Record<string, unknown>;
}

function predictionDocuments(): PredictionDocuments {
  const spec = predictionSpec();
  const sealedSpecification = sealEvaluationSpec(spec);
  const subjectTask = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: "https://jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "4".repeat(64) },
    },
    instructions: "Submit a prediction.",
    outputs: [{ name: "result.json", mediaType: "application/json", required: true }],
    evaluation: {
      name: "evaluation-spec.json",
      digest: { sha256: sealedSpecification.digest.slice("sha256:".length) },
    },
  });
  const submittedAt = "2026-07-29T12:00:30.000Z";
  const subjectResult = new TextEncoder().encode(JSON.stringify({
    probabilityYes: "0.500000",
    submittedAt,
  }));
  const subjectDelivery = sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt: "urn:uuid:11111111-1111-4111-8111-111111111112",
    task: documentDigest(subjectTask),
    outputs: [{
      name: "result.json",
      mediaType: "application/json",
      digest: { sha256: sha256(subjectResult).slice("sha256:".length) },
    }],
    outcome: "fulfilled",
    createdAt: "2026-07-29T12:00:00.000Z",
  });
  const evaluationTask = deriveEvaluationTask({
    subjectTask: { name: "subject-task.json", digest: sha256(subjectTask) },
    subjectDelivery: { name: "subject-delivery.json", digest: sha256(subjectDelivery) },
    subjectResults: [{ name: "result.json", digest: sha256(subjectResult) }],
    evaluationSpecDigest: sealedSpecification.digest,
  }).bytes;
  const submission = sealSubmission({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    submission: `urn:uuid:${randomUUID()}`,
    task: { digest: { sha256: documentDigest(evaluationTask).slice("sha256:".length) } },
    requester: "urn:uuid:22222222-2222-4222-8222-222222222223",
    idempotencyKey: randomUUID(),
    nonce: randomUUID(),
    deadline: "2099-01-01T00:00:00.000Z",
    requirements: { harness: { id: "evaluation-harness", version: "0.1.0" } },
  });
  return {
    evaluationTask,
    subjectTask,
    subjectDelivery,
    subjectResult,
    specificationBytes: sealedSpecification.bytes,
    submission,
    context: {
      resolutionSnapshot: {
        status: "unresolved",
        marketId: "market-spawn-1",
        conditionId: "condition-spawn-1",
      },
      market: { marketId: "market-spawn-1", conditionId: "condition-spawn-1" },
      window: {
        startTs: Date.parse("2026-07-29T12:00:00.000Z"),
        endTs: Date.parse("2026-07-29T12:01:00.000Z"),
      },
      consensusProbabilityYes: "0.500000",
    },
  };
}

async function spawnBackendFixture(root: string, docs: PredictionDocuments): Promise<{
  readonly backend: LocalTaskExecutionBackend;
  readonly pathsByAttempt: Map<string, WorkspacePaths>;
}> {
  const pathsByAttempt = new Map<string, WorkspacePaths>();
  const module = await import(MODULE_HREF) as {
    readonly evaluationHarnessDeployment: { readonly registrations: readonly EvaluatorRegistration[] };
  };
  const registration = module.evaluationHarnessDeployment.registrations[0]!;
  // Deliberately NOT overriding `entrypoint`/`nodeExecutable` -- this is the exact same
  // default resolution production uses (`native-evaluator-composition.ts` doesn't
  // override them either), so this launcher spawns the real compiled
  // `@jinn-network/task-execution-evaluation-harness` `dist/bin.js` as a genuine child
  // process, not an in-process call.
  const launcher = makeEvaluationLauncher({
    deploymentModule: MODULE_HREF,
    registrations: [registration],
    selectRegistration: () => registration,
  });
  const repository = new InMemoryEvidenceRepository();
  const evaluationProfile = buildEvaluationTaskProfile();
  const sealedEvaluationProfile = sealTaskProfile(evaluationProfile);
  const profileStore: ProfileStore = {
    get: (digest) => digest === sealedEvaluationProfile.digest ? evaluationProfile : undefined,
  };
  const backend = makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "https://jinn.network/software/backend-local/prediction-deployment-spawn-test",
    executor: "https://jinn.network/software/evaluation-harness",
    profileStore,
    launchers: [launcher],
    provisioner(input) {
      const provisioner: ProvisionerContract = {
        workspaceKind: () => "dir",
        async setup(_view, paths, grants) {
          pathsByAttempt.set(input.attempt.attemptUri, paths);
          await Promise.all(
            Object.values(paths).filter((path) => path !== paths.secrets).map((path) =>
              mkdir(path, { recursive: true })
            ),
          );
          expect(grants).toEqual([]);
          await Promise.all([
            writeFile(join(paths.input, "task.sealed"), input.sealedTaskBytes),
            writeFile(join(paths.input, "dispatch-context.json"), input.dispatchContextBytes),
            writeFile(join(paths.input, "subject-task.json"), docs.subjectTask),
            writeFile(join(paths.input, "subject-delivery.json"), docs.subjectDelivery),
            writeFile(join(paths.input, "result.json"), docs.subjectResult),
            writeFile(join(paths.input, "evaluation-spec.json"), docs.specificationBytes),
            writeFile(join(paths.input, "evaluation-context.json"), JSON.stringify(docs.context)),
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
      return { id: "prediction-deployment-spawn-dir-v1", contract: provisioner };
    },
    provisionerCapabilities: {
      taskProfiles: [evaluationProfile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["application/vnd.in-toto+json"],
      isolation: ["process"],
    },
    launcherDeployments: {
      [launcher.id]: {
        executable: { path: process.execPath, digest: "a".repeat(64) },
        async probe() {
          return {
            ready: true,
            executable: { path: process.execPath, digest: "a".repeat(64) },
            harnessVersions: ["0.1.0"],
          };
        },
      },
    },
    recorderAvailability: "always",
    evidence: {
      repository,
      catalog: new InMemoryEvidenceCatalog(),
      async awaitIndexed(reference) {
        return { status: "not-announced", reference };
      },
    },
    now: () => "2026-07-29T12:02:00.000Z",
  });
  return { backend, pathsByAttempt };
}

describe("production prediction-market deployment module — spawned evaluation-harness child", () => {
  it(
    "the spawned child process imports the deployment via the on-disk sidecar and produces a verdict, with no reliance on this process's env",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "jinn-prediction-deployment-spawn-"));
      roots.push(root);
      const docs = predictionDocuments();
      const { backend, pathsByAttempt } = await spawnBackendFixture(root, docs);
      try {
        const ack = await backend.submit(docs.evaluationTask, docs.submission);
        expect(ack.accepted).toBe(true);
        if (!ack.accepted) throw new Error("unreachable");
        await backend.drain();
        const snapshot = await backend.observe(ack.submission);
        expect(
          snapshot.descriptor.derived,
          JSON.stringify(snapshot.observations),
        ).toMatchObject({ state: "delivered", terminal: true });

        const paths = pathsByAttempt.get(snapshot.descriptor.attempt);
        expect(paths).toBeDefined();
        const verdictBytes = await readFile(join(paths!.out, "verdict"));
        const parsed = ResultEvaluationStatementSchema.safeParse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(verdictBytes)),
        );
        expect(parsed.success, JSON.stringify(parsed)).toBe(true);
        if (!parsed.success) throw new Error("unreachable");

        // "produces a verdict": the spawned child successfully imported the deployment
        // (via its own, independent read of the on-disk sidecar -- it inherited nothing
        // from this test process) and evaluated the unresolved market to `inconclusive`.
        expect(parsed.data.predicate.verdict).toBe("inconclusive");
        expect(parsed.data.predicate.evaluator.id).toBe(AGENT);
        expect(parsed.data.predicate.evaluationMethod?.digest.sha256).toBe(
          (await predictionEvaluatorMethodDigest()).slice("sha256:".length),
        );
      } finally {
        await backend.shutdown();
      }
    },
    60_000,
  );
});
