import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDsseEnvelope, type BindingResolver, type ResolvedBinding } from "@jinn-network/trust-core";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVALUATION_TASK_PROFILE_URI,
  EVAL_SEMANTICS_VERSION,
  VERDICT_DSSE_PAYLOAD_TYPE,
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
import { documentDigest, sealSubmission } from "@jinn-network/task-execution-protocol";
import { buildResultEvaluationPayload } from "@jinn-network/attestation-issuer";
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
      // Every scope a native role can require, including the announce-plane scope the three
      // `*-discovery` roles gained in issue #2525 and the admission-receipt scope the `admission`
      // role gained in #33 — a "grants everything" binding must grant them.
      scope: ["authorizations", "observations", "deliveries", "verdicts", "settlements",
        "jinn:discovery-announcements", "https://spec.jinn.network/trust-scopes/admission-receipts/v1"],
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

  it("composes a container-graded registration bound deployment-owned, keyed by method URI", async () => {
    const value = await fixture({ registrations: [sweRebenchRegistrationSource()] });
    const composition = await buildNativeEvaluatorComposition({
      ...value.config,
      deployment: {
        ...value.config.deployment,
        evaluationMethodDigest: `sha256:${SWE_METHOD_SHA256}`,
      },
      graderReportSources: { [SWE_METHOD_URI]: "deployment-owned" },
    });
    // The container-graded registration reached the launcher's configured set: it plans, and
    // it plans as itself. (Whether the module's own adapter object survived is not observable
    // from here -- the launcher exposes no registration handle.)
    expect(value.backendConfigs).toHaveLength(1);
    expect(planFor(value.backendConfigs[0]!, `sha256:${"9".repeat(64)}`)).toBe("swe-rebench-v2");
    await composition.close();
    value.store.close();
  });

  it("refuses a registration double-keyed with conflicting grader report sources", async () => {
    const value = await fixture({ registrations: [sweRebenchRegistrationSource()] });
    await expect(buildNativeEvaluatorComposition({
      ...value.config,
      deployment: {
        ...value.config.deployment,
        evaluationMethodDigest: `sha256:${SWE_METHOD_SHA256}`,
      },
      graderReportSources: {
        "swe-rebench-v2": fakeGraderReportSource,
        [SWE_METHOD_URI]: "deployment-owned",
      },
    })).rejects.toThrow(/has conflicting grader report sources keyed by "swe-rebench-v2" and/);
    expect(value.backendConfigs).toEqual([]);
    value.store.close();
  });

  it("accepts the same binding supplied under both the id and the method URI", async () => {
    const value = await fixture({ registrations: [sweRebenchRegistrationSource()] });
    const composition = await buildNativeEvaluatorComposition({
      ...value.config,
      deployment: {
        ...value.config.deployment,
        evaluationMethodDigest: `sha256:${SWE_METHOD_SHA256}`,
      },
      graderReportSources: {
        "swe-rebench-v2": fakeGraderReportSource,
        [SWE_METHOD_URI]: fakeGraderReportSource,
      },
    });
    expect(value.backendConfigs).toHaveLength(1);
    await composition.close();
    value.store.close();
  });

  it("refuses an ambiguous, unmatched, or unresolvable registration selection", async () => {
    const ambiguous = await fixture({
      registrations: [
        registrationSource({
          registrationId: "prediction-market", evaluator: AGENT,
          methodSha256: "6".repeat(64), methodUri: PREDICTION_METHOD_URI,
        }),
        registrationSource({
          registrationId: "swe-rebench-v2", evaluator: AGENT,
          methodSha256: SWE_METHOD_SHA256, methodUri: SWE_METHOD_URI,
        }),
      ],
    });
    const ambiguousComposition = await buildNativeEvaluatorComposition({
      ...ambiguous.config,
      deployment: {
        ...ambiguous.config.deployment,
        evaluationMethodDigest: {
          "prediction-market": METHOD_DIGEST,
          "swe-rebench-v2": `sha256:${SWE_METHOD_SHA256}`,
        },
      },
      graderReportSources: { "swe-rebench-v2": "deployment-owned" },
    });
    // Both registrations declare `specificationCompatibility() { return true }`.
    const bothDigest = publishDurableSpecification(ambiguous.state, specificationFor(PREDICTION_PARSER));
    expect(() => planFor(ambiguous.backendConfigs[0]!, bothDigest))
      .toThrow(/more than one configured evaluator registration serves/);
    await ambiguousComposition.close();
    ambiguous.store.close();

    const unmatched = await fixture({
      registrations: [
        registrationSource({
          registrationId: "prediction-market", evaluator: AGENT,
          methodSha256: "6".repeat(64), compatibleWith: "false",
        }),
        registrationSource({
          registrationId: "swe-rebench-v2", evaluator: AGENT,
          methodSha256: SWE_METHOD_SHA256, compatibleWith: "false",
        }),
      ],
    });
    const unmatchedComposition = await buildNativeEvaluatorComposition({
      ...unmatched.config,
      deployment: {
        ...unmatched.config.deployment,
        evaluationMethodDigest: {
          "prediction-market": METHOD_DIGEST,
          "swe-rebench-v2": `sha256:${SWE_METHOD_SHA256}`,
        },
      },
      graderReportSources: { "swe-rebench-v2": "deployment-owned" },
    });
    const noneDigest = publishDurableSpecification(unmatched.state, specificationFor(PREDICTION_PARSER));
    expect(() => planFor(unmatched.backendConfigs[0]!, noneDigest))
      .toThrow(/no configured evaluator registration serves/);
    await unmatchedComposition.close();
    unmatched.store.close();

    // Same two-registration deployment, but nothing durable answers the named spec digest.
    const unresolvable = await fixture({
      registrations: [predictionRegistrationSource(), sweRebenchRegistrationSource()],
    });
    const unresolvableComposition = await buildNativeEvaluatorComposition({
      ...unresolvable.config,
      deployment: {
        ...unresolvable.config.deployment,
        evaluationMethodDigest: {
          "prediction-market": METHOD_DIGEST,
          "swe-rebench-v2": `sha256:${SWE_METHOD_SHA256}`,
        },
      },
      graderReportSources: { "swe-rebench-v2": "deployment-owned" },
    });
    expect(() => planFor(unresolvable.backendConfigs[0]!, `sha256:${"9".repeat(64)}`))
      .toThrow(/EvaluationSpec with no durable evaluator artifact/);
    expect(() => planFor(unresolvable.backendConfigs[0]!, "not-a-digest" as `sha256:${string}`))
      .toThrow(/names no canonical EvaluationSpec digest/);
    await unresolvableComposition.close();
    unresolvable.store.close();
  });

  it("refuses a registration set whose members disagree on interruption behavior", async () => {
    const value = await fixture({
      registrations: [
        predictionRegistrationSource(),
        registrationSource({
          registrationId: "swe-rebench-v2",
          evaluator: AGENT,
          methodSha256: SWE_METHOD_SHA256,
          methodUri: SWE_METHOD_URI,
          interruptionBehavior: "recoverable",
        }),
      ],
    });
    await expect(buildNativeEvaluatorComposition({
      ...value.config,
      deployment: {
        ...value.config.deployment,
        evaluationMethodDigest: {
          "prediction-market": METHOD_DIGEST,
          "swe-rebench-v2": `sha256:${SWE_METHOD_SHA256}`,
        },
      },
      graderReportSources: { "swe-rebench-v2": "deployment-owned" },
    })).rejects.toThrow(/ambiguous interruption behavior/);
    expect(value.backendConfigs).toEqual([]);
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

/**
 * A fully admitted, claimed evaluation whose durable `evaluation-spec` artifact carries the exact
 * sealed EvaluationSpec bytes given — the state the harvest guard reads to decide which
 * registration's evaluation method a verdict is allowed to name.
 */
function admittedEvaluation(
  state: NativeEvaluatorStateRepository,
  specification: EvaluationSpec,
) {
  const artifact = (name: string, value: string) => {
    const bytes = new TextEncoder().encode(value);
    return { name, bytes, digest: documentDigest(bytes) };
  };
  const sealedSpecification = sealEvaluationSpec(specification);
  const subject = {
    task: artifact("task", "method-guard-subject-task"),
    submission: artifact("submission", "method-guard-subject-submission"),
    requesterEnvelope: artifact("requester-envelope", "method-guard-requester-envelope"),
    admissionReceipt: artifact("admission-receipt", "method-guard-admission-receipt"),
    delivery: artifact("delivery", "method-guard-solution-delivery"),
    deliveryEnvelope: artifact("delivery-envelope", "method-guard-solution-delivery-envelope"),
    evidenceRecords: [artifact("solution-evidence", "method-guard-solution-evidence")],
    results: [artifact("patch", "method-guard-solution-result")],
    evaluationSpec: {
      name: "evaluation-spec",
      bytes: sealedSpecification.bytes,
      digest: sealedSpecification.digest,
    },
  };
  const admitted = state.admitOpportunity({
    opportunity: {
      source: "https://solver.example/method-guard-source",
      sourceSequence: "0000000000000001",
      sourceEntryDigest: `sha256:${"a".repeat(64)}`,
      canonical: true,
      finality: "finalized",
      chainId: 84532,
      taskId: 9n,
      attemptIndex: 1,
      solutionRequestId: `0x${"b".repeat(64)}`,
      operatorAddress: `0x${"1".repeat(40)}`,
      deliveryCid: "bafymethodguard",
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
  } as never);
  state.recordAdmissionVerified(admitted.evaluationId, {
    requester: { signerKey: "did:key:method-guard-requester", sealingTime: "2026-08-02T10:00:00Z" },
    admission: { signerKey: "did:key:method-guard-admission", effectiveTime: "2026-08-02T10:00:00Z" },
    executor: {
      signerKey: "did:key:method-guard-executor",
      agent: "https://agents.example/method-guard-solver",
      declarationKey: "did:key:method-guard-solver-declaration",
      effectiveTime: "2026-08-02T10:30:00Z",
      address: `0x${"1".repeat(40)}`,
    },
    evaluator: {
      signerKey: "did:key:method-guard-evaluator",
      agent: AGENT,
      declarationKey: "did:key:method-guard-evaluator-declaration",
      address: EVALUATOR_ADDRESS,
    },
    verificationDigest: `sha256:${"e".repeat(64)}`,
  } as never);
  const taskBytes = new TextEncoder().encode("method-guard-exact-evaluation-task");
  const taskDigest = documentDigest(taskBytes);
  const submissionBytes = sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: "urn:uuid:00000000-0000-4000-8000-000000000031",
    task: { digest: { sha256: taskDigest.slice("sha256:".length) } },
    requester: AGENT,
    idempotencyKey: admitted.evaluationId,
    nonce: admitted.evaluationId,
    deadline: "2026-08-03T00:00:00.000Z",
  });
  state.recordDerivedEvaluation(admitted.evaluationId, {
    taskBytes,
    taskDigest,
    submissionBytes,
    submissionDigest: documentDigest(submissionBytes),
    submissionUri: "urn:uuid:00000000-0000-4000-8000-000000000031",
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
  return {
    attemptUri: state.getEvaluation(admitted.evaluationId)!.evaluationAttemptUri!,
    taskBytes,
    task: subject.task,
    result: subject.results[0]!,
    evaluationSpec: subject.evaluationSpec,
  };
}

async function harvestContractFor(
  config: LocalTaskExecutionBackendConfig,
  admitted: { readonly attemptUri: string; readonly taskBytes: Uint8Array },
) {
  const selected = config.provisioner({
    attempt: { attemptUri: admitted.attemptUri, nonce: "method-guard-nonce", attemptNumber: 1 },
    sealedTaskBytes: admitted.taskBytes,
    dispatchContextBytes: new TextEncoder().encode("{}"),
  } as never);
  const workRoot = await mkdtemp(join(tmpdir(), "jinn-native-evaluator-method-guard-"));
  roots.push(workRoot);
  const outDir = join(workRoot, "out");
  // `secrets` and `tmp` are swept by the dir provisioner's harvest, so they get their own
  // directories -- aliasing them onto `out` would delete the harvested verdict.
  const secretsDir = join(workRoot, "secrets");
  const tmpDir = join(workRoot, "tmp");
  const metaDir = join(workRoot, "meta");
  const logsDir = join(workRoot, "logs");
  for (const dir of [outDir, secretsDir, tmpDir, metaDir, logsDir]) {
    await mkdir(dir, { recursive: true });
  }
  return {
    contract: selected.contract,
    outDir,
    paths: {
      root: workRoot, input: outDir, work: outDir, out: outDir, logs: logsDir,
      harnessState: outDir, secrets: secretsDir, tmp: tmpDir, meta: metaDir,
    } as unknown as WorkspacePaths,
  };
}

describe("native evaluator multi-registration harvest method-digest guard", () => {
  /**
   * Two configured methods, one durable swe-rebench EvaluationSpec. A verdict statement is
   * otherwise genuine and only names the OTHER configured method's digest. Pre-P0-5 the guard
   * compared against one configured digest for every evaluation, so a second configured method
   * could launder a verdict under the wrong method identity; it now compares against the digest
   * of the registration that actually serves this evaluation's spec.
   */
  async function twoMethodFixture() {
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
      graderReportSources: { "swe-rebench-v2": "deployment-owned" },
    });
    const admitted = admittedEvaluation(value.state, specificationFor(SWE_REBENCH_PARSER));
    const harvestable = await harvestContractFor(value.backendConfigs[0]!, admitted);
    const verdict = (evaluationMethodDigest: `sha256:${string}`) => buildResultEvaluationPayload({
      task: { name: admitted.task.name, digest: admitted.task.digest },
      results: [{ name: admitted.result.name, digest: admitted.result.digest }],
      evaluator: { id: AGENT },
      evaluatedAt: "2026-08-02T13:00:00.000Z",
      verdict: "pass",
      evaluationSpecification: { name: admitted.evaluationSpec.name, digest: admitted.evaluationSpec.digest },
      evaluationMethod: { name: "method-guard-evaluator-v1", digest: evaluationMethodDigest },
    });
    return { value, composition, harvestable, verdict };
  }

  it("refuses a swe-rebench evaluation whose verdict names the other configured method's digest", async () => {
    const { value, composition, harvestable, verdict } = await twoMethodFixture();
    try {
      await writeFile(join(harvestable.outDir, "verdict"), verdict(METHOD_DIGEST));
      await expect(harvestable.contract.harvest(harvestable.paths, []))
        .rejects.toThrow(/outside its exact Attempt authority/);
    } finally {
      await composition.close();
      value.store.close();
    }
  });

  it("seals the attempt's exact verdict bytes when the verdict names the serving method", async () => {
    const { value, composition, harvestable, verdict } = await twoMethodFixture();
    try {
      // Identical statement, only the method digest changed to the one the durable swe-rebench
      // spec selects. `verdict()` produces bytes through the same `buildResultEvaluationPayload`
      // the real evaluation harness writes `out/verdict` with, so this is the production shape.
      const unsigned = verdict(`sha256:${SWE_METHOD_SHA256}`);
      await writeFile(join(harvestable.outDir, "verdict"), unsigned);
      await expect(harvestable.contract.harvest(harvestable.paths, [])).resolves.toBeDefined();

      const envelope = parseDsseEnvelope(new Uint8Array(await readFile(join(harvestable.outDir, "verdict"))));
      expect(envelope.payloadType).toBe(VERDICT_DSSE_PAYLOAD_TYPE);
      // The signed payload is the attempt's own bytes, never a re-serialization of them.
      expect(Buffer.from(envelope.payloadBytes).equals(Buffer.from(unsigned))).toBe(true);
      expect(envelope.signatures.map(({ keyid }) => keyid))
        .toEqual([value.roles.get("evaluator-verdict").keyId]);
    } finally {
      await composition.close();
      value.store.close();
    }
  });

  it("refuses a verdict statement written in a spelling the attestation family never emits", async () => {
    const { value, composition, harvestable, verdict } = await twoMethodFixture();
    try {
      // Same statement, re-spelled compactly. Semantically identical, so every authority term
      // still holds -- only the exact-bytes guard can reject it.
      const respelled = JSON.stringify(JSON.parse(
        new TextDecoder().decode(verdict(`sha256:${SWE_METHOD_SHA256}`)),
      ));
      await writeFile(join(harvestable.outDir, "verdict"), respelled);
      await expect(harvestable.contract.harvest(harvestable.paths, []))
        .rejects.toThrow(/not canonical exact bytes/);
    } finally {
      await composition.close();
      value.store.close();
    }
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
