// SPDX-License-Identifier: MIT

// Two layers, both authored HERE (design §12/Finding F6; ruling §7.19):
//
// 1. The core sanity suite -- `describeTaskExecutionBackendContract` run UN-PARAMETERIZED (no
//    profile/forkCtx argument; the kit takes none) against `makeBackend`. Proves the frozen
//    `TaskExecutionBackend` contract holds over the chain venue.
// 2. The native §16.2 marketplace-profile conformance -- composed directly from the profiles +
//    trust primitives (never a profile-parameterized re-export of the TEP kit; it has no such
//    seam). Signed Tasks + signed Submissions (DSSE, via `authenticateRequester`); executor-
//    signed Deliveries (via `verifyEnvelopeBinding`); mandatory evidence (`executionIds` +
//    `evidenceRecords`); the `dispatch-binding` check; and `evaluationSpecification` digest
//    equality.
//
// `@jinn-network/trust-core`/`-resolve` are consumed directly here -- forbidden to `binding`, but
// legitimate for `testing` at M2.5 (see the dated comment on `TESTING_FORBIDDEN_PACKAGES` in
// `.github/scripts/marketplace-source-boundaries.test.mjs`).
import { readFileSync } from "node:fs";
import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import {
  TRUST_KEY_BINDING_FORMAT,
  authenticateRequester,
  dssePreAuthEncoding,
  parseDsseEnvelope,
  sealDsseEnvelope,
  verifyEnvelopeBinding,
  type BindingResolver,
  type DsseChainVerifier,
  type ResolvedBinding,
  type VerifyEnvelopeBindingDeps,
} from "@jinn-network/trust-core";
import {
  DeliveryRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  sha256Hex,
  type DeliveryRecord,
  type EvidenceRecordReference,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import { sealEvaluationSpec, type EvaluationSpec } from "@jinn-network/task-execution-profiles";
import { describeTaskExecutionBackendContract, type TestableBackend } from "@jinn-network/task-execution-testing";
import { describe, expect, test } from "vitest";

const SUBMISSION_MEDIA_TYPE = "application/vnd.jinn.task-execution.submission.v1+json";
const TASK_MEDIA_TYPE = "application/vnd.jinn.task-execution.task.v1+json";
const DELIVERY_MEDIA_TYPE = "application/vnd.jinn.task-execution.delivery.v1+json";
const MARKETPLACE_FAMILY = "jinn:marketplace";

// ---------------------------------------------------------------------------
// Trust test doubles (mirrors `packages/trust/core/src/verify.test.ts`'s own pattern -- no
// `@jinn-network/trust-testing` fixture package exists yet to reuse, per the guard's dated
// comment).
// ---------------------------------------------------------------------------

/**
 * Deterministic signature seam for the native profile vector. It binds every accepted key to
 * the exact received DSSE PAE (payload type + canonical Task/Submission/Delivery bytes); a
 * key id alone is never an authority result.
 */
export function buildTrustingDsseVerifier(): DsseChainVerifier {
  return (envelopeBytes) => {
    const parsed = parseDsseEnvelope(envelopeBytes);
    const pae = dssePreAuthEncoding(parsed.payloadType, parsed.payloadBytes);
    return {
      validSignerKeyids: parsed.signatures
        .flatMap((signature) => {
          if (signature.keyid === undefined) return [];
          const expected = new TextEncoder().encode(
            `${signature.keyid}:${sha256Hex(pae)}`,
          );
          const expectedBase64 = btoa(String.fromCharCode(...expected));
          return signature.sig === expectedBase64 ? [signature.keyid] : [];
        }),
    };
  };
}

interface FakeBindingEntry {
  readonly key: string;
  readonly agent: string;
  readonly resolved: ResolvedBinding;
}

/** An in-memory `BindingResolver` (mirrors `trust-core`'s own `FakeBindingResolver` test pattern). */
export function buildFakeBindingResolver(entries: readonly FakeBindingEntry[]): BindingResolver {
  return {
    async resolveBinding(query, atTime) {
      const entry = entries.find((e) => e.key === query.key && e.agent === query.agent);
      if (entry === undefined) return null;
      if (atTime < entry.resolved.effectiveStart) return null;
      return entry.resolved;
    },
  };
}

/** Builds a fake `ResolvedBinding` for (didKey, agent) with the given scope/relationship -- ceremony
 * type `oidc-machine` so `verifyEnvelopeBinding`'s ceremony leg trusts the resolver's own
 * authenticity guarantee (verify.ts: "the resolver already performed this ceremony's authenticity
 * check"), sidestepping the need for real EOA/Safe ceremony evidence in this fixture. */
function fakeResolvedBinding(input: {
  didKey: string;
  agent: string;
  scope: string[];
  relationship?: "controls" | "signs-for";
}): ResolvedBinding {
  return {
    envelopeBytes: new TextEncoder().encode("placeholder"),
    bindingDigest: `sha256:${"a".repeat(64)}`,
    effectiveStart: "2020-01-01T00:00:00Z",
    isGenesis: true,
    revocations: [],
    binding: {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: input.agent,
      key: { publicKey: "fixture-public-key", keyid: input.didKey, algorithm: "ed25519", didKey: input.didKey },
      voucher: {
        kind: "account",
        did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000000",
        contractAccount: false,
      },
      relationship: input.relationship ?? "controls",
      scope: input.scope,
      validFrom: "2020-01-01T00:00:00Z",
      ceremony: { type: "oidc-machine", digest: `sha256:${"b".repeat(64)}` },
      strength: "strong",
      anchors: [],
    },
  };
}

/** The trust fixture `describeMarketplaceBackendConformance`'s native §16.2 layer verifies against. */
export interface MarketplaceProfileTrustFixture {
  readonly dsseVerifier: DsseChainVerifier;
  readonly bindingResolver: BindingResolver;
  readonly requesterKey: string;
  readonly requesterAgent: string;
  readonly executorKey: string;
  readonly executorAgent: string;
}

/** Builds a self-contained trust fixture: requester key authorized (`scope: authorizations`), executor key controlling (`scope: [family]`). */
export function buildDefaultTrustFixture(): MarketplaceProfileTrustFixture {
  const requesterKey = "did:key:z6MkRequesterFixtureKey";
  const requesterAgent = "https://jinn.network/agents/requester-fixture";
  const executorKey = "did:key:z6MkExecutorFixtureKey";
  const executorAgent = "https://jinn.network/agents/executor-fixture";
  const bindingResolver = buildFakeBindingResolver([
    {
      key: requesterKey,
      agent: requesterAgent,
      resolved: fakeResolvedBinding({ didKey: requesterKey, agent: requesterAgent, scope: ["authorizations"] }),
    },
    {
      key: executorKey,
      agent: executorAgent,
      resolved: fakeResolvedBinding({
        didKey: executorKey,
        agent: executorAgent,
        scope: [MARKETPLACE_FAMILY],
        relationship: "controls",
      }),
    },
  ]);
  return { dsseVerifier: buildTrustingDsseVerifier(), bindingResolver, requesterKey, requesterAgent, executorKey, executorAgent };
}

function signedEnvelope(payloadBytes: Uint8Array, payloadType: string, keyid: string): Uint8Array {
  const signature = new TextEncoder().encode(
    `${keyid}:${sha256Hex(dssePreAuthEncoding(payloadType, payloadBytes))}`,
  );
  return sealDsseEnvelope({ payloadBytes, payloadType, signatures: [{ signature, keyid }] });
}

// ---------------------------------------------------------------------------
// Structural §16.2 checks -- exported so a consumer other than this describe-suite can reuse them.
// ---------------------------------------------------------------------------

export type MandatoryEvidenceResult = { ok: true } | { ok: false; reason: string };

/** Exact signed-Task admission boundary required by marketplace profile §16.2. */
export interface SignedTaskAdmissionInput {
  readonly envelopeBytes: Uint8Array;
  readonly requesterAgent: string;
  readonly requesterKey: string;
  readonly atTime: string;
  readonly dependencies: VerifyEnvelopeBindingDeps;
}

export type SignedTaskAdmissionResult =
  | {
      readonly ok: true;
      /** Exact received DSSE bytes; callers never reconstruct an equivalent envelope. */
      readonly envelopeBytes: Uint8Array;
      readonly taskBytes: Uint8Array;
      readonly task: TaskSpecification;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "envelope"
        | "media-type"
        | "task-json"
        | "task-schema"
        | "task-canonical"
        | "requester-binding";
      readonly detail: string;
    };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

/**
 * Admits only a DSSE envelope that carries the exact canonical Task bytes and whose received
 * PAE-bound envelope verifies under the expected requester authority. `parseDsseEnvelope` is
 * deliberately the trust-core parser available to this branch; Task exactness is established by
 * canonical re-sealing, not by inventing a second envelope parser dependency.
 */
export async function checkSignedTaskAdmission(
  input: SignedTaskAdmissionInput,
): Promise<SignedTaskAdmissionResult> {
  let parsed: ReturnType<typeof parseDsseEnvelope>;
  try {
    parsed = parseDsseEnvelope(input.envelopeBytes);
  } catch (cause) {
    return { ok: false, reason: "envelope", detail: String(cause) };
  }
  if (parsed.payloadType !== TASK_MEDIA_TYPE) {
    return {
      ok: false,
      reason: "media-type",
      detail: `expected ${TASK_MEDIA_TYPE}, got ${parsed.payloadType}`,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(parsed.payloadBytes));
  } catch (cause) {
    return { ok: false, reason: "task-json", detail: String(cause) };
  }

  let task: TaskSpecification;
  try {
    task = TaskSpecificationSchema.parse(parsedJson);
  } catch (cause) {
    return { ok: false, reason: "task-schema", detail: String(cause) };
  }

  let canonical: Uint8Array;
  try {
    canonical = sealTask(task);
  } catch (cause) {
    return { ok: false, reason: "task-schema", detail: String(cause) };
  }
  if (!sameBytes(parsed.payloadBytes, canonical)) {
    return {
      ok: false,
      reason: "task-canonical",
      detail: "DSSE payload differs from the canonical sealed Task bytes",
    };
  }

  const binding = await verifyEnvelopeBinding({
    envelopeBytes: input.envelopeBytes,
    key: input.requesterKey,
    agent: input.requesterAgent,
    family: "authorizations",
    atTime: input.atTime,
  }, input.dependencies);
  if (!binding.ok) {
    return {
      ok: false,
      reason: "requester-binding",
      detail: binding.detail ?? binding.reason ?? "requester authority was not accepted",
    };
  }
  return {
    ok: true,
    envelopeBytes: input.envelopeBytes.slice(),
    taskBytes: parsed.payloadBytes.slice(),
    task,
  };
}

/** The §16.2 marketplace profile requires `executionIds` and `evidenceRecords` on every Delivery. */
export function checkMandatoryEvidence(delivery: DeliveryRecord): MandatoryEvidenceResult {
  if (delivery.executionIds === undefined || delivery.executionIds.length === 0) {
    return { ok: false, reason: "Delivery carries no executionIds (§16.2 requires at least one)" };
  }
  if (delivery.evidenceRecords === undefined || delivery.evidenceRecords.length === 0) {
    return { ok: false, reason: "Delivery carries no evidenceRecords (§16.2 requires at least one)" };
  }
  return { ok: true };
}

export interface DeliveryBoundEvidenceFailure {
  readonly check:
    | "delivery-admission"
    | "task-admission"
    | "execution-evidence-reference"
    | "execution-evidence-resolution"
    | "execution-evidence-digest"
    | "execution-evidence-canonical"
    | "execution-evidence-schema"
    | "dispatch-binding"
    | "evaluation-specification";
  readonly detail: string;
}

export type DeliveryBoundEvidenceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failures: readonly DeliveryBoundEvidenceFailure[] };

export interface DeliveryBoundEvidenceInput {
  readonly deliveryBytes: Uint8Array;
  readonly taskBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly resolveRecord: (
    reference: EvidenceRecordReference,
  ) => Promise<Uint8Array | null>;
}

const DISPATCH_CONTEXT_MEDIA_TYPE =
  "application/vnd.jinn.task-execution.dispatch-context.v1+json";

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function parseExactJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`${label} is not valid UTF-8 JSON: ${String(cause)}`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderEvidenceJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderEvidenceJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, orderEvidenceJson(entry)]),
    );
  }
  return value;
}

function sealCanonicalEvidence(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(orderEvidenceJson(value), null, 2)}\n`,
  );
}

function descriptorDigest(value: unknown): `sha256:${string}` | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const digest = (value as { digest?: unknown }).digest;
  if (digest === null || typeof digest !== "object") return undefined;
  const sha256 = (digest as { sha256?: unknown }).sha256;
  return typeof sha256 === "string" ? `sha256:${sha256}` : undefined;
}

function entityTypes(entity: Record<string, unknown>): readonly string[] {
  const type = entity["@type"];
  if (typeof type === "string") return [type];
  return Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function referenceIds(value: unknown): readonly string[] {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const id = (candidate as { readonly "@id"?: unknown })["@id"];
    return typeof id === "string" ? [id] : [];
  });
}

function failure(
  check: DeliveryBoundEvidenceFailure["check"],
  detail: string,
): DeliveryBoundEvidenceResult {
  return { ok: false, failures: [{ check, detail }] };
}

/**
 * Native §16.2 evidence admission. Authority begins with exact canonical Delivery bytes and the
 * one named execution-evidence reference they carry. No detached parsed record can enter this
 * procedure.
 */
export async function verifyDeliveryBoundExecutionEvidence(
  input: DeliveryBoundEvidenceInput,
): Promise<DeliveryBoundEvidenceResult> {
  let delivery: DeliveryRecord;
  try {
    delivery = DeliveryRecordSchema.parse(
      parseExactJson(input.deliveryBytes, "Delivery"),
    );
    if (!exactBytes(input.deliveryBytes, sealDelivery(delivery))) {
      return failure("delivery-admission", "Delivery bytes are not the exact canonical seal");
    }
  } catch (cause) {
    return failure("delivery-admission", String(cause));
  }

  let task: ReturnType<typeof TaskSpecificationSchema.parse>;
  try {
    task = TaskSpecificationSchema.parse(parseExactJson(input.taskBytes, "Task"));
    if (!exactBytes(input.taskBytes, sealTask(task))) {
      return failure("task-admission", "Task bytes are not the exact canonical seal");
    }
    if (delivery.task !== documentDigest(input.taskBytes)) {
      return failure(
        "task-admission",
        "Delivery task digest does not bind the exact admitted Task bytes",
      );
    }
  } catch (cause) {
    return failure("task-admission", String(cause));
  }

  const references = (delivery.evidenceRecords ?? []).filter(
    (reference) => reference.family === "execution-evidence",
  );
  if (references.length !== 1) {
    return failure(
      "execution-evidence-reference",
      `Delivery must carry exactly one execution-evidence reference; found ${references.length}`,
    );
  }
  const reference = references[0]! as EvidenceRecordReference;

  let recordBytes: Uint8Array | null;
  try {
    recordBytes = await input.resolveRecord(reference);
  } catch (cause) {
    return failure(
      "execution-evidence-resolution",
      `record resolution dependency failed: ${String(cause)}`,
    );
  }
  if (recordBytes === null) {
    return failure(
      "execution-evidence-resolution",
      `no exact record bytes resolve for ${reference.digest}`,
    );
  }
  const actualRecordDigest = documentDigest(recordBytes);
  if (actualRecordDigest !== reference.digest) {
    return failure(
      "execution-evidence-digest",
      `resolved bytes digest ${actualRecordDigest} does not equal Delivery reference ${reference.digest}`,
    );
  }

  let evidence: unknown;
  try {
    evidence = parseExactJson(recordBytes, "Execution Evidence");
  } catch (cause) {
    return failure("execution-evidence-schema", String(cause));
  }
  if (!exactBytes(recordBytes, sealCanonicalEvidence(evidence))) {
    return failure(
      "execution-evidence-canonical",
      "resolved Execution Evidence bytes are not the exact family-canonical serialization",
    );
  }
  const report = validateExecutionEvidence(recordBytes);
  if (!report.conforms) {
    return failure(
      "execution-evidence-schema",
      report.diagnostics.map((diagnostic) =>
        `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`
      ).join("; "),
    );
  }

  const graphCandidate =
    evidence !== null && typeof evidence === "object"
      ? (evidence as { readonly "@graph"?: unknown })["@graph"]
      : undefined;
  const graph = Array.isArray(graphCandidate)
    ? graphCandidate.filter(
      (entity): entity is Record<string, unknown> =>
        entity !== null && typeof entity === "object",
    )
    : [];
  const executions = graph.filter((entity) => {
    const types = entityTypes(entity);
    return types.includes("CreateAction") && types.includes("prov:Activity");
  });
  if (executions.length !== 1) {
    return failure(
      "execution-evidence-schema",
      `expected one primary CreateAction/prov:Activity execution; found ${executions.length}`,
    );
  }
  const execution = executions[0]!;
  const byId = new Map(
    graph.flatMap((entity) => {
      const id = entity["@id"];
      return typeof id === "string" ? [[id, entity] as const] : [];
    }),
  );
  const capturedInputs = referenceIds(execution.object)
    .flatMap((id) => {
      const entity = byId.get(id);
      return entity === undefined ? [] : [entity];
    });
  const expectedDispatchDigest = documentDigest(input.dispatchContextBytes);
  const dispatchInputs = capturedInputs.filter(
    (entity) => entity.encodingFormat === DISPATCH_CONTEXT_MEDIA_TYPE,
  );
  if (
    dispatchInputs.length !== 1
    || dispatchInputs[0]!.sha256 !== expectedDispatchDigest.slice("sha256:".length)
  ) {
    return failure(
      "dispatch-binding",
      `captured dispatch-context input does not bind ${expectedDispatchDigest}`,
    );
  }

  const taskEvaluationDigest = descriptorDigest(task.evaluation);
  const evidenceEvaluationDigest = descriptorDigest(
    execution.evaluationSpecification,
  );
  if (
    taskEvaluationDigest === undefined
    || evidenceEvaluationDigest !== taskEvaluationDigest
  ) {
    return failure(
      "evaluation-specification",
      `Evidence evaluationSpecification ${String(evidenceEvaluationDigest)} does not equal Task descriptor ${String(taskEvaluationDigest)}`,
    );
  }

  return { ok: true };
}

const GOLDEN_EVALUATION_SPEC: EvaluationSpec = {
  protocol: "https://jinn.network/profiles/evaluation-spec/1.0",
  semanticsVersion: "4",
  family: "deterministic-process",
  grader: { uri: "https://example.org/graders/deterministic-process-runner" },
  familyBlock: {
    image: { uri: "https://example.org/images/swe-rebench-runner" },
    platform: "linux/amd64",
    workspace: { root: "/workspace" },
    testMaterial: [{ uri: "https://example.org/tests/patch.diff", accessClass: "public" }],
    parser: {
      id: "jinn.parser.pytest-json-report",
      version: "1.0.0",
      digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    },
    transitions: { failToPass: ["test_a"], passToPass: ["test_b"] },
    timeout: 1800,
  },
  measurements: [{ name: "passed", type: "boolean", required: true }],
  verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
} as unknown as EvaluationSpec;

const PROFILE_DESCRIPTOR = {
  uri: "https://jinn.network/task-profiles/repository-work/1.0",
  digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
};

interface DeliveryEvidenceVector {
  readonly taskBytes: Uint8Array;
  readonly deliveryBytes: Uint8Array;
  readonly dispatchContextBytes: Uint8Array;
  readonly recordBytes: Uint8Array;
  readonly evidenceDocument: Record<string, unknown>;
}

function buildDeliveryEvidenceVector(
  overrides: {
    readonly dispatchDigest?: `sha256:${string}`;
    readonly evaluationDigest?: `sha256:${string}`;
  } = {},
): DeliveryEvidenceVector {
  const sealedSpec = sealEvaluationSpec(GOLDEN_EVALUATION_SPEC);
  const taskBytes = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: PROFILE_DESCRIPTOR,
    instructions: "§16.2 exact Delivery-bound evidence fixture.",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    evaluation: {
      name: "evaluation-spec.json",
      digest: { sha256: sealedSpec.digest.slice("sha256:".length) },
    },
  });
  const dispatchContextBytes = new TextEncoder().encode(
    '{"attempt":"urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","nonce":"marketplace-dispatch"}',
  );
  const evidenceDocument = JSON.parse(
    readFileSync(
      new URL(import.meta.resolve(
        "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json",
      )),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const graph = evidenceDocument["@graph"] as Record<string, unknown>[];
  const execution = graph.find((entity) => {
    const types = entityTypes(entity);
    return types.includes("CreateAction") && types.includes("prov:Activity");
  });
  if (execution === undefined) throw new Error("golden evidence fixture has no execution");
  const dispatchEntity = {
    "@id": "inputs/marketplace-dispatch-context.json",
    "@type": ["File", "CreativeWork"],
    name: "Jinn per-Attempt dispatch context",
    encodingFormat: DISPATCH_CONTEXT_MEDIA_TYPE,
    sha256: (
      overrides.dispatchDigest ?? documentDigest(dispatchContextBytes)
    ).slice("sha256:".length),
  };
  graph.push(dispatchEntity);
  const objects = Array.isArray(execution.object) ? execution.object : [];
  execution.object = [
    ...objects,
    { "@id": dispatchEntity["@id"] },
  ];
  execution.evaluationSpecification = {
    name: "evaluation-spec.json",
    digest: {
      sha256: (
        overrides.evaluationDigest ?? sealedSpec.digest
      ).slice("sha256:".length),
    },
  };
  const root = graph.find((entity) => entity["@id"] === "./");
  if (root === undefined) throw new Error("golden evidence fixture has no root Dataset");
  const parts = Array.isArray(root.hasPart) ? root.hasPart : [];
  root.hasPart = [...parts, { "@id": dispatchEntity["@id"] }];

  const recordBytes = sealCanonicalEvidence(evidenceDocument);
  const reference: EvidenceRecordReference = {
    family: "execution-evidence",
    digest: documentDigest(recordBytes),
  };
  const deliveryBytes = sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    task: documentDigest(taskBytes),
    outputs: [{
      name: "patch",
      mediaType: "text/x-diff",
      digest: { sha256: "d".repeat(64) },
    }],
    outcome: "fulfilled",
    createdAt: "2026-07-28T00:05:00Z",
    executionIds: ["urn:uuid:22222222-2222-4222-8222-222222222222"],
    evidenceRecords: [reference],
  });
  return {
    taskBytes,
    deliveryBytes,
    dispatchContextBytes,
    recordBytes,
    evidenceDocument,
  };
}

function replaceEvidenceReferences(
  vector: DeliveryEvidenceVector,
  references: readonly EvidenceRecordReference[],
): Uint8Array {
  const delivery = DeliveryRecordSchema.parse(
    parseExactJson(vector.deliveryBytes, "Delivery"),
  );
  return sealDelivery({ ...delivery, evidenceRecords: [...references] });
}

/**
 * `describeMarketplaceBackendConformance` -- the two layers (design §12/§13; ruling §7.19). Both
 * are fork-backed when `makeBackend` is wired to a real Anvil fork (see
 * `backend-conformance.test.ts`); the native §16.2 layer's own assertions are pure/local (they
 * check the composed profiles+trust primitives, not the chain venue itself).
 */
export function describeMarketplaceBackendConformance(
  makeBackend: () => TestableBackend,
  trustFixture: MarketplaceProfileTrustFixture = buildDefaultTrustFixture(),
): void {
  // Layer 1: un-parameterized core sanity (ruling §7.19 -- no profile/forkCtx argument).
  describeTaskExecutionBackendContract(makeBackend);

  // Layer 2: native §16.2 marketplace-profile conformance.
  describe("native §16.2 marketplace-profile conformance", () => {
    test("signed-Task admission uses the exported boundary for complete canonical success", async () => {
      const task = sealTask({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        profile: PROFILE_DESCRIPTOR,
        instructions: "§16.2 signed-Task exact-payload fixture.",
        outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
      });
      const envelope = signedEnvelope(task, TASK_MEDIA_TYPE, trustFixture.requesterKey);
      expect(await checkSignedTaskAdmission({
        envelopeBytes: envelope,
        requesterKey: trustFixture.requesterKey,
        requesterAgent: trustFixture.requesterAgent,
        atTime: "2026-01-01T00:00:00Z",
        dependencies: {
        bindingResolver: trustFixture.bindingResolver,
        witnessVerifier: { verify1271Witness: async () => ({ verified: true }) },
        dsseVerifier: trustFixture.dsseVerifier,
        },
      })).toEqual({
        ok: true,
        envelopeBytes: envelope,
        taskBytes: task,
        task: TaskSpecificationSchema.parse(parseExactJson(task, "Task")),
      });
    });

    test("signed-Task hostile vectors use the exported boundary and exact typed refusals", async () => {
      const task = sealTask({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        profile: PROFILE_DESCRIPTOR,
        instructions: "§16.2 signed-Task hostile payload fixture.",
        outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
      });
      const noncanonical = signedEnvelope(
        new TextEncoder().encode(`${new TextDecoder().decode(task)} `),
        TASK_MEDIA_TYPE,
        trustFixture.requesterKey,
      );
      const unauthorized = signedEnvelope(task, TASK_MEDIA_TYPE, trustFixture.executorKey);
      const dependencies = {
        bindingResolver: trustFixture.bindingResolver,
        witnessVerifier: { verify1271Witness: async () => ({ verified: true }) },
        dsseVerifier: trustFixture.dsseVerifier,
      };
      expect(await checkSignedTaskAdmission({
        envelopeBytes: noncanonical,
        requesterKey: trustFixture.requesterKey,
        requesterAgent: trustFixture.requesterAgent,
        atTime: "2026-01-01T00:00:00Z",
        dependencies,
      })).toEqual({
        ok: false,
        reason: "task-canonical",
        detail: "DSSE payload differs from the canonical sealed Task bytes",
      });
      expect(await checkSignedTaskAdmission({
        envelopeBytes: unauthorized,
        requesterKey: trustFixture.executorKey,
        requesterAgent: trustFixture.executorAgent,
        atTime: "2026-01-01T00:00:00Z",
        dependencies,
      })).toEqual({
        ok: false,
        reason: "requester-binding",
        detail: "binding scope [jinn:marketplace] does not cover family \"authorizations\".",
      });
    });

    test("a signed Submission verifies via authenticateRequester (DSSE over exact sealed bytes, §7.5b)", async () => {
      const task = sealTask({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        profile: PROFILE_DESCRIPTOR,
        instructions: "§16.2 signed-Submission fixture.",
        outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
      });
      const submission = sealSubmission({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        submission: `urn:uuid:${crypto.randomUUID()}`,
        task: { digest: { sha256: sha256Hex(task) } },
        requester: trustFixture.requesterAgent,
        idempotencyKey: "conformance-16-2",
        nonce: "nonce-1",
        deadline: "2099-01-01T00:00:00Z",
      });
      const envelope = signedEnvelope(submission, SUBMISSION_MEDIA_TYPE, trustFixture.requesterKey);

      const outcome = await authenticateRequester(
        { envelopeBytes: envelope, key: trustFixture.requesterKey, requesterAgent: trustFixture.requesterAgent, sealingTime: "2026-01-01T00:00:00Z" },
        { bindingResolver: trustFixture.bindingResolver, dsseVerifier: trustFixture.dsseVerifier },
      );
      expect(outcome.ok).toBe(true);
    });

    test("a Submission signed by a key with no authorizations scope fails authenticateRequester (fail-closed)", async () => {
      const task = sealTask({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        profile: PROFILE_DESCRIPTOR,
        instructions: "§16.2 unauthorized-signer fixture.",
        outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
      });
      const submission = sealSubmission({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        submission: `urn:uuid:${crypto.randomUUID()}`,
        task: { digest: { sha256: sha256Hex(task) } },
        requester: trustFixture.executorAgent, // the executor key has no `authorizations` scope over its own agent either
        idempotencyKey: "conformance-16-2-unauthorized",
        nonce: "nonce-1",
        deadline: "2099-01-01T00:00:00Z",
      });
      const envelope = signedEnvelope(submission, SUBMISSION_MEDIA_TYPE, trustFixture.executorKey);

      const outcome = await authenticateRequester(
        { envelopeBytes: envelope, key: trustFixture.executorKey, requesterAgent: trustFixture.executorAgent, sealingTime: "2026-01-01T00:00:00Z" },
        { bindingResolver: trustFixture.bindingResolver, dsseVerifier: trustFixture.dsseVerifier },
      );
      expect(outcome.ok).toBe(false);
    });

    test("an executor-signed Delivery verifies via verifyEnvelopeBinding (§16.2 executor-signed Deliveries)", async () => {
      const delivery = sealDelivery({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        attempt: `urn:uuid:${crypto.randomUUID()}`,
        task: `sha256:${"c".repeat(64)}`,
        outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: "d".repeat(64) } }],
        outcome: "fulfilled",
        createdAt: "2026-07-28T00:05:00Z",
      });
      const envelope = signedEnvelope(delivery, DELIVERY_MEDIA_TYPE, trustFixture.executorKey);

      const outcome = await verifyEnvelopeBinding(
        {
          envelopeBytes: envelope,
          key: trustFixture.executorKey,
          agent: trustFixture.executorAgent,
          family: MARKETPLACE_FAMILY,
          atTime: "2026-07-28T00:05:00Z",
        },
        {
          bindingResolver: trustFixture.bindingResolver,
          witnessVerifier: { verify1271Witness: async () => ({ verified: true }) },
          dsseVerifier: trustFixture.dsseVerifier,
        },
      );
      expect(outcome.ok).toBe(true);
    });

    test("mandatory evidence: a Delivery missing executionIds/evidenceRecords fails the check (§16.2)", () => {
      const withoutEvidence = {
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        attempt: `urn:uuid:${crypto.randomUUID()}`,
        task: `sha256:${"e".repeat(64)}`,
        outputs: [],
        outcome: "fulfilled",
        createdAt: "2026-07-28T00:05:00Z",
      } as unknown as DeliveryRecord;
      expect(checkMandatoryEvidence(withoutEvidence)).toEqual({
        ok: false,
        reason: "Delivery carries no executionIds (§16.2 requires at least one)",
      });

      const withEvidence = {
        ...withoutEvidence,
        executionIds: [`urn:uuid:${crypto.randomUUID()}`],
        evidenceRecords: [{ family: "execution-evidence", digest: `sha256:${"f".repeat(64)}` }],
      } as unknown as DeliveryRecord;
      expect(checkMandatoryEvidence(withEvidence)).toEqual({ ok: true });
    });

    test("admits only exact Delivery-bound canonical Execution Evidence before inspecting profile fields", async () => {
      const vector = buildDeliveryEvidenceVector();
      await expect(verifyDeliveryBoundExecutionEvidence({
        ...vector,
        resolveRecord: async () => vector.recordBytes,
      })).resolves.toEqual({ ok: true });
    });

    test.each([
      {
        name: "swapped record",
        build: () => {
          const vector = buildDeliveryEvidenceVector();
          const swapped = structuredClone(vector.evidenceDocument);
          const graph = swapped["@graph"] as Record<string, unknown>[];
          const root = graph.find((entity) => entity["@id"] === "./")!;
          root.name = "A different, swapped Execution Evidence record";
          return {
            vector,
            deliveryBytes: vector.deliveryBytes,
            recordBytes: sealCanonicalEvidence(swapped),
            expectedCheck: "execution-evidence-digest",
          };
        },
      },
      {
        name: "digest mismatch",
        build: () => {
          const vector = buildDeliveryEvidenceVector();
          return {
            vector,
            deliveryBytes: replaceEvidenceReferences(vector, [{
              family: "execution-evidence",
              digest: `sha256:${"9".repeat(64)}`,
            }]),
            recordBytes: vector.recordBytes,
            expectedCheck: "execution-evidence-digest",
          };
        },
      },
      {
        name: "noncanonical record",
        build: () => {
          const vector = buildDeliveryEvidenceVector();
          const recordBytes = new TextEncoder().encode(
            `${JSON.stringify(vector.evidenceDocument)}\n`,
          );
          return {
            vector,
            deliveryBytes: replaceEvidenceReferences(vector, [{
              family: "execution-evidence",
              digest: documentDigest(recordBytes),
            }]),
            recordBytes,
            expectedCheck: "execution-evidence-canonical",
          };
        },
      },
      {
        name: "missing reference",
        build: () => {
          const vector = buildDeliveryEvidenceVector();
          return {
            vector,
            deliveryBytes: replaceEvidenceReferences(vector, []),
            recordBytes: vector.recordBytes,
            expectedCheck: "execution-evidence-reference",
          };
        },
      },
      {
        name: "wrong dispatch",
        build: () => {
          const vector = buildDeliveryEvidenceVector({
            dispatchDigest: `sha256:${"8".repeat(64)}`,
          });
          return {
            vector,
            deliveryBytes: vector.deliveryBytes,
            recordBytes: vector.recordBytes,
            expectedCheck: "dispatch-binding",
          };
        },
      },
      {
        name: "wrong evaluation spec",
        build: () => {
          const vector = buildDeliveryEvidenceVector({
            evaluationDigest: `sha256:${"7".repeat(64)}`,
          });
          return {
            vector,
            deliveryBytes: vector.deliveryBytes,
            recordBytes: vector.recordBytes,
            expectedCheck: "evaluation-specification",
          };
        },
      },
    ] as const)("refuses $name with the full named-check outcome", async ({ build }) => {
      const { vector, deliveryBytes, recordBytes, expectedCheck } = build();
      await expect(verifyDeliveryBoundExecutionEvidence({
        taskBytes: vector.taskBytes,
        deliveryBytes,
        dispatchContextBytes: vector.dispatchContextBytes,
        resolveRecord: async () => recordBytes,
      })).resolves.toEqual({
        ok: false,
        failures: [{
          check: expectedCheck,
          detail: expect.any(String),
        }],
      });
    });
  });
}
