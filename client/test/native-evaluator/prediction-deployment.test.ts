import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BindingResolver, ResolvedBinding } from "@jinn-network/trust-core";
import { ResultEvaluationStatementSchema } from "@jinn-network/evidence-protocol";
import { buildResultEvaluationPayload } from "@jinn-network/attestation-issuer";
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
  type LocalProvisionerInput,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "@jinn-network/task-execution-backend-local";
import {
  makeEvaluationLauncher,
  type EvaluatorRegistration,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  PREDICTION_PARSER,
  contextResolutionSnapshotSource,
  parsePredictionResult,
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
import {
  EVALUATION_CONTEXT_INPUT_NAME,
  derivePredictionEvaluationContext,
  nativeEvaluationHostInputs,
} from "../../src/daemon/native-evaluation-context.js";
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
const CLIENT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
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
      // Every scope a native role can require, including the announce-plane scope the three
      // `*-discovery` roles gained in issue #2525 and the admission-receipt scope the `admission`
      // role gained in #33.
      scope: ["authorizations", "observations", "deliveries", "verdicts", "settlements",
        "jinn:discovery-announcements", "https://spec.jinn.network/trust-scopes/admission-receipts/v1"],
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
      "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
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

  // Regression lock for the one-swap P0-5 registration-set relaxation: the committed #2439
  // artifact must keep loading through the relaxed selector with its bytes untouched, and its
  // single registration must still be selected without the composition reading durable state.
  it("keeps loading unedited under the relaxed registration-set selector", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    const backendConfig = value.backendConfigs[0]!;
    const module = await import(MODULE_HREF) as {
      readonly evaluationHarnessDeployment: { readonly registrations: readonly EvaluatorRegistration[] };
    };
    expect(module.evaluationHarnessDeployment.registrations).toHaveLength(1);
    const plan = backendConfig.launchers[0]!.plan(
      {
        task: {
          protocol: "https://spec.jinn.network/profiles/task-execution/v1",
          profile: {
            uri: "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
            digest: { sha256: "c".repeat(64) },
          },
          instructions: "evaluate",
          // Deliberately unresolvable: a one-registration deployment must not need it.
          payload: { evaluationSpec: `sha256:${"9".repeat(64)}` },
          outputs: [],
        },
        effectiveRequirements: {},
        profile: { profile: "https://spec.jinn.network/task-profiles/evaluation-task/1.0" },
      } as never,
      {
        root: "/tmp/a", input: "/tmp/a/input", work: "/tmp/a/work", out: "/tmp/a/out",
        logs: "/tmp/a/logs", tmp: "/tmp/a/tmp", harnessState: "/tmp/a/harness-state",
        secrets: "/tmp/a/secrets", meta: "/tmp/a/meta",
      } as never,
      {} as never,
    );
    expect(plan.env!["JINN_ATTEMPT_EVALUATOR_REGISTRATION"]).toBe("prediction-market");
    expect(plan.env!["JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE"]).toBe(MODULE_HREF);
    await composition.close();
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
      "https://spec.jinn.network/evaluation-methods/prediction-market/v1",
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
}

function predictionDocuments(): PredictionDocuments {
  const spec = predictionSpec();
  const sealedSpecification = sealEvaluationSpec(spec);
  // A real `prediction-forecast` payload, because the evaluation context this Attempt grades
  // against is DERIVED from it by the production host (`nativeEvaluationHostInputs`). Before #41
  // this fixture's subject Task carried no forecast at all and the context was a hand-written
  // literal in the provisioner below -- so the spawned child was fed a workspace no live operator
  // could produce, and the real staging path was never exercised. The window brackets the
  // `submittedAt` stamped on the subject Result below.
  const subjectTask = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: "https://spec.jinn.network/task-profiles/prediction-forecast/1.0",
      digest: { sha256: "4".repeat(64) },
    },
    payload: {
      forecast: {
        marketId: "market-spawn-1",
        question: "Will the spawn-path fixture market resolve?",
        consensusProbabilityYes: "0.500000",
        observedAt: "2026-07-29T12:00:00Z",
        resolvesAt: "2026-07-29T12:01:00Z",
      },
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
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
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
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
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
    source: "https://spec.jinn.network/software/backend-local/prediction-deployment-spawn-test",
    executor: "https://spec.jinn.network/software/evaluation-harness",
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
          // The host-contributed inputs come from the PRODUCTION function the daemon's own
          // provisioner calls (`nativeEvaluationHostInputs`), never from literals restated here.
          // That is the whole point of #41: the previous shadow copy wrote an
          // `evaluation-context.json` the real `native-evaluation-dir-v1` provisioner never
          // produced, so this spawn proof stayed green through every live refusal.
          const hostInputs = nativeEvaluationHostInputs({
            specification: predictionSpec(),
            specificationBytes: docs.specificationBytes,
            specificationMediaType: "application/json",
            subjectTaskBytes: () => docs.subjectTask,
          });
          await Promise.all([
            writeFile(join(paths.input, "task.sealed"), input.sealedTaskBytes),
            writeFile(join(paths.input, "dispatch-context.json"), input.dispatchContextBytes),
            writeFile(join(paths.input, "subject-task.json"), docs.subjectTask),
            writeFile(join(paths.input, "subject-delivery.json"), docs.subjectDelivery),
            writeFile(join(paths.input, "result.json"), docs.subjectResult),
            ...hostInputs.map((staged) => writeFile(join(paths.input, staged.name), staged.bytes)),
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

// --- packaging: the sidecar must never reach a downstream installer ------------------
//
// `client/.gitignore` only governs what git commits; it says nothing about what `npm
// pack`/`npm publish` ships. `deployments/` is included unconditionally in
// `package.json`'s `files` array, and files-array entries cannot be excluded by an
// ignore file (and this package also has a `client/.npmignore`, which -- when present --
// makes npm ignore `.gitignore` entirely). The only mechanism that actually excludes a
// files-array-included path is a negated pattern in that same array
// (`"!/deployments/evaluator/*.local.json"`). This test proves that pattern still works,
// with a real sidecar on disk, so a future edit to `files` can't silently regress it.
describe("production prediction-market deployment module — npm packaging", () => {
  it("excludes the sidecar from the published tarball while still shipping the committed artifacts", async () => {
    // The sidecar written in this file's top-level beforeAll (at the same co-located
    // path the deployment module reads) is on disk for this entire suite -- exactly
    // the "real sidecar present" precondition this check must hold under, not an
    // absence trivially passing.
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
      cwd: CLIENT_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    const [entry] = JSON.parse(stdout) as readonly {
      readonly files: readonly { readonly path: string }[];
    }[];
    const paths = entry!.files.map((file) => file.path);
    expect(paths).toContain("deployments/evaluator/prediction-market-deployment.mjs");
    expect(paths).toContain("deployments/evaluator/prediction-market-evaluation-method.v1.json");
    expect(paths).not.toContain("deployments/evaluator/prediction-market-deployment.local.json");
  }, 30_000);
});

// --- the harvest-time identity guard is now load-bearing -----------------------------
//
// The sidecar is not part of `moduleDigest` (see docs/operator/native-evaluator-deployment.md)
// specifically because two OTHER guards make identity correctness not depend on hashing
// it. One is the boot-time cross-check already covered above ("refuses an operator agent
// that does not equal..."). The other -- `native-evaluator-composition.ts`'s
// `stateBackedProvisioner` harvest contract requiring
// `predicate.evaluator.id === roles.agent` before it will seal anything -- had zero
// coverage before this test. It is the sole barrier against a verdict whose *declared*
// evaluator identity (inside the unsigned statement a spawned child produced) doesn't
// match this daemon's own trusted role authority, e.g. because a sidecar was swapped for
// only the spawned child and not the parent.
describe("production prediction-market deployment module — harvest-time identity guard", () => {
  async function admittedEvaluationFixture(state: NativeEvaluatorStateRepository) {
    const artifact = (name: string, value: string) => {
      const bytes = new TextEncoder().encode(value);
      return { name, bytes, digest: documentDigest(bytes) };
    };
    // The `task` and `evaluation-spec` artifacts must be REAL documents: since #41 the
    // provisioner parses the durable EvaluationSpec and derives the staged evaluation context from
    // the durable subject Task before it will provision anything, so placeholder strings in those
    // two slots no longer reach the harvest contract this suite is about. Every other slot is
    // opaque to the provisioner and stays a cheap literal.
    const documents = predictionDocuments();
    const bytesArtifact = (name: string, bytes: Uint8Array) => ({ name, bytes, digest: documentDigest(bytes) });
    const subject = {
      task: bytesArtifact("task", documents.subjectTask),
      submission: artifact("submission", "harvest-guard-subject-submission"),
      requesterEnvelope: artifact("requester-envelope", "harvest-guard-requester-envelope"),
      admissionReceipt: artifact("admission-receipt", "harvest-guard-admission-receipt"),
      delivery: artifact("delivery", "harvest-guard-solution-delivery"),
      deliveryEnvelope: artifact("delivery-envelope", "harvest-guard-solution-delivery-envelope"),
      evidenceRecords: [artifact("solution-evidence", "harvest-guard-solution-evidence")],
      results: [artifact("prediction", "harvest-guard-prediction-result")],
      evaluationSpec: bytesArtifact("evaluation-spec", documents.specificationBytes),
    };
    const admitted = state.admitOpportunity({
      opportunity: {
        source: "https://solver.example/harvest-guard-source",
        sourceSequence: "0000000000000001",
        sourceEntryDigest: `sha256:${"a".repeat(64)}`,
        canonical: true,
        finality: "finalized",
        chainId: 84532,
        taskId: 9n,
        attemptIndex: 1,
        solutionRequestId: `0x${"b".repeat(64)}`,
        operatorAddress: `0x${"1".repeat(40)}`,
        deliveryCid: "bafyharvestguard",
        advertisedDeliveryDigest: subject.delivery.digest,
        blockHash: `0x${"c".repeat(64)}`,
        blockNumber: 200n,
        transactionHash: `0x${"d".repeat(64)}`,
        logIndex: 1,
        canonicalEventIdentity: `84532:0x${"c".repeat(64)}:1`,
      },
      evaluatorAgent: AGENT,
      coordinator: COORDINATOR,
      material: subject,
    });
    state.recordAdmissionVerified(admitted.evaluationId, {
      requester: { signerKey: "did:key:harvest-guard-requester", sealingTime: "2026-08-02T10:00:00Z" },
      admission: { signerKey: "did:key:harvest-guard-admission", effectiveTime: "2026-08-02T10:00:00Z" },
      executor: {
        signerKey: "did:key:harvest-guard-executor",
        agent: "https://agents.example/harvest-guard-solver",
        declarationKey: "did:key:harvest-guard-solver-declaration",
        effectiveTime: "2026-08-02T10:30:00Z",
        address: `0x${"1".repeat(40)}`,
      },
      evaluator: {
        signerKey: "did:key:harvest-guard-evaluator",
        agent: AGENT,
        declarationKey: "did:key:harvest-guard-evaluator-declaration",
        address: EVALUATOR_ADDRESS,
      },
      verificationDigest: `sha256:${"e".repeat(64)}`,
    });
    const taskBytes = new TextEncoder().encode("harvest-guard-exact-evaluation-task");
    const taskDigest = documentDigest(taskBytes);
    const deadline = "2026-08-03T00:00:00.000Z";
    const submissionBytes = sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: "urn:uuid:00000000-0000-4000-8000-000000000030",
      task: { digest: { sha256: taskDigest.slice("sha256:".length) } },
      requester: AGENT,
      idempotencyKey: admitted.evaluationId,
      nonce: admitted.evaluationId,
      deadline,
    });
    state.recordDerivedEvaluation(admitted.evaluationId, {
      taskBytes,
      taskDigest,
      submissionBytes,
      submissionDigest: documentDigest(submissionBytes),
      submissionUri: "urn:uuid:00000000-0000-4000-8000-000000000030",
    });
    const claim = state.beginEvaluationClaim(admitted.evaluationId, `0x${"f".repeat(64)}`);
    state.recordEvaluationClaimFinalized(claim.operationId, {
      txHash: `0x${"1".repeat(64)}`,
      blockHash: `0x${"2".repeat(64)}`,
      blockNumber: 201n,
      requestId: `0x${"9".repeat(64)}`,
      verdictIndex: 1,
      evaluatorAddress: EVALUATOR_ADDRESS,
    });
    const evaluationRow = state.getEvaluation(admitted.evaluationId)!;
    const attemptUri = evaluationRow.evaluationAttemptUri!;
    expect(attemptUri).toBeTruthy();
    const [task, evaluationSpec, result] = [
      subject.task,
      subject.evaluationSpec,
      subject.results[0]!,
    ] as const;
    return { evaluationId: admitted.evaluationId, attemptUri, taskBytes, deadline, task, evaluationSpec, result };
  }

  async function harvestContractFor(
    config: NativeEvaluatorCompositionInput,
    backendConfigs: LocalTaskExecutionBackendConfig[],
    input: { readonly attemptUri: string; readonly taskBytes: Uint8Array },
  ): Promise<{ readonly contract: ProvisionerContract; readonly outDir: string }> {
    const backendConfig = backendConfigs[0]!;
    const provisionerInput = {
      attempt: { attemptUri: input.attemptUri, nonce: "harvest-guard-nonce", attemptNumber: 1 },
      sealedTaskBytes: input.taskBytes,
      dispatchContextBytes: new TextEncoder().encode("{}"),
    } as unknown as LocalProvisionerInput;
    const selected = backendConfig.provisioner(provisionerInput);
    const workRoot = await mkdtemp(join(tmpdir(), "jinn-harvest-guard-"));
    roots.push(workRoot);
    const outDir = join(workRoot, "out");
    await mkdir(outDir, { recursive: true });
    return { contract: selected.contract, outDir };
  }

  it("throws 'outside its exact Attempt authority' for an unsigned verdict whose evaluator.id does not equal roles.agent", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    try {
      const fixtureState = await admittedEvaluationFixture(value.config.state);
      const { contract, outDir } = await harvestContractFor(value.config, value.backendConfigs, fixtureState);
      const evaluationMethodDigest = await predictionEvaluatorMethodDigest();

      const impostorPayload = buildResultEvaluationPayload({
        task: { name: fixtureState.task.name, digest: fixtureState.task.digest },
        results: [{ name: fixtureState.result.name, digest: fixtureState.result.digest }],
        evaluator: { id: OTHER_AGENT },
        evaluatedAt: "2026-08-02T13:00:00.000Z",
        verdict: "pass",
        evaluationSpecification: { name: fixtureState.evaluationSpec.name, digest: fixtureState.evaluationSpec.digest },
        evaluationMethod: { name: "prediction-market-evaluator-v1", digest: evaluationMethodDigest },
      });
      await writeFile(join(outDir, "verdict"), impostorPayload);

      await expect(contract.harvest({
        root: outDir, input: outDir, work: outDir, out: outDir, logs: outDir,
        harnessState: outDir, secrets: outDir, tmp: outDir, meta: outDir,
      } as unknown as WorkspacePaths, [])).rejects.toThrow(/outside its exact Attempt authority/);
    } finally {
      await composition.close();
      value.store.close();
    }
  });

  it("gets past the identity-authority guard to a later, different check when evaluator.id equals roles.agent", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    try {
      const fixtureState = await admittedEvaluationFixture(value.config.state);
      const { contract, outDir } = await harvestContractFor(value.config, value.backendConfigs, fixtureState);
      const evaluationMethodDigest = await predictionEvaluatorMethodDigest();

      const genuinePayload = buildResultEvaluationPayload({
        task: { name: fixtureState.task.name, digest: fixtureState.task.digest },
        results: [{ name: fixtureState.result.name, digest: fixtureState.result.digest }],
        evaluator: { id: AGENT },
        evaluatedAt: "2026-08-02T13:00:00.000Z",
        verdict: "pass",
        evaluationSpecification: { name: fixtureState.evaluationSpec.name, digest: fixtureState.evaluationSpec.digest },
        evaluationMethod: { name: "prediction-market-evaluator-v1", digest: evaluationMethodDigest },
      });
      await writeFile(join(outDir, "verdict"), genuinePayload);

      const paths = {
        root: outDir, input: outDir, work: outDir, out: outDir, logs: outDir,
        harnessState: outDir, secrets: outDir, tmp: outDir, meta: outDir,
      } as unknown as WorkspacePaths;
      // Identical statement construction to the previous test, with only `evaluator.id`
      // changed to match `roles.agent`. These are the real harness producer's bytes
      // (`buildResultEvaluationPayload`) under the real prediction evaluation-method digest, so
      // the whole harvest now completes: the statement is sealed verbatim into a DSSE envelope.
      // Reaching the seal -- which only runs after the identity `if` block completes false -- is
      // proof the identity guard specifically is what `evaluator.id` flips, not a false positive
      // tripped by some unrelated field this fixture also carries. Before #35 this same call
      // stopped one step later at "not canonical exact bytes", which every genuine harness run
      // hit too.
      await expect(contract.harvest(paths, [])).resolves.toBeDefined();
    } finally {
      await composition.close();
      value.store.close();
    }
  });
});

// --- sidecar shape validation ---------------------------------------------------------
//
// The module's top-level sidecar read executes once per resolved specifier (Node's ESM
// import cache), so re-testing a REJECTED shape needs a fresh module instance. Appending
// a distinguishing query string to the same file: URL gives each case its own cache
// entry while still resolving to the identical on-disk file -- a standard technique for
// exercising an ESM module's side-effecting top-level code more than once in one process.
describe("production prediction-market deployment module — sidecar shape validation", () => {
  async function restoreValidSidecar(): Promise<void> {
    await writePredictionEvaluatorSidecar({ agent: `  ${AGENT}  `, claimEvidenceDir: claimEvidenceRoot });
  }

  it("rejects a present, non-string claimEvidenceDir instead of silently falling back to the default directory", async () => {
    await writeFile(
      PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH,
      `${JSON.stringify({ agent: AGENT, claimEvidenceDir: 42 })}\n`,
    );
    try {
      await expect(import(`${MODULE_HREF}?shape-case=non-string-claim-evidence-dir`))
        .rejects.toThrow(/claimEvidenceDir.*must be a string/);
    } finally {
      await restoreValidSidecar();
    }
  });

  it("rejects a missing agent field", async () => {
    await writeFile(PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, `${JSON.stringify({})}\n`);
    try {
      await expect(import(`${MODULE_HREF}?shape-case=missing-agent`))
        .rejects.toThrow(/non-empty "agent"/);
    } finally {
      await restoreValidSidecar();
    }
  });

  it("rejects an agent field that is whitespace only", async () => {
    await writeFile(PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, `${JSON.stringify({ agent: "   " })}\n`);
    try {
      await expect(import(`${MODULE_HREF}?shape-case=whitespace-agent`))
        .rejects.toThrow(/non-empty "agent"/);
    } finally {
      await restoreValidSidecar();
    }
  });

  it("rejects a sidecar that is not a JSON object", async () => {
    await writeFile(PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, `${JSON.stringify(["not", "an", "object"])}\n`);
    try {
      await expect(import(`${MODULE_HREF}?shape-case=not-an-object`))
        .rejects.toThrow(/must contain a JSON object/);
    } finally {
      await restoreValidSidecar();
    }
  });

  it("rejects a sidecar that is not valid JSON", async () => {
    await writeFile(PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, "not json at all");
    try {
      await expect(import(`${MODULE_HREF}?shape-case=not-json`))
        .rejects.toThrow(/is not valid UTF-8 JSON/);
    } finally {
      await restoreValidSidecar();
    }
  });
});

// --- #41: the REAL native provisioner must stage the evaluation context ---------------
//
// Round 25 of the DR-2026-08-05 gate got the harness all the way into the grade for the
// first time and it refused in 0.4s, exit 70:
//   EvaluationOperationalError: the evaluation context carries no resolutionSnapshot
// The staged `input/` held `admission-receipt, delivery, dispatch-context.json,
// evaluation-spec.json, prediction, task, task.sealed` -- no context file. The harness
// reads `input/evaluation-context.json` OPTIONALLY (`runtime.ts`'s `optionalContext`
// swallows ENOENT and returns `{}`), so the absence produced no staging error and no
// input error; it surfaced one layer later as an adapter operational failure carrying a
// retry advisory, which is the wrong diagnosis for a deterministic input gap.
//
// These tests drive the PRODUCTION `native-evaluation-dir-v1` provisioner -- the same
// object `buildNativeEvaluatorComposition` hands the backend -- against a real durable
// evaluation aggregate, and then feed the resulting workspace to the SAME
// `contextResolutionSnapshotSource()` the shipped deployment wires. Delete the staging
// and the first test reproduces the live message verbatim.
describe("production prediction-market deployment module — native provisioner stages the evaluation context (#41)", () => {
  function stagedArtifact(name: string, bytes: Uint8Array) {
    return { name, bytes, digest: documentDigest(bytes) };
  }

  async function durablePredictionEvaluation(
    state: NativeEvaluatorStateRepository,
    docs: PredictionDocuments,
  ): Promise<{ readonly attemptUri: string; readonly evaluationTask: Uint8Array }> {
    const subject = {
      task: stagedArtifact("subject-task.json", docs.subjectTask),
      submission: stagedArtifact("submission", new TextEncoder().encode("context-fixture-submission")),
      requesterEnvelope: stagedArtifact("requester-envelope", new TextEncoder().encode("context-fixture-envelope")),
      admissionReceipt: stagedArtifact("admission-receipt", new TextEncoder().encode("context-fixture-receipt")),
      delivery: stagedArtifact("subject-delivery.json", docs.subjectDelivery),
      deliveryEnvelope: stagedArtifact("delivery-envelope", new TextEncoder().encode("context-fixture-delivery-envelope")),
      evidenceRecords: [stagedArtifact("solution-evidence", new TextEncoder().encode("context-fixture-evidence"))],
      results: [stagedArtifact("result.json", docs.subjectResult)],
      evaluationSpec: stagedArtifact("evaluation-spec.json", docs.specificationBytes),
    };
    const admitted = state.admitOpportunity({
      opportunity: {
        source: "https://solver.example/context-fixture-source",
        sourceSequence: "0000000000000002",
        sourceEntryDigest: `sha256:${"a".repeat(64)}`,
        canonical: true,
        finality: "finalized",
        chainId: 84532,
        taskId: 41n,
        attemptIndex: 1,
        solutionRequestId: `0x${"b".repeat(64)}`,
        operatorAddress: `0x${"1".repeat(40)}`,
        deliveryCid: "bafycontextfixture",
        advertisedDeliveryDigest: subject.delivery.digest,
        blockHash: `0x${"c".repeat(64)}`,
        blockNumber: 410n,
        transactionHash: `0x${"d".repeat(64)}`,
        logIndex: 1,
        canonicalEventIdentity: `84532:0x${"c".repeat(64)}:1`,
      },
      evaluatorAgent: AGENT,
      coordinator: COORDINATOR,
      material: subject,
    });
    state.recordAdmissionVerified(admitted.evaluationId, {
      requester: { signerKey: "did:key:context-fixture-requester", sealingTime: "2026-08-02T10:00:00Z" },
      admission: { signerKey: "did:key:context-fixture-admission", effectiveTime: "2026-08-02T10:00:00Z" },
      executor: {
        signerKey: "did:key:context-fixture-executor",
        agent: "https://agents.example/context-fixture-solver",
        declarationKey: "did:key:context-fixture-solver-declaration",
        effectiveTime: "2026-08-02T10:30:00Z",
        address: `0x${"1".repeat(40)}`,
      },
      evaluator: {
        signerKey: "did:key:context-fixture-evaluator",
        agent: AGENT,
        declarationKey: "did:key:context-fixture-evaluator-declaration",
        address: EVALUATOR_ADDRESS,
      },
      verificationDigest: `sha256:${"e".repeat(64)}`,
    });
    const submissionBytes = sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: "urn:uuid:00000000-0000-4000-8000-000000000041",
      task: { digest: { sha256: documentDigest(docs.evaluationTask).slice("sha256:".length) } },
      requester: AGENT,
      idempotencyKey: admitted.evaluationId,
      nonce: admitted.evaluationId,
      deadline: "2026-08-03T00:00:00.000Z",
    });
    state.recordDerivedEvaluation(admitted.evaluationId, {
      taskBytes: docs.evaluationTask,
      taskDigest: documentDigest(docs.evaluationTask),
      submissionBytes,
      submissionDigest: documentDigest(submissionBytes),
      submissionUri: "urn:uuid:00000000-0000-4000-8000-000000000041",
    });
    const claim = state.beginEvaluationClaim(admitted.evaluationId, `0x${"f".repeat(64)}`);
    state.recordEvaluationClaimFinalized(claim.operationId, {
      txHash: `0x${"1".repeat(64)}`,
      blockHash: `0x${"2".repeat(64)}`,
      blockNumber: 411n,
      requestId: `0x${"9".repeat(64)}`,
      verdictIndex: 1,
      evaluatorAddress: EVALUATOR_ADDRESS,
    });
    const attemptUri = state.getEvaluation(admitted.evaluationId)!.evaluationAttemptUri!;
    expect(attemptUri).toBeTruthy();
    return { attemptUri, evaluationTask: docs.evaluationTask };
  }

  async function workspace(): Promise<WorkspacePaths> {
    const root = await mkdtemp(join(tmpdir(), "jinn-native-provisioner-context-"));
    roots.push(root);
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
    } as WorkspacePaths;
  }

  function viewFor(evaluationTask: Uint8Array) {
    const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evaluationTask)) as {
      readonly inputs?: readonly unknown[];
    };
    return {
      task: { inputs: document.inputs ?? [] },
      effectiveRequirements: {},
      profile: { profile: "https://spec.jinn.network/task-profiles/evaluation-task/1.0" },
    } as never;
  }

  it("stages input/evaluation-context.json, so the shipped resolution-snapshot source resolves instead of refusing", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    try {
      const docs = predictionDocuments();
      const durable = await durablePredictionEvaluation(value.config.state, docs);
      const selected = value.backendConfigs[0]!.provisioner({
        attempt: { attemptUri: durable.attemptUri, nonce: "context-fixture-nonce", attemptNumber: 1 },
        sealedTaskBytes: durable.evaluationTask,
        dispatchContextBytes: new TextEncoder().encode("{}"),
      } as unknown as LocalProvisionerInput);
      expect(selected.id).toBe("native-evaluation-dir-v1");

      const paths = await workspace();
      try {
        await selected.contract.setup(viewFor(durable.evaluationTask), paths, []);
      } finally {
        // `sealInputAndSnapshot` locks `input/` to 0o500, which is exactly right in production and
        // makes the suite's `rm -rf` cleanup fail with EACCES. Unlock it as soon as the assertions
        // can still see the sealed result (the mode itself is the dir-provisioner's own contract,
        // covered in its own suite).
        await chmod(paths.input, 0o700);
      }

      // What the live round-25 workspace was missing. Read exactly the way the harness runtime
      // reads it -- `optionalContext` swallows ENOENT and yields `{}` -- so that removing the
      // staging reproduces the live refusal here rather than a bland "file missing" assertion.
      const contextPath = join(paths.input, EVALUATION_CONTEXT_INPUT_NAME);
      const context = existsSync(contextPath)
        ? JSON.parse(await readFile(contextPath, "utf8")) as Record<string, unknown>
        : {};

      // The exact call that threw at `prediction/adapter.ts:100` on 2026-08-12. With no staged
      // file this rejects with "the evaluation context carries no resolutionSnapshot"; with it,
      // the grade proceeds.
      const inputs = await contextResolutionSnapshotSource().read({ context } as never);
      expect(existsSync(contextPath)).toBe(true);
      expect(context).toEqual(derivePredictionEvaluationContext(docs.subjectTask));
      expect(inputs.market.marketId).toBe("market-spawn-1");
      expect(inputs.consensusProbabilityYes).toBe("0.500000");
      expect(inputs.window).toEqual({
        startTs: Date.parse("2026-07-29T12:00:00Z"),
        endTs: Date.parse("2026-07-29T12:01:00Z"),
      });

      // And the graded outcome the whole staging exists to produce: every integrity check
      // passes, the market is honestly unresolved, so the verdict is `inconclusive` -- which
      // settles as the decision-grade `VerdictCode.Unresolved(4)`.
      const outcome = parsePredictionResult({
        resultBytes: docs.subjectResult,
        snapshot: inputs.snapshot,
        market: inputs.market,
        window: inputs.window,
        consensusProbabilityYes: inputs.consensusProbabilityYes,
      });
      expect(outcome.integrity).toBe(true);
      expect(outcome.resolved).toBe(false);
      expect(outcome.verdict).toBe("inconclusive");
    } finally {
      await composition.close();
      value.store.close();
    }
  });

  it("refuses the Attempt with the exact field at fault when the subject Task carries no forecast payload", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    try {
      const docs = predictionDocuments();
      // Same evaluation in every respect except the subject Task, which is a well-formed sealed
      // Task with no `payload.forecast`. Nothing verified carries a market, so no context can be
      // derived -- and the refusal must name that, not degrade into an empty context.
      const forecastless = sealTask({
        protocol: "https://spec.jinn.network/profiles/task-execution/v1",
        profile: {
          uri: "https://spec.jinn.network/task-profiles/prediction-forecast/1.0",
          digest: { sha256: "4".repeat(64) },
        },
        payload: { question: "Will the forecastless fixture resolve?" },
        instructions: "Submit a prediction.",
        outputs: [{ name: "result.json", mediaType: "application/json", required: true }],
      });
      const durable = await durablePredictionEvaluation(
        value.config.state,
        { ...docs, subjectTask: forecastless },
      );
      expect(() => value.backendConfigs[0]!.provisioner({
        attempt: { attemptUri: durable.attemptUri, nonce: "context-fixture-nonce", attemptNumber: 1 },
        sealedTaskBytes: durable.evaluationTask,
        dispatchContextBytes: new TextEncoder().encode("{}"),
      } as unknown as LocalProvisionerInput))
        .toThrow(/subject Task payload carries no forecast object/);
    } finally {
      await composition.close();
      value.store.close();
    }
  });
});
