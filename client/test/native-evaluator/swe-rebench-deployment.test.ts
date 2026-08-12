import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { BindingResolver, ResolvedBinding } from "@jinn-network/trust-core";
import {
  buildEvaluationTaskProfile,
  parserAllowlistKey,
  sealTaskProfile,
} from "@jinn-network/task-execution-profiles";
import {
  SWE_REBENCH_PARSER,
} from "@jinn-network/task-execution-evaluator-adapters";
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
  SWE_REBENCH_EVALUATOR_DEPLOYMENT_MODULE_PATH,
  SWE_REBENCH_EVALUATOR_DEPLOYMENT_SIDECAR_PATH,
  SWE_REBENCH_EVALUATOR_METHOD_DESCRIPTOR_PATH,
  sweRebenchEvaluatorMethodDigest,
  sweRebenchEvaluatorModuleDigest,
  writeSweRebenchEvaluatorSidecar,
} from "../../src/native-evaluator/deployment-paths.js";

const AGENT = "urn:jinn:evaluator:swe-rebench-deployment-fixture";
const OTHER_AGENT = "urn:jinn:evaluator:swe-rebench-deployment-fixture-other";
const EVALUATOR_ADDRESS = `0x${"2".repeat(40)}` as const;
const COORDINATOR = `0x${"3".repeat(40)}` as const;
const SIGNER_HANDLE = "swe-rebench-v2-evaluator-verdict";
const SWE_METHOD_URI = "https://spec.jinn.network/evaluation-methods/swe-rebench/v2";
const MODULE_HREF = pathToFileURL(SWE_REBENCH_EVALUATOR_DEPLOYMENT_MODULE_PATH).href;
const CLIENT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
const roots: string[] = [];
let claimEvidenceRoot: string;

/**
 * The deployment module imports the Docker driver by relative DIST path
 * (`../../dist/daemon/native-evaluator-container-runtime.js`) — that is the shipped-package
 * resolution, deliberately not a package specifier (`@jinn-network/client` has no exports map).
 * A source checkout has no `dist/` unless `yarn build` ran, so this transpiles the ONE driver file
 * the module needs (node-builtin runtime imports only; the adapter import is type-only and erased),
 * making the "module loads + constructs the runtime" proof self-sufficient. It does not prove the
 * driver's Docker behavior — that needs a real image (M7).
 */
async function ensureDriverDist(): Promise<void> {
  const distDriver = join(CLIENT_ROOT, "dist", "daemon", "native-evaluator-container-runtime.js");
  if (existsSync(distDriver)) return;
  const source = await readFile(
    join(CLIENT_ROOT, "src", "daemon", "native-evaluator-container-runtime.ts"),
    "utf-8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  await mkdir(dirname(distDriver), { recursive: true });
  await writeFile(distDriver, outputText);
}

beforeAll(async () => {
  await ensureDriverDist();
  claimEvidenceRoot = await mkdtemp(join(tmpdir(), "jinn-swe-rebench-deployment-evidence-"));
  roots.push(claimEvidenceRoot);
  // Written before the module's first (and only, per resolved-URL import cache) dynamic import in
  // this process. Whitespace padding proves the module trims the sidecar's declared agent.
  await writeSweRebenchEvaluatorSidecar({ agent: `  ${AGENT}  `, claimEvidenceDir: claimEvidenceRoot });
});

afterAll(async () => {
  await rm(SWE_REBENCH_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, { force: true });
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function binding(key: string): ResolvedBinding {
  return {
    binding: {
      key: { didKey: key, keyid: key },
      // Every scope a native role can require, including the announce-plane scope the three
      // `*-discovery` roles gained in issue #2525.
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
  const root = await mkdtemp(join(tmpdir(), "jinn-swe-rebench-deployment-composition-"));
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
  const moduleDigest = await sweRebenchEvaluatorModuleDigest();
  const evaluationMethodDigest = await sweRebenchEvaluatorMethodDigest();
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
      module: SWE_REBENCH_EVALUATOR_DEPLOYMENT_MODULE_PATH,
      moduleDigest,
      signerHandle: SIGNER_HANDLE,
      evaluationMethodDigest,
    },
    // The container-graded registration's grader source is constructed BY the module
    // (deployment-owned): a live host object cannot cross the spawned-child boundary (#2467 P0-5-A).
    graderReportSources: { "swe-rebench-v2": "deployment-owned" },
    backend: {
      stateRoot: join(root, "backend"),
      source: "urn:jinn:evaluator-backend:swe-rebench-deployment-fixture",
      executor: "urn:jinn:evaluation-harness:swe-rebench-v2",
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
      sourceId: "urn:jinn:solver:swe-rebench-deployment-fixture/solver-records",
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

describe("production swe-rebench-v2 deployment module — real composition path", () => {
  it("loads through buildNativeEvaluatorComposition bound deployment-owned and plans the container-graded registration", async () => {
    const value = await fixture();
    const composition = await buildNativeEvaluatorComposition(value.config);
    const backendConfig = value.backendConfigs[0]!;
    expect(backendConfig.launchers).toHaveLength(1);
    expect(backendConfig.launchers[0]!.capabilities().taskProfiles).toEqual([
      "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
    ]);
    // The single registration is selected without reading durable state.
    const plan = backendConfig.launchers[0]!.plan(
      {
        task: {
          protocol: "https://spec.jinn.network/profiles/task-execution/v1",
          profile: {
            uri: "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
            digest: { sha256: "c".repeat(64) },
          },
          instructions: "evaluate",
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
    expect(plan.env!["JINN_ATTEMPT_EVALUATOR_REGISTRATION"]).toBe("swe-rebench-v2");
    expect(plan.env!["JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE"]).toBe(MODULE_HREF);
    await composition.close();
    value.store.close();
  });

  // FLIP-GATE 2: a container-graded registration that reaches composition with NO grader binding
  // must REFUSE, never boot. This is exactly the fleet call site's former shape (graderReportSources
  // omitted), so it proves the fleet path cannot mount a half-configured container grader.
  it("refuses when the container-graded registration has no host grader report source", async () => {
    const value = await fixture();
    const { graderReportSources: _omitted, ...deploymentWithoutBinding } = value.config;
    await expect(buildNativeEvaluatorComposition(deploymentWithoutBinding))
      .rejects.toThrow(/has no host grader report source/);
    expect(value.backendConfigs).toEqual([]);
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

describe("production swe-rebench-v2 deployment module — identity, parser, digests", () => {
  it("declares the fixed registrationId, signerHandle, parser allowlist, method uri, and the trimmed sidecar agent", async () => {
    const module = await import(MODULE_HREF) as {
      readonly evaluationHarnessDeployment: {
        readonly registrations: readonly {
          readonly registrationId: string;
          readonly signer: { readonly handle: string };
          readonly evaluatorIdentity: { readonly id: string };
          readonly evaluationMethod: { readonly uri?: string; readonly digest: { readonly sha256: string } };
        }[];
        readonly parserAllowlist: ReadonlySet<string>;
        readonly maxClaimEvidenceBytes: number;
      };
    };
    expect(module.evaluationHarnessDeployment.registrations).toHaveLength(1);
    const [registration] = module.evaluationHarnessDeployment.registrations;
    expect(registration!.registrationId).toBe("swe-rebench-v2");
    expect(registration!.signer.handle).toBe(SIGNER_HANDLE);
    // Proves the whitespace-padded sidecar agent (see beforeAll) was trimmed, not used verbatim.
    expect(registration!.evaluatorIdentity.id).toBe(AGENT);
    expect(registration!.evaluationMethod.uri).toBe(SWE_METHOD_URI);
    expect(registration!.evaluationMethod.digest.sha256).toBe(
      (await sweRebenchEvaluatorMethodDigest()).slice("sha256:".length),
    );
    // Narrowed to exactly the swe-rebench parser.
    expect([...module.evaluationHarnessDeployment.parserAllowlist]).toEqual([
      parserAllowlistKey(SWE_REBENCH_PARSER),
    ]);
    expect(module.evaluationHarnessDeployment.maxClaimEvidenceBytes).toBeGreaterThan(0);
  });

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
    const bytes = new TextEncoder().encode("swe-rebench claim evidence round-trip fixture bytes");
    const descriptor = await module.evaluationHarnessDeployment.evidenceWriter.putClaimEvidence({
      name: "test-log.txt",
      bytes,
      mediaType: "text/plain; charset=utf-8",
    });
    expect(descriptor.name).toBe("test-log.txt");
    expect(descriptor.digest.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const independentRepository = await createFilesystemEvidenceRepository({ rootDir: claimEvidenceRoot });
    const read = await independentRepository.getArtifact({ digest: `sha256:${descriptor.digest.sha256}` });
    expect(read).not.toBeNull();
    expect(Buffer.from(read!).equals(Buffer.from(bytes))).toBe(true);
  });

  it("computes moduleDigest as the exact sha256 of the committed module bytes", async () => {
    const bytes = await readFile(SWE_REBENCH_EVALUATOR_DEPLOYMENT_MODULE_PATH);
    expect(await sweRebenchEvaluatorModuleDigest()).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  });

  it("computes evaluationMethodDigest as the exact sha256 of the committed descriptor bytes", async () => {
    const bytes = await readFile(SWE_REBENCH_EVALUATOR_METHOD_DESCRIPTOR_PATH);
    expect(await sweRebenchEvaluatorMethodDigest()).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  });

  // The descriptor documents the ONE deliberate isolation relaxation for this method: a swe-rebench
  // grade installs pytest into the image rootfs at grade time, so the rootfs cannot be read-only.
  it("pins readOnlyRootfs:false in the evaluation-method descriptor with a documented rationale", async () => {
    const descriptor = JSON.parse(
      await readFile(SWE_REBENCH_EVALUATOR_METHOD_DESCRIPTOR_PATH, "utf-8"),
    ) as { isolation?: { readOnlyRootfs?: boolean; rationale?: string } };
    expect(descriptor.isolation?.readOnlyRootfs).toBe(false);
    expect(descriptor.isolation?.rationale).toMatch(/pip|pytest|ensurepip/i);
  });
});

// --- sidecar shape validation (fresh module instance per case via query-string cache-bust) -------
describe("production swe-rebench-v2 deployment module — sidecar shape validation", () => {
  async function restoreValidSidecar(): Promise<void> {
    await writeSweRebenchEvaluatorSidecar({ agent: `  ${AGENT}  `, claimEvidenceDir: claimEvidenceRoot });
  }

  it("rejects a missing agent field", async () => {
    await writeFile(SWE_REBENCH_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, `${JSON.stringify({})}\n`);
    try {
      await expect(import(`${MODULE_HREF}?swe-shape-case=missing-agent`))
        .rejects.toThrow(/non-empty "agent"/);
    } finally {
      await restoreValidSidecar();
    }
  });

  it("rejects a present, non-string claimEvidenceDir instead of silently defaulting", async () => {
    await writeFile(
      SWE_REBENCH_EVALUATOR_DEPLOYMENT_SIDECAR_PATH,
      `${JSON.stringify({ agent: AGENT, claimEvidenceDir: 42 })}\n`,
    );
    try {
      await expect(import(`${MODULE_HREF}?swe-shape-case=non-string-claim-evidence-dir`))
        .rejects.toThrow(/claimEvidenceDir.*must be a string/);
    } finally {
      await restoreValidSidecar();
    }
  });
});

// --- packaging: the sidecar must never reach a downstream installer ------------------------------
describe("production swe-rebench-v2 deployment module — npm packaging", () => {
  it("excludes the sidecar from the published tarball while still shipping the committed artifacts", async () => {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
      cwd: CLIENT_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    const [entry] = JSON.parse(stdout) as readonly {
      readonly files: readonly { readonly path: string }[];
    }[];
    const paths = entry!.files.map((file) => file.path);
    expect(paths).toContain("deployments/evaluator/swe-rebench-v2-deployment.mjs");
    expect(paths).toContain("deployments/evaluator/swe-rebench-v2-evaluation-method.v1.json");
    expect(paths).not.toContain("deployments/evaluator/swe-rebench-v2-deployment.local.json");
  }, 30_000);
});
