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
import {
  TRUST_KEY_BINDING_FORMAT,
  authenticateRequester,
  sealDsseEnvelope,
  verifyEnvelopeBinding,
  type BindingResolver,
  type DsseChainVerifier,
  type ResolvedBinding,
} from "@jinn-network/trust-core";
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
  sha256Hex,
  type DeliveryRecord,
  type EvidenceRecordReference,
  type JsonValue,
} from "@jinn-network/task-execution-protocol";
import { sealEvaluationSpec, type EvaluationSpec } from "@jinn-network/task-execution-profiles";
import { describeTaskExecutionBackendContract, type TestableBackend } from "@jinn-network/task-execution-testing";
import { describe, expect, test } from "vitest";

const SUBMISSION_MEDIA_TYPE = "application/vnd.jinn.task-execution.submission.v1+json";
const DELIVERY_MEDIA_TYPE = "application/vnd.jinn.task-execution.delivery.v1+json";
const MARKETPLACE_FAMILY = "jinn:marketplace";

// ---------------------------------------------------------------------------
// Trust test doubles (mirrors `packages/trust/core/src/verify.test.ts`'s own pattern -- no
// `@jinn-network/trust-testing` fixture package exists yet to reuse, per the guard's dated
// comment).
// ---------------------------------------------------------------------------

/** Trusts each DSSE envelope's declared `keyid` without cryptographic verification -- signature
 * *validity* is `trust-core`'s own concern, already covered by its ceremony/DSSE test suites;
 * this isolates the marketplace profile checks' own composition logic under test. */
export function buildTrustingDsseVerifier(): DsseChainVerifier {
  return (envelopeBytes) => {
    // Minimal DSSE-envelope JSON parse: the sealed payload is base64 in `payload`, signatures in
    // `signatures[].keyid`. Avoids importing `parseDsseEnvelope` only to re-derive the same list.
    const parsed = JSON.parse(new TextDecoder().decode(envelopeBytes)) as {
      signatures: { keyid?: string }[];
    };
    return {
      validSignerKeyids: parsed.signatures
        .map((s) => s.keyid)
        .filter((keyid): keyid is string => keyid !== undefined),
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
  return sealDsseEnvelope({ payloadBytes, payloadType, signatures: [{ signature: new Uint8Array([1, 2, 3]), keyid }] });
}

// ---------------------------------------------------------------------------
// Structural §16.2 checks -- exported so a consumer other than this describe-suite can reuse them.
// ---------------------------------------------------------------------------

export type MandatoryEvidenceResult = { ok: true } | { ok: false; reason: string };

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

/** A synthetic `execution-evidence` record shape (structural convention, protocol/src/descriptors.ts). */
export interface SyntheticExecutionEvidenceRecord {
  readonly dispatchContext: { readonly sha256: string };
  readonly evaluationSpecification: { readonly sha256: string };
}

export function sealSyntheticExecutionEvidenceRecord(
  record: SyntheticExecutionEvidenceRecord,
): { bytes: Uint8Array; reference: EvidenceRecordReference } {
  const bytes = serializeCanonicalJson(record as unknown as JsonValue);
  return { bytes, reference: { family: "execution-evidence", digest: documentDigest(bytes) } };
}

export type DispatchBindingResult = { ok: true } | { ok: false; reason: string };

/**
 * The `dispatch-binding` check (design §16.2/§9.3): the referenced `execution-evidence` record's
 * captured inputs must include the per-Attempt dispatch-context artifact's digest. Takes the
 * RESOLVED record bytes (fetched by digest by the caller -- resolution itself is out of lane
 * here, the check is purely digest-comparison over already-resolved content).
 */
export function checkDispatchBinding(input: {
  delivery: DeliveryRecord;
  resolvedExecutionEvidence: SyntheticExecutionEvidenceRecord;
  expectedDispatchContextDigest: `sha256:${string}`;
}): DispatchBindingResult {
  const named = input.delivery.evidenceRecords?.some((ref) => ref.family === "execution-evidence");
  if (named !== true) {
    return { ok: false, reason: "Delivery names no execution-evidence evidenceRecord to check dispatch-binding against" };
  }
  const actual = `sha256:${input.resolvedExecutionEvidence.dispatchContext.sha256}`;
  if (actual !== input.expectedDispatchContextDigest) {
    return {
      ok: false,
      reason: `execution-evidence record's captured dispatchContext digest (${actual}) does not match `
        + `the per-Attempt dispatch-context artifact (${input.expectedDispatchContextDigest})`,
    };
  }
  return { ok: true };
}

export type EvaluationSpecificationDigestResult = { ok: true } | { ok: false; reason: string };

/** The `evaluationSpecification` digest equality check (§16.2): the Evidence's declared digest must equal the Task's sealed `evaluation` descriptor digest. */
export function checkEvaluationSpecificationDigestEquality(input: {
  taskEvaluationDigest: `sha256:${string}`;
  resolvedExecutionEvidence: SyntheticExecutionEvidenceRecord;
}): EvaluationSpecificationDigestResult {
  const actual = `sha256:${input.resolvedExecutionEvidence.evaluationSpecification.sha256}`;
  if (actual !== input.taskEvaluationDigest) {
    return {
      ok: false,
      reason: `Evidence's evaluationSpecification digest (${actual}) does not equal the Task's sealed `
        + `evaluation descriptor digest (${input.taskEvaluationDigest})`,
    };
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

    test("dispatch-binding: the referenced execution-evidence record's captured inputs include the per-Attempt dispatch-context artifact (§9.3)", () => {
      const attempt = `urn:uuid:${crypto.randomUUID()}` as const;
      const dispatchContext = { taskDigest: `sha256:${"1".repeat(64)}`, submission: `urn:uuid:${crypto.randomUUID()}`, nonce: "n", attempt };
      const dispatchContextBytes = serializeCanonicalJson(dispatchContext as unknown as JsonValue);
      const dispatchContextDigest = documentDigest(dispatchContextBytes);

      const executionEvidence: SyntheticExecutionEvidenceRecord = {
        dispatchContext: { sha256: dispatchContextDigest.replace(/^sha256:/, "") },
        evaluationSpecification: { sha256: "0".repeat(64) },
      };
      const { reference } = sealSyntheticExecutionEvidenceRecord(executionEvidence);
      const delivery = {
        evidenceRecords: [reference],
      } as unknown as DeliveryRecord;

      const bound = checkDispatchBinding({ delivery, resolvedExecutionEvidence: executionEvidence, expectedDispatchContextDigest: dispatchContextDigest });
      expect(bound).toEqual({ ok: true });

      const mismatched = checkDispatchBinding({
        delivery,
        resolvedExecutionEvidence: executionEvidence,
        expectedDispatchContextDigest: `sha256:${"9".repeat(64)}`,
      });
      expect(mismatched.ok).toBe(false);
    });

    test("evaluationSpecification digest equality: the Evidence's digest equals the Task's sealed evaluation descriptor digest (§16.2)", () => {
      const sealedSpec = sealEvaluationSpec(GOLDEN_EVALUATION_SPEC);
      const task = sealTask({
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        profile: PROFILE_DESCRIPTOR,
        instructions: "§16.2 evaluationSpecification digest-equality fixture.",
        outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
        evaluation: { digest: { sha256: sealedSpec.digest.replace(/^sha256:/, "") } },
      });
      const taskDoc = JSON.parse(new TextDecoder().decode(task)) as { evaluation?: { digest?: { sha256?: string } } };
      const taskEvaluationDigest = `sha256:${taskDoc.evaluation?.digest?.sha256}` as `sha256:${string}`;

      const matching: SyntheticExecutionEvidenceRecord = {
        dispatchContext: { sha256: "0".repeat(64) },
        evaluationSpecification: { sha256: sealedSpec.digest.replace(/^sha256:/, "") },
      };
      expect(checkEvaluationSpecificationDigestEquality({ taskEvaluationDigest, resolvedExecutionEvidence: matching })).toEqual({ ok: true });

      const mismatched: SyntheticExecutionEvidenceRecord = {
        dispatchContext: { sha256: "0".repeat(64) },
        evaluationSpecification: { sha256: "9".repeat(64) },
      };
      const result = checkEvaluationSpecificationDigestEquality({ taskEvaluationDigest, resolvedExecutionEvidence: mismatched });
      expect(result.ok).toBe(false);
    });
  });
}
