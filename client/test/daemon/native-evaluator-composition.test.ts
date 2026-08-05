import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BindingResolver, ResolvedBinding } from "@jinn-network/trust-core";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVALUATION_TASK_PROFILE_URI,
  EVAL_SEMANTICS_VERSION,
  buildEvaluationTaskProfile,
  sealEvaluationSpec,
  sealTaskProfile,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  PREDICTION_PARSER,
  SWE_REBENCH_PARSER,
  predictionEvaluationSpecMeasurements,
  predictionEvaluationSpecVerdictRule,
} from "@jinn-network/task-execution-evaluator-adapters";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
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

/**
 * One inline registration literal in the shape a deployment module exports. `compatibleWith`
 * is a source-level predicate body so a multi-registration module can discriminate on the
 * EvaluationSpec the composition resolves for it.
 */
function registrationSource(input: {
  readonly registrationId: string;
  readonly evaluator: string;
  readonly methodSha256: string;
  readonly methodUri?: string;
  readonly compatibleWith?: string;
  readonly signerHandle?: string;
  readonly interruptionBehavior?: string;
}): string {
  return `{
    registrationId: ${JSON.stringify(input.registrationId)},
    adapter: { async evaluate() { throw new Error("not executed by composition test"); } },
    evaluationMethod: {
      name: ${JSON.stringify(`${input.registrationId}-golden`)},
      ${input.methodUri === undefined ? "" : `uri: ${JSON.stringify(input.methodUri)},`}
      digest: { sha256: ${JSON.stringify(input.methodSha256)} },
    },
    specificationCompatibility(specification) { return ${input.compatibleWith ?? "true"}; },
    evaluatorIdentity: { id: ${JSON.stringify(input.evaluator)} },
    signer: { handle: ${JSON.stringify(input.signerHandle ?? "evaluator.pem")} },
    outcomeValidator(value) { return value; },
    interruptionBehavior: ${JSON.stringify(input.interruptionBehavior ?? "repeatable")},
  }`;
}

function deploymentSource(registrations: readonly string[], parserAllowlist: readonly string[]): string {
  return `
export const evaluationHarnessDeployment = {
  registrations: [${registrations.join(",\n")}],
  parserAllowlist: new Set(${JSON.stringify(parserAllowlist)}),
  evidenceWriter: { async putClaimEvidence() { throw new Error("configured repository unavailable in unit test"); } },
  maxClaimEvidenceBytes: 4096,
};
`;
}

async function fixture(input: {
  readonly evaluator?: string;
  /** Replaces the default single prediction-market registration set. */
  readonly registrations?: readonly string[];
} = {}) {
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
  const moduleBytes = new TextEncoder().encode(deploymentSource(
    input.registrations ?? [registrationSource({
      registrationId: "prediction-market",
      evaluator: input.evaluator ?? AGENT,
      methodSha256: "6".repeat(64),
    })],
    ["prediction-golden-parser"],
  ));
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

// --- registration-set selection + host grader-source injection (one-swap P0-5) ---------

const SWE_METHOD_SHA256 = "7".repeat(64);
const PREDICTION_METHOD_URI = "https://spec.jinn.network/evaluation-methods/prediction-market/v1";
const SWE_METHOD_URI = "https://spec.jinn.network/evaluation-methods/swe-rebench/v2";

/** A grader source the host owns; the composition never calls it, the spawned harness would. */
const fakeGraderReportSource = {
  async read() {
    throw new Error("fake grader runtime is never read by the composition itself");
  },
};

function predictionRegistrationSource(evaluator = AGENT): string {
  return registrationSource({
    registrationId: "prediction-market",
    evaluator,
    methodSha256: "6".repeat(64),
    methodUri: PREDICTION_METHOD_URI,
    compatibleWith: `specification.familyBlock.parser.id === ${JSON.stringify(PREDICTION_PARSER.id)}`,
  });
}

function sweRebenchRegistrationSource(evaluator = AGENT): string {
  return registrationSource({
    registrationId: "swe-rebench-v2",
    evaluator,
    methodSha256: SWE_METHOD_SHA256,
    methodUri: SWE_METHOD_URI,
    compatibleWith: `specification.familyBlock.parser.id === ${JSON.stringify(SWE_REBENCH_PARSER.id)}`,
  });
}

function specificationFor(parser: typeof PREDICTION_PARSER): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: parser.id,
      digest: { sha256: parser.digest.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      image: { name: "registration-set-image", digest: { sha256: "b".repeat(64) } },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [],
      parser,
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    },
    measurements: predictionEvaluationSpecMeasurements(),
    verdictRule: predictionEvaluationSpecVerdictRule(),
    unscorable: [],
    evidenceConventions: { requiredRefs: [] },
  } as EvaluationSpec;
}

/**
 * Publishes one durable EvaluationSpec artifact through the state repository the composition
 * reads, so the launcher's selector resolves the spec exactly as production would.
 */
function publishDurableSpecification(
  state: NativeEvaluatorStateRepository,
  specification: EvaluationSpec,
): `sha256:${string}` {
  const sealed = sealEvaluationSpec(specification);
  vi.spyOn(state, "listEvaluations").mockReturnValue([
    { evaluationId: "evaluation-1" } as never,
  ]);
  vi.spyOn(state, "listSubjectArtifacts").mockReturnValue([
    {
      role: "evaluation-spec",
      name: "evaluation-spec.json",
      digest: sealed.digest,
      bytes: sealed.bytes,
    } as never,
  ]);
  return sealed.digest;
}

function evaluationTaskView(evaluationSpecDigest: `sha256:${string}`): TaskView {
  return {
    task: {
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: { uri: EVALUATION_TASK_PROFILE_URI, digest: { sha256: "c".repeat(64) } },
      instructions: "evaluate",
      payload: { evaluationSpec: evaluationSpecDigest },
      outputs: [],
    },
    effectiveRequirements: {},
    profile: { profile: EVALUATION_TASK_PROFILE_URI },
  } as unknown as TaskView;
}

function planFor(
  config: LocalTaskExecutionBackendConfig,
  evaluationSpecDigest: `sha256:${string}`,
): string {
  const plan = config.launchers[0]!.plan(
    evaluationTaskView(evaluationSpecDigest),
    {
      root: "/tmp/attempt", input: "/tmp/attempt/input", work: "/tmp/attempt/work",
      out: "/tmp/attempt/out", logs: "/tmp/attempt/logs", tmp: "/tmp/attempt/tmp",
      harnessState: "/tmp/attempt/harness-state", secrets: "/tmp/attempt/secrets",
      meta: "/tmp/attempt/meta",
    } as unknown as WorkspacePaths,
    {} as unknown as AttemptIdentity,
  );
  return plan.env!["JINN_ATTEMPT_EVALUATOR_REGISTRATION"]!;
}

describe("native evaluator registration-set selection", () => {
  it("loads a multi-registration deployment and selects per evaluation method", async () => {
    const value = await fixture({
      registrations: [predictionRegistrationSource(), sweRebenchRegistrationSource()],
    });
    const composition = await buildNativeEvaluatorComposition({
      ...value.config,
      deployment: {
        ...value.config.deployment,
        evaluationMethodDigest: {
          "prediction-market": METHOD_DIGEST,
          "swe-rebench-v2": `sha256:${SWE_METHOD_SHA256}`,
        },
      },
      graderReportSources: { "swe-rebench-v2": fakeGraderReportSource },
    });
    const config = value.backendConfigs[0]!;
    expect(config.launchers).toHaveLength(1);

    const predictionDigest = publishDurableSpecification(value.state, specificationFor(PREDICTION_PARSER));
    expect(planFor(config, predictionDigest)).toBe("prediction-market");

    const sweDigest = publishDurableSpecification(value.state, specificationFor(SWE_REBENCH_PARSER));
    expect(planFor(config, sweDigest)).toBe("swe-rebench-v2");

    await composition.close();
    value.store.close();
  });

  it("accepts a deployment-owned grader source without substituting the module's adapter", async () => {
    const value = await fixture({ registrations: [sweRebenchRegistrationSource()] });
    const composition = await buildNativeEvaluatorComposition({
      ...value.config,
      deployment: {
        ...value.config.deployment,
        evaluationMethodDigest: `sha256:${SWE_METHOD_SHA256}`,
      },
      graderReportSources: { [SWE_METHOD_URI]: "deployment-owned" },
    });
    expect(value.backendConfigs).toHaveLength(1);
    await composition.close();
    value.store.close();
  });

  it("refuses a container-graded registration with no host grader report source", async () => {
    const value = await fixture({ registrations: [sweRebenchRegistrationSource()] });
    await expect(buildNativeEvaluatorComposition({
      ...value.config,
      deployment: {
        ...value.config.deployment,
        evaluationMethodDigest: `sha256:${SWE_METHOD_SHA256}`,
      },
    })).rejects.toThrow(/container-graded evaluator registration "swe-rebench-v2" has no host grader report source/);
    expect(value.backendConfigs).toEqual([]);
    value.store.close();
  });

  it("refuses a grader report source aimed at a non-container-graded or undeclared registration", async () => {
    const wrongMethod = await fixture();
    await expect(buildNativeEvaluatorComposition({
      ...wrongMethod.config,
      graderReportSources: { "prediction-market": fakeGraderReportSource },
    })).rejects.toThrow(/is not container-graded and takes no host grader report source/);
    expect(wrongMethod.backendConfigs).toEqual([]);
    wrongMethod.store.close();

    const unknownKey = await fixture();
    await expect(buildNativeEvaluatorComposition({
      ...unknownKey.config,
      graderReportSources: { "swe-rebench-v2": fakeGraderReportSource },
    })).rejects.toThrow(/names no registration this evaluator deployment declares/);
    expect(unknownKey.backendConfigs).toEqual([]);
    unknownKey.store.close();
  });

  it("refuses an empty, duplicated, or host-unrecognized registration set", async () => {
    const empty = await fixture({ registrations: [] });
    await expect(buildNativeEvaluatorComposition(empty.config))
      .rejects.toThrow(/declares no evaluator registration/);
    expect(empty.backendConfigs).toEqual([]);
    empty.store.close();

    const duplicated = await fixture({
      registrations: [predictionRegistrationSource(), predictionRegistrationSource()],
    });
    await expect(buildNativeEvaluatorComposition(duplicated.config))
      .rejects.toThrow(/declares registration "prediction-market" more than once/);
    expect(duplicated.backendConfigs).toEqual([]);
    duplicated.store.close();

    const unknown = await fixture({
      registrations: [registrationSource({
        registrationId: "llm-judge-v9",
        evaluator: AGENT,
        methodSha256: "6".repeat(64),
      })],
    });
    await expect(buildNativeEvaluatorComposition(unknown.config))
      .rejects.toThrow(/"llm-judge-v9" is not a host-recognized evaluation method/);
    expect(unknown.backendConfigs).toEqual([]);
    unknown.store.close();
  });

  it("refuses a per-registration method digest map that does not cover the exact set", async () => {
    const missing = await fixture({
      registrations: [predictionRegistrationSource(), sweRebenchRegistrationSource()],
    });
    await expect(buildNativeEvaluatorComposition({
      ...missing.config,
      deployment: {
        ...missing.config.deployment,
        evaluationMethodDigest: { "prediction-market": METHOD_DIGEST },
      },
      graderReportSources: { "swe-rebench-v2": fakeGraderReportSource },
    })).rejects.toThrow(/declares no evaluation-method digest for registration "swe-rebench-v2"/);
    expect(missing.backendConfigs).toEqual([]);
    missing.store.close();

    const extra = await fixture();
    await expect(buildNativeEvaluatorComposition({
      ...extra.config,
      deployment: {
        ...extra.config.deployment,
        evaluationMethodDigest: {
          "prediction-market": METHOD_DIGEST,
          "swe-rebench-v2": `sha256:${SWE_METHOD_SHA256}`,
        },
      },
    })).rejects.toThrow(/evaluation-method digest for unregistered "swe-rebench-v2"/);
    expect(extra.backendConfigs).toEqual([]);
    extra.store.close();
  });

  it("keeps the single-registration deployment selecting without reading durable state", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    const config = value.backendConfigs[0]!;
    const listEvaluations = vi.spyOn(value.state, "listEvaluations");
    // A one-registration deployment resolves to its only registration; it never consults the
    // durable EvaluationSpec, so an unresolvable payload digest is still plannable.
    expect(planFor(config, `sha256:${"9".repeat(64)}`)).toBe("prediction-market");
    expect(listEvaluations).not.toHaveBeenCalled();
    await composition.close();
    value.store.close();
  });
});

describe("native evaluator sealed-Submission provisioner", () => {
  it("still refuses any capability grant on an evaluator-sealed Submission", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    const config = value.backendConfigs[0]!;
    const sealedTaskBytes = new TextEncoder().encode(JSON.stringify({ evaluation: "task" }));
    const specification = sealEvaluationSpec(specificationFor(PREDICTION_PARSER));
    const submissionBytes = new TextEncoder().encode(JSON.stringify({ submission: "record" }));
    vi.spyOn(value.state, "listEvaluations").mockReturnValue([
      { evaluationId: "evaluation-1", evaluationAttemptUri: "urn:uuid:attempt", state: "evaluating" } as never,
    ]);
    vi.spyOn(value.state, "getDerivedEvaluation").mockReturnValue({
      attemptUri: "urn:uuid:attempt",
      taskBytes: sealedTaskBytes,
      taskDigest: documentDigest(sealedTaskBytes),
      submissionBytes,
      submissionDigest: documentDigest(submissionBytes),
    } as never);
    vi.spyOn(value.state, "listSubjectArtifacts").mockReturnValue([
      {
        role: "evaluation-spec",
        name: "evaluation-spec.json",
        digest: specification.digest,
        bytes: specification.bytes,
      } as never,
    ]);
    const selected = config.provisioner({
      sealedTaskBytes,
      dispatchContextBytes: new Uint8Array(),
      attempt: { attemptUri: "urn:uuid:attempt" },
    } as never);
    await expect(selected.contract.setup(
      {} as never,
      {} as never,
      [{ handle: "anything" }] as never,
    )).rejects.toThrow(/evaluator-sealed Submission must remain grant-free/);
    await composition.close();
    value.store.close();
  });
});
