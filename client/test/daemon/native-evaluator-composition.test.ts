import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BindingResolver, ResolvedBinding } from "@jinn-network/trust-core";
import {
  buildEvaluationTaskProfile,
  sealTaskProfile,
} from "@jinn-network/task-execution-profiles";
import { documentDigest } from "@jinn-network/task-execution-protocol";
import type {
  LocalTaskExecutionBackend,
  LocalTaskExecutionBackendConfig,
} from "@jinn-network/task-execution-backend-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../src/store/store.js";
import { NativeEvaluatorStateRepository } from "../../src/daemon/native-evaluator-state.js";
import {
  buildNativeEvaluatorComposition,
  type NativeEvaluatorCompositionInput,
} from "../../src/daemon/native-evaluator-composition.js";
import { openRoleIdentitySet } from "../../src/daemon/role-identities.js";

const AGENT = "urn:jinn:evaluator:golden";
const EVALUATOR_ADDRESS = `0x${"2".repeat(40)}` as const;
const COORDINATOR = `0x${"3".repeat(40)}` as const;
const METHOD_DIGEST = `sha256:${"6".repeat(64)}` as const;
const roots: string[] = [];

afterEach(async () => {
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

async function fixture(input: { readonly evaluator?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jinn-native-evaluator-composition-"));
  roots.push(root);
  const resolver: BindingResolver = {
    resolveBinding: vi.fn(async (query) => binding(query.key)),
  };
  const roles = await openRoleIdentitySet({
    storePath: join(root, "identity", "roles.enc.json"),
    password: "operator-password",
    agent: AGENT,
    bindingResolver: resolver,
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
  const modulePath = join(root, "prediction-evaluator-deployment.mjs");
  const moduleBytes = new TextEncoder().encode(`
export const evaluationHarnessDeployment = {
  registrations: [{
    registrationId: "prediction-market",
    adapter: { async evaluate() { throw new Error("not executed by composition test"); } },
    evaluationMethod: { name: "prediction-golden", digest: { sha256: "${"6".repeat(64)}" } },
    specificationCompatibility() { return true; },
    evaluatorIdentity: { id: ${JSON.stringify(input.evaluator ?? AGENT)} },
    signer: { handle: "evaluator.pem" },
    outcomeValidator(value) { return value; },
    interruptionBehavior: "repeatable",
  }],
  parserAllowlist: new Set(["prediction-golden-parser"]),
  evidenceWriter: { async putClaimEvidence() { throw new Error("configured repository unavailable in unit test"); } },
  maxClaimEvidenceBytes: 4096,
};
`);
  await writeFile(modulePath, moduleBytes);
  const evaluationProfile = buildEvaluationTaskProfile();
  const profileDigest = sealTaskProfile(evaluationProfile).digest;
  const store = new Store(":memory:");
  const state = new NativeEvaluatorStateRepository(store, {
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
  const backendConfigs: LocalTaskExecutionBackendConfig[] = [];
  const lifecycle: string[] = [];
  const backend = {
    shutdown: vi.fn(async () => { lifecycle.push("backend"); }),
    getDeliverySignature: vi.fn(),
  } as unknown as LocalTaskExecutionBackend;
  const evidence = {
    repository: {
      capabilities: {},
      putRecord: vi.fn(), getRecord: vi.fn(), putArtifact: vi.fn(), getArtifact: vi.fn(),
    },
    catalog: {},
    awaitIndexed: vi.fn(),
  } as unknown as NativeEvaluatorCompositionInput["backend"]["evidence"];
  const opportunityRead = vi.fn(async () => []);
  const config: NativeEvaluatorCompositionInput = {
    roles,
    state,
    coordinatorAddress: COORDINATOR,
    evaluatorAddress: EVALUATOR_ADDRESS,
    operatorIdentity: {
      safeAddress: EVALUATOR_ADDRESS,
      agentEoa: `0x${"4".repeat(40)}`,
      agentIri: AGENT,
    },
    deployment: {
      module: pathToFileURL(modulePath).href,
      moduleDigest: documentDigest(moduleBytes),
      signerHandle: "evaluator.pem",
      evaluationMethodDigest: METHOD_DIGEST,
    },
    backend: {
      stateRoot: join(root, "backend"),
      source: "urn:jinn:evaluator-backend:golden",
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
      sourceId: "urn:jinn:solver:golden/solver-records",
      read: opportunityRead,
    },
    subject: { fetcher: { byCid: vi.fn(), byDigest: vi.fn() } },
    authority: { claim: vi.fn(), dependencies: {} as never },
    deadline: () => "2026-08-03T00:00:00.000Z",
    verdictPorts: {} as never,
    chain: {} as never,
    verification: {} as never,
    constructBackend(backendConfig) {
      backendConfigs.push(backendConfig);
      return backend;
    },
  };
  return { root, store, state, roles, config, backend, backendConfigs, opportunityRead, lifecycle };
}

describe("native evaluator production composition", () => {
  it("selects evaluator custody and the exact prediction deployment without solver runtime fallbacks", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    const config = value.backendConfigs[0]!;
    expect(config.launchers).toHaveLength(1);
    expect(config.launchers[0]!.capabilities().taskProfiles).toEqual([
      "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
    ]);
    expect(config.launchers[0]!.capabilities().hostSecretForwards).toEqual([]);
    expect(config.trustKeys?.deliverySigningKey?.keyId)
      .toBe(value.roles.get("evaluator-verdict").keyId);
    expect(config.trustKeys?.deliverySigningKey?.keyId)
      .not.toBe(value.roles.get("solver-delivery").keyId);
    expect(config.hostSecretResolver).toBeUndefined();
    expect(config.capabilityGrants).toBeUndefined();
    expect(config.secretForwardResolver).toBeUndefined();
    expect(config.deliveryExtensions).toBeUndefined();
    expect(composition.publisher.sourceId).toBe(`${AGENT}/evaluator-records`);
    await expect(composition.tick()).resolves.toEqual({ sourceEvents: 0, coordinator: [] });
    expect(value.opportunityRead).toHaveBeenCalledWith({});
    await composition.close();
    value.store.close();
  });

  it("refuses a deployment whose evaluator identity or module digest differs from trusted configuration", async () => {
    const wrongAgent = await fixture({ evaluator: "urn:jinn:evaluator:other" });
    await expect(buildNativeEvaluatorComposition(wrongAgent.config))
      .rejects.toThrow(/different persistent agent/);
    expect(wrongAgent.backendConfigs).toEqual([]);
    wrongAgent.store.close();

    const wrongDigest = await fixture();
    await expect(buildNativeEvaluatorComposition({
      ...wrongDigest.config,
      deployment: { ...wrongDigest.config.deployment, moduleDigest: `sha256:${"0".repeat(64)}` },
    })).rejects.toThrow(/module digest mismatch/);
    expect(wrongDigest.backendConfigs).toEqual([]);
    wrongDigest.store.close();
  });

  it("recovers durable evaluator work before source sync and drains secret-owning backend before source close", async () => {
    const value = await fixture();
    value.config.opportunities.read = vi.fn(async () => { throw new Error("source unavailable"); });
    const composition = await buildNativeEvaluatorComposition(value.config);
    const order: string[] = [];
    vi.spyOn(composition.coordinator, "reconcileStartup").mockImplementation(async () => {
      order.push("recover");
      return [{ kind: "verdict-settlement-pending" }];
    });
    value.config.opportunities.read = vi.fn(async () => {
      order.push("source");
      throw new Error("source unavailable");
    });
    await expect(composition.tick()).rejects.toThrow(/source unavailable/);
    expect(order).toEqual(["recover", "source"]);

    const originalPublisherClose = composition.publisher.close.bind(composition.publisher);
    composition.publisher.close = async () => {
      value.lifecycle.push("publisher");
      await originalPublisherClose();
    };
    await composition.close();
    expect(value.lifecycle).toEqual(["backend", "publisher"]);
    value.store.close();
  });
});
