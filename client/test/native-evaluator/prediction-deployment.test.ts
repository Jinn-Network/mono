import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BindingResolver, ResolvedBinding } from "@jinn-network/trust-core";
import {
  buildEvaluationTaskProfile,
  sealTaskProfile,
} from "@jinn-network/task-execution-profiles";
import type {
  LocalTaskExecutionBackend,
  LocalTaskExecutionBackendConfig,
} from "@jinn-network/task-execution-backend-local";
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
  PREDICTION_EVALUATOR_METHOD_DESCRIPTOR_PATH,
  predictionEvaluatorMethodDigest,
  predictionEvaluatorModuleDigest,
} from "../../src/native-evaluator/deployment-paths.js";

const AGENT = "urn:jinn:evaluator:prediction-deployment-fixture";
const OTHER_AGENT = "urn:jinn:evaluator:prediction-deployment-fixture-other";
const EVALUATOR_ADDRESS = `0x${"2".repeat(40)}` as const;
const COORDINATOR = `0x${"3".repeat(40)}` as const;
const SIGNER_HANDLE = "prediction-market-evaluator-verdict";
const roots: string[] = [];

beforeAll(async () => {
  const claimEvidenceRoot = await mkdtemp(join(tmpdir(), "jinn-prediction-deployment-evidence-"));
  roots.push(claimEvidenceRoot);
  // Read before the module's first (and only, per resolved-URL cache) dynamic import.
  process.env["JINN_NATIVE_EVALUATOR_AGENT"] = AGENT;
  process.env["JINN_NATIVE_EVALUATOR_CLAIM_EVIDENCE_DIR"] = claimEvidenceRoot;
});

afterAll(async () => {
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

  it("refuses an operator agent that does not equal the module's JINN_NATIVE_EVALUATOR_AGENT identity", async () => {
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
    const claimEvidenceRoot = process.env["JINN_NATIVE_EVALUATOR_CLAIM_EVIDENCE_DIR"]!;
    const module = await import(pathToFileURL(PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH).href) as {
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

  it("declares the fixed registrationId, signerHandle, and evaluation method uri", async () => {
    const module = await import(pathToFileURL(PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH).href) as {
      readonly evaluationHarnessDeployment: {
        readonly registrations: readonly {
          readonly registrationId: string;
          readonly signer: { readonly handle: string };
          readonly evaluationMethod: { readonly uri?: string; readonly digest: { readonly sha256: string } };
        }[];
      };
    };
    expect(module.evaluationHarnessDeployment.registrations).toHaveLength(1);
    const [registration] = module.evaluationHarnessDeployment.registrations;
    expect(registration!.registrationId).toBe("prediction-market");
    expect(registration!.signer.handle).toBe(SIGNER_HANDLE);
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
