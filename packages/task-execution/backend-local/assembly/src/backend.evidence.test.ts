import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-discovery";
import {
  EvidenceRepositoryError,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import type { LauncherContract } from "@jinn-network/task-execution-launchers";
import {
  buildRepositoryWorkProfile,
  sealTaskProfile,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import {
  DeliveryRecordSchema,
  documentDigest,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import type { ProvisionerContract } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "./backend.js";

const roots: string[] = [];
const backends: LocalTaskExecutionBackend[] = [];
const profile = buildRepositoryWorkProfile();
const sealedProfile = sealTaskProfile(profile);
const profileStore: ProfileStore = {
  get(digest) {
    return digest === sealedProfile.digest ? profile : undefined;
  },
};

afterEach(async () => {
  await Promise.all(backends.splice(0).map(async (backend) => {
    await backend.drain();
    await backend.shutdown();
  }));
  // A just-reaped shim can briefly finish closing its heartbeat/cancellation file after
  // shutdown returns. Retry only cleanup of the disposable test root.
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
});

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jinn-backend-evidence-"));
  roots.push(root);
  return root;
}

function documents(): { task: Uint8Array; submission: Uint8Array } {
  const task = sealTask({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    profile: {
      uri: profile.profile,
      digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
    },
    instructions: "Capture this execution.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
  return {
    task,
    submission: sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: `urn:uuid:${crypto.randomUUID()}`,
      task: { digest: { sha256: documentDigest(task).slice("sha256:".length) } },
      requester: "urn:uuid:20000000-0000-4000-8000-000000000001",
      idempotencyKey: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      deadline: "2099-01-01T00:00:00Z",
    }),
  };
}

function backend(
  root: string,
  repository: EvidenceRepository,
  onAwaitIndexed: () => void,
  deliveryExtensions?: LocalTaskExecutionBackendConfig["deliveryExtensions"],
  trustKeys?: LocalTaskExecutionBackendConfig["trustKeys"],
): LocalTaskExecutionBackend {
  const launcher: LauncherContract = {
    id: "fixture",
    capabilities: () => ({
      taskProfiles: [profile.profile],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: [],
      runPinning: { keys: [] },
    }),
    plan(_view, paths) {
      return {
        argv: [process.execPath, "-e", "process.exit(0)"],
        env: {},
        cwd: paths.work,
        validExitCodes: [0],
        resultContract: { envelopeFormat: "fixture" },
        interruptionBehavior: "repeatable",
      };
    },
  };
  const provisioner: ProvisionerContract = {
    workspaceKind: () => "dir",
    async setup(_view, paths) {
      await Promise.all(
        Object.values(paths).map((path) => mkdir(path, { recursive: true })),
      );
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest() {
      return { manifest: [], omissions: ["patch"], integrityViolations: [] };
    },
  };
  const instance = makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "urn:jinn:backend-local:evidence-test",
    executor: "https://spec.jinn.network/software/fake-launcher",
    profileStore,
    launchers: [launcher],
    provisioner: () => ({ id: "fixture", contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      isolation: ["process"],
    },
    recorderAvailability: "always",
    evidence: {
      repository,
      catalog: new InMemoryEvidenceCatalog(),
      async awaitIndexed(reference) {
        onAwaitIndexed();
        return { status: "not-announced", reference };
      },
    },
    ...(deliveryExtensions === undefined ? {} : { deliveryExtensions }),
    ...(trustKeys === undefined ? {} : { trustKeys }),
  });
  backends.push(instance);
  return instance;
}

async function terminalSnapshot(instance: LocalTaskExecutionBackend, submission: `urn:uuid:${string}`) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await instance.observe(submission);
    if (snapshot.descriptor.derived.terminal) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("attempt did not become terminal");
}

describe("backend evidence capture posture (C3)", () => {
  test("finalization receipt gates delivered, populates Delivery, and catalog indexing does not gate", async () => {
    const repository = new InMemoryEvidenceRepository();
    let awaitCalls = 0;
    const instance = backend(await stateRoot(), repository, () => {
      awaitCalls += 1;
    });
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    const snapshot = await terminalSnapshot(instance, ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({
      state: "delivered",
      terminal: true,
    });
    const types = snapshot.observations.map(({ type }) => type);
    expect(types.indexOf("network.jinn.task-execution.execution-observed.v1"))
      .toBeLessThan(types.indexOf("network.jinn.task-execution.delivery-recorded.v1"));
    expect(types.indexOf("network.jinn.task-execution.delivery-recorded.v1"))
      .toBeLessThan(types.indexOf("network.jinn.task-execution.attempt-terminal.v1"));
    expect(awaitCalls).toBe(0);

    const refs = await instance.deliveries(snapshot.descriptor.attempt);
    expect(refs).toHaveLength(1);
    const delivery = JSON.parse(
      new TextDecoder().decode(await instance.fetchDelivery(refs[0]!)),
    ) as {
      evidenceRecords?: unknown[];
      executionIds?: string[];
    };
    expect(delivery.evidenceRecords).toHaveLength(1);
    expect(delivery.executionIds).toEqual(snapshot.descriptor.derived.executionIds);
  });

  test("capture always maps recorder failure to failed[infrastructure] and emits no Delivery", async () => {
    const backing = new InMemoryEvidenceRepository();
    const repository: EvidenceRepository = {
      capabilities: backing.capabilities,
      putArtifact: backing.putArtifact.bind(backing),
      getArtifact: backing.getArtifact.bind(backing),
      getRecord: backing.getRecord.bind(backing),
      async putRecord() {
        throw new EvidenceRepositoryError("IO_FAILURE", "injected recorder failure");
      },
    };
    const instance = backend(await stateRoot(), repository, () => {});
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    const snapshot = await terminalSnapshot(instance, ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({
      state: "failed",
      terminal: true,
      blame: "infrastructure",
    });
    expect(await instance.deliveries(snapshot.descriptor.attempt)).toEqual([]);
  });

  test("carries a host-supplied namespaced Delivery extension into the sealed bytes", async () => {
    const repository = new InMemoryEvidenceRepository();
    const deliveryExtensions: LocalTaskExecutionBackendConfig["deliveryExtensions"] = () => ({
      "https://jinn.network/bridge/legacy-execution-envelope/1.0":
        "{\"schemaVersion\":\"jinn.execution.v1\"}",
    });
    const instance = backend(await stateRoot(), repository, () => {}, deliveryExtensions);
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    const snapshot = await terminalSnapshot(instance, ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({ state: "delivered", terminal: true });

    const refs = await instance.deliveries(snapshot.descriptor.attempt);
    expect(refs).toHaveLength(1);
    const deliveryBytes = await instance.fetchDelivery(refs[0]!);
    const parsed = JSON.parse(new TextDecoder().decode(deliveryBytes)) as Record<string, unknown>;
    expect(parsed["https://jinn.network/bridge/legacy-execution-envelope/1.0"]).toBe(
      "{\"schemaVersion\":\"jinn.execution.v1\"}",
    );
    // The extension must not break canonical sealing or schema admission.
    expect(() => DeliveryRecordSchema.parse(parsed)).not.toThrow();
  });

  test("refuses a non-namespaced extension key", async () => {
    const repository = new InMemoryEvidenceRepository();
    const deliveryExtensions: LocalTaskExecutionBackendConfig["deliveryExtensions"] = () => ({
      data: "x",
    });
    const instance = backend(await stateRoot(), repository, () => {}, deliveryExtensions);
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    const snapshot = await terminalSnapshot(instance, ack.submission);
    expect(snapshot.descriptor.derived).toMatchObject({
      state: "failed",
      terminal: true,
      blame: "infrastructure",
    });
    expect(await instance.deliveries(snapshot.descriptor.attempt)).toEqual([]);
  });

  // Cutover stage 1 close-out C7 (finding E24): `deliveryExtensions` needs a way to reach the
  // workKind (and, for today-generation claims, the requestId) that produced the attempt it is
  // sealing a Delivery for -- `noteAttemptWorkKind` is that seam. A two-party caller knows
  // `attempt` before it calls `submit()` (this is exactly how `work-loop.ts` uses it), so these
  // tests drive the two-party path rather than the single-party one, matching production.
  test("threads a host-noted workKind and requestId through to deliveryExtensions at delivery time", async () => {
    const repository = new InMemoryEvidenceRepository();
    const task = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: {
        uri: profile.profile,
        digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
      },
      instructions: "Capture this execution.",
      outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    });
    const taskDigest = documentDigest(task);
    const submissionUri = `urn:uuid:${crypto.randomUUID()}` as const;
    const nonce = crypto.randomUUID();
    const submission = sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: submissionUri,
      task: { digest: { sha256: taskDigest.slice("sha256:".length) } },
      requester: "urn:uuid:20000000-0000-4000-8000-000000000002",
      idempotencyKey: crypto.randomUUID(),
      nonce,
      deadline: "2099-01-01T00:00:00Z",
    });
    const attemptUri = `urn:uuid:${crypto.randomUUID()}` as const;
    const requestId = `0x${"a".repeat(64)}` as const;
    const seen: { readonly workKind?: string; readonly requestId?: `0x${string}` }[] = [];
    const deliveryExtensions: LocalTaskExecutionBackendConfig["deliveryExtensions"] = (input) => {
      seen.push({ workKind: input.workKind, requestId: input.requestId });
      return {};
    };
    const instance = backend(await stateRoot(), repository, () => {}, deliveryExtensions);
    // Noted BEFORE submit() -- the seam's whole point is that the caller knows the attempt's
    // identity ahead of the two-party submit call.
    instance.noteAttemptWorkKind(attemptUri, "repo-fix", requestId);

    const ack = await instance.submit(task, submission, {
      attemptUri,
      dispatchContext: { taskDigest, submission: submissionUri, nonce, attempt: attemptUri },
    });
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    await terminalSnapshot(instance, ack.submission);
    expect(seen).toEqual([{ workKind: "repo-fix", requestId }]);
  });

  test("leaves workKind/requestId absent from deliveryExtensions input when never noted", async () => {
    const repository = new InMemoryEvidenceRepository();
    const seen: Record<string, unknown>[] = [];
    const deliveryExtensions: LocalTaskExecutionBackendConfig["deliveryExtensions"] = (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      return {};
    };
    const instance = backend(await stateRoot(), repository, () => {}, deliveryExtensions);
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");

    await terminalSnapshot(instance, ack.submission);
    expect(seen).toHaveLength(1);
    expect("workKind" in seen[0]!).toBe(false);
    expect("requestId" in seen[0]!).toBe(false);
  });

  /**
   * #36. A recording's `producer` descriptor is derived from `source` and its `executor`
   * descriptor from `executor`, under two different names — so one identity in both roles makes
   * the recorder refuse EVERY attempt this backend starts. Pre-guard that stayed latent until
   * the first live attempt, where it surfaced as an opaque `dependency-unavailable` terminal
   * 122ms in. Refuse at construction so the composition, not the grade, is what breaks.
   */
  test("refuses construction when source and executor are one identity and capture is on (#36)", async () => {
    const reused = "urn:uuid:44cfb891-0000-4000-8000-0000000000ff";
    const config = (
      recorderAvailability: LocalTaskExecutionBackendConfig["recorderAvailability"],
      executor: string,
      root: string,
    ): LocalTaskExecutionBackendConfig => ({
      stateRoot: root,
      source: reused,
      executor,
      profileStore,
      launchers: [],
      provisioner: () => { throw new Error("not used"); },
      provisionerCapabilities: {
        taskProfiles: [profile.profile],
        workspaceKinds: ["dir"],
        inputMediaTypes: ["application/json"],
        outputMediaTypes: ["text/x-diff"],
        isolation: ["process"],
      },
      recorderAvailability,
    });

    const always = config("always", reused, await stateRoot());
    const available = config("available", reused, await stateRoot());
    const distinct = config("always", "urn:jinn:operator-runtime:0.2.2", await stateRoot());
    const captureOff = config("none", reused, await stateRoot());

    expect(() => makeLocalTaskExecutionBackend(always)).toThrow(/source and executor must be distinct/);
    expect(() => makeLocalTaskExecutionBackend(available)).toThrow(/source and executor must be distinct/);
    // Distinct identities construct; so does a capture-free backend, which records no graph.
    backends.push(makeLocalTaskExecutionBackend(distinct));
    backends.push(makeLocalTaskExecutionBackend(captureOff));
  });
});

// ── Finding E31: real executor delivery signing ──────────────────────────────────────────────
//
// `completeAttempt` seals the Delivery bytes exactly once (unchanged), then -- only when
// `trustKeys.deliverySigningKey` is configured -- signs those EXACT sealed bytes into a DSSE
// envelope carried OUTSIDE the Delivery document (never embedded, never re-sealed: seal-once,
// per design §9.1 and PRINCIPLES.md's "Legible" principle -- every claim must be exactly,
// independently verifiable; an embedded signature field cannot cover its own bytes without a
// second seal pass, which is exactly the re-canonicalization seal-once forbids). The envelope is
// retrievable via `getDeliverySignature(digest)`, keyed by the Delivery's own digest -- the only
// identity `SettlementGradeVerificationInput` (`@jinn-network/marketplace-binding`) carries
// across that package boundary (see `operator/src/daemon/settlement-grade.ts`).

/**
 * Test-local, byte-for-byte port of `@jinn-network/trust-core`'s `dssePreAuthEncoding` (this
 * package has no dependency on trust-core -- see `backend.ts`'s own copy for why, and
 * `settlement-grade.ts`'s `idempotencyKeyFor` for the established cross-boundary-duplication
 * precedent). Used here only to INDEPENDENTLY reconstruct what a genuine signer must have signed,
 * so this test does not simply assert against the production code's own encoding.
 */
function dssePreAuthEncoding(payloadType: string, payloadBytes: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(payloadType);
  const head = new TextEncoder().encode(`DSSEv1 ${typeBytes.length} `);
  const mid = new TextEncoder().encode(` ${payloadBytes.length} `);
  const out = new Uint8Array(head.length + typeBytes.length + mid.length + payloadBytes.length);
  let offset = 0;
  for (const part of [head, typeBytes, mid, payloadBytes]) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function signingBackend(
  root: string,
  trustKeys?: LocalTaskExecutionBackendConfig["trustKeys"],
): LocalTaskExecutionBackend {
  const launcher: LauncherContract = {
    id: "fixture",
    capabilities: () => ({
      taskProfiles: [profile.profile],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: [],
      runPinning: { keys: [] },
    }),
    plan(_view, paths) {
      return {
        argv: [process.execPath, "-e", "process.exit(0)"],
        env: {},
        cwd: paths.work,
        validExitCodes: [0],
        resultContract: { envelopeFormat: "fixture" },
        interruptionBehavior: "repeatable",
      };
    },
  };
  const provisioner: ProvisionerContract = {
    workspaceKind: () => "dir",
    async setup(_view, paths) {
      await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
    },
    executionEnv: ({ env }) => ({ ...env }),
    async harvest() {
      return { manifest: [], omissions: ["patch"], integrityViolations: [] };
    },
  };
  const instance = makeLocalTaskExecutionBackend({
    stateRoot: root,
    source: "urn:jinn:backend-local:signing-test",
    executor: "https://spec.jinn.network/software/fake-launcher",
    profileStore,
    launchers: [launcher],
    provisioner: () => ({ id: "fixture", contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      isolation: ["process"],
    },
    // 'none' keeps this fixture free of evidence-capture's own nondeterminism (execution IDs) --
    // irrelevant to what this describe block proves.
    recorderAvailability: "none",
    now: () => "2026-07-31T00:00:00.000Z",
    ...(trustKeys === undefined ? {} : { trustKeys }),
  });
  backends.push(instance);
  return instance;
}

describe("executor delivery signing (finding E31)", () => {
  test("Delivery bytes are byte-identical whether or not a delivery-signing key is configured (additive)", async () => {
    const keyPair = generateKeyPairSync("ed25519");
    const trustKeys: LocalTaskExecutionBackendConfig["trustKeys"] = {
      deliverySigningKey: {
        keyId: "test-executor-key",
        sign: (payload) => new Uint8Array(cryptoSign(null, payload, keyPair.privateKey)),
      },
    };
    const task = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: { uri: profile.profile, digest: { sha256: sealedProfile.digest.slice("sha256:".length) } },
      instructions: "Capture this execution.",
      outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    });
    const taskDigest = documentDigest(task);
    const submissionUri = `urn:uuid:${crypto.randomUUID()}` as const;
    const nonce = crypto.randomUUID();
    const submission = sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: submissionUri,
      task: { digest: { sha256: taskDigest.slice("sha256:".length) } },
      requester: "urn:uuid:20000000-0000-4000-8000-000000000003",
      idempotencyKey: crypto.randomUUID(),
      nonce,
      deadline: "2099-01-01T00:00:00Z",
    });
    const attemptUri = `urn:uuid:${crypto.randomUUID()}` as const;

    const unsigned = signingBackend(await stateRoot());
    const signed = signingBackend(await stateRoot(), trustKeys);

    for (const instance of [unsigned, signed]) {
      const ack = await instance.submit(task, submission, {
        attemptUri,
        dispatchContext: { taskDigest, submission: submissionUri, nonce, attempt: attemptUri },
      });
      expect(ack.accepted).toBe(true);
    }
    await terminalSnapshot(unsigned, submissionUri);
    await terminalSnapshot(signed, submissionUri);

    const [unsignedRef] = await unsigned.deliveries(attemptUri);
    const [signedRef] = await signed.deliveries(attemptUri);
    expect(unsignedRef).toBeDefined();
    expect(signedRef).toBeDefined();
    const unsignedBytes = await unsigned.fetchDelivery(unsignedRef!);
    const signedBytes = await signed.fetchDelivery(signedRef!);
    expect(signedBytes).toEqual(unsignedBytes);
  });

  test("capabilities().signedDeliveries reflects whether a delivery-signing key is configured", async () => {
    const keyPair = generateKeyPairSync("ed25519");
    const unsigned = signingBackend(await stateRoot());
    const signed = signingBackend(await stateRoot(), {
      deliverySigningKey: {
        keyId: "k",
        sign: (payload) => new Uint8Array(cryptoSign(null, payload, keyPair.privateKey)),
      },
    });
    expect((await unsigned.capabilities()).signedDeliveries).toBe(false);
    expect((await signed.capabilities()).signedDeliveries).toBe(true);
  });

  test("getDeliverySignature is undefined when no delivery-signing key was configured", async () => {
    const instance = signingBackend(await stateRoot());
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    const snapshot = await terminalSnapshot(instance, ack.submission);
    const [ref] = await instance.deliveries(snapshot.descriptor.attempt);
    const deliveryBytes = await instance.fetchDelivery(ref!);
    expect(instance.getDeliverySignature(documentDigest(deliveryBytes))).toBeUndefined();
  });

  test("getDeliverySignature returns a genuine DSSE envelope over the exact sealed Delivery bytes", async () => {
    const keyPair = generateKeyPairSync("ed25519");
    const trustKeys: LocalTaskExecutionBackendConfig["trustKeys"] = {
      deliverySigningKey: {
        keyId: "test-executor-key",
        sign: (payload) => new Uint8Array(cryptoSign(null, payload, keyPair.privateKey)),
      },
    };
    const instance = signingBackend(await stateRoot(), trustKeys);
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    const snapshot = await terminalSnapshot(instance, ack.submission);
    const [ref] = await instance.deliveries(snapshot.descriptor.attempt);
    const deliveryBytes = await instance.fetchDelivery(ref!);
    const digest = documentDigest(deliveryBytes);

    const envelopeBytes = instance.getDeliverySignature(digest);
    expect(envelopeBytes).toBeDefined();
    const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes!)) as {
      payloadType: string;
      payload: string;
      signatures: readonly { keyid?: string; sig: string }[];
    };
    expect(envelope.payloadType).toBe("application/vnd.jinn.marketplace.executor-binding.v1+json");
    const payloadBytes = Uint8Array.from(Buffer.from(envelope.payload, "base64"));
    // Seal-once: the DSSE payload is the exact sealed Delivery bytes, never re-canonicalized.
    expect(payloadBytes).toEqual(deliveryBytes);
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0]!.keyid).toBe("test-executor-key");
    const preAuthEncoding = dssePreAuthEncoding(envelope.payloadType, payloadBytes);
    const sigBytes = Uint8Array.from(Buffer.from(envelope.signatures[0]!.sig, "base64"));
    expect(cryptoVerify(null, preAuthEncoding, keyPair.publicKey, sigBytes)).toBe(true);

    // No trace of the signature leaks into the Delivery document itself.
    const parsed = JSON.parse(new TextDecoder().decode(deliveryBytes)) as Record<string, unknown>;
    expect(Object.keys(parsed).some((key) => key.includes("executor-binding"))).toBe(false);
  });

  // ── Defect #34: the envelope's own ENCODING, not just its parsed shape ──────────────────────
  //
  // The consumer that matters is an authority-bearing one: `@jinn-network/trust-core`'s
  // `parseExactDsseEnvelope` (via the client's `verifyNativeDsse`) accepts ONLY the sole producer
  // encoding -- `sealDsseEnvelope`'s RFC 8785 JCS bytes -- and rejects every alternate spelling of
  // the same envelope (its own suite asserts a "reordered" representation throws). A `JSON.stringify`
  // envelope in `payloadType, payload, signatures` insertion order parses fine under the LOOSE
  // `parseDsseEnvelope` the settlement-grade checker uses, and is refused by the strict one -- which
  // surfaces as `envelope-signature-invalid` even though the Ed25519 signature is perfectly valid.
  // The expected string below is reconstructed independently here (sorted keys spelled out by hand),
  // so this does not assert the production code against its own serializer.
  test("getDeliverySignature emits the canonical (JCS sorted-key) envelope encoding the strict DSSE parser accepts", async () => {
    const keyPair = generateKeyPairSync("ed25519");
    const instance = signingBackend(await stateRoot(), {
      deliverySigningKey: {
        keyId: "test-executor-key",
        sign: (payload) => new Uint8Array(cryptoSign(null, payload, keyPair.privateKey)),
      },
    });
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    const snapshot = await terminalSnapshot(instance, ack.submission);
    const [ref] = await instance.deliveries(snapshot.descriptor.attempt);
    const deliveryBytes = await instance.fetchDelivery(ref!);

    const envelopeBytes = instance.getDeliverySignature(documentDigest(deliveryBytes));
    expect(envelopeBytes).toBeDefined();
    const text = new TextDecoder().decode(envelopeBytes!);
    const envelope = JSON.parse(text) as {
      payloadType: string;
      payload: string;
      signatures: readonly { keyid: string; sig: string }[];
    };
    const expected = `{"payload":${JSON.stringify(envelope.payload)},`
      + `"payloadType":${JSON.stringify(envelope.payloadType)},`
      + `"signatures":[{"keyid":${JSON.stringify(envelope.signatures[0]!.keyid)},`
      + `"sig":${JSON.stringify(envelope.signatures[0]!.sig)}}]}`;
    expect(text).toBe(expected);
  });

  test("getDeliverySignature keys by digest -- an unknown digest returns undefined", async () => {
    const keyPair = generateKeyPairSync("ed25519");
    const instance = signingBackend(await stateRoot(), {
      deliverySigningKey: {
        keyId: "k",
        sign: (payload) => new Uint8Array(cryptoSign(null, payload, keyPair.privateKey)),
      },
    });
    const { task, submission } = documents();
    const ack = await instance.submit(task, submission);
    expect(ack.accepted).toBe(true);
    if (!ack.accepted) throw new Error("unreachable");
    await terminalSnapshot(instance, ack.submission);
    expect(instance.getDeliverySignature(`sha256:${"0".repeat(64)}`)).toBeUndefined();
  });
});
