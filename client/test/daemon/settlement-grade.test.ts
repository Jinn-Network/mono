/**
 * `verifySettlementGrade` for real (cutover stage 1, close-out C6; executor-binding shape per
 * finding E31 close-out). Proof obligations (see `../../src/daemon/settlement-grade.ts`'s file
 * header for what each check does and does not prove):
 *
 *  - A today-mode solution delivery settles end-to-end via the real binding `settleDelivery`
 *    (not by eyeballing statuses).
 *  - Each check has a negative test proving it rejects when it should.
 *  - `evaluationSpecification: "not-applicable"` does not reject settlement.
 *  - `executorBinding`'s cryptographic signature check is genuine: a real Ed25519 keypair signs
 *    real DSSE envelopes via Node's built-in `crypto`, and flipping a signature byte flips the
 *    verification result.
 *  - `executorBinding` sources its envelope from the injected `getDeliverySignature(digest)` port
 *    (finding E31) rather than a Delivery extension field -- one describe block below drives a
 *    REAL `LocalTaskExecutionBackend` end to end to prove the production envelope this port would
 *    actually be backed by (`LocalTaskExecutionBackend.getDeliverySignature`) verifies here too.
 */
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { sealDsseEnvelope, dssePreAuthEncoding } from '@jinn-network/trust-core';
import {
  BASE_SEPOLIA_TODAY,
  keccakEvidenceHash,
  settleDelivery,
  type SettlementAttempt,
  type SettlementPorts,
} from '@jinn-network/marketplace-binding';
import { documentDigest, sealDelivery, sealSubmission, sealTask, sha256Hex } from '@jinn-network/task-execution-protocol';
import type { TaskProfileDocument } from '@jinn-network/task-execution-profiles';
import { buildRepositoryWorkProfile, sealTaskProfile, type ProfileStore } from '@jinn-network/task-execution-profiles';
import { makeLocalTaskExecutionBackend } from '@jinn-network/task-execution-backend-local';
import type { LauncherContract } from '@jinn-network/task-execution-launchers';
import type { ProvisionerContract } from '@jinn-network/task-execution-workspace';
import { Store } from '../../src/store/store.js';
import { EngagementLedger, type EngagementRow } from '../../src/daemon/engagement-ledger.js';
import {
  EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE,
  buildVerifySettlementGrade,
  type BuildVerifySettlementGradeInput,
  type EngagementLedgerReader,
} from '../../src/daemon/settlement-grade.js';

const TASK_COORDINATOR = BASE_SEPOLIA_TODAY.taskCoordinator;
const REQUEST_ID = `0x${'a'.repeat(64)}` as const;
const DISPATCH_DIGEST = `sha256:${'c'.repeat(64)}` as const;
const EVALUATION_DIGEST = `sha256:${'d'.repeat(64)}` as const;
const ATTEMPT_URI = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const EXECUTION_URI = 'urn:uuid:22222222-2222-4222-8222-222222222222';
const EXECUTOR_KEY_ID = 'did:key:z6MkTestExecutorKey';

// ── Real Ed25519 signing (test-only key material; never used outside this file) ────────────────

const executorKeyPair = generateKeyPairSync('ed25519');
const otherKeyPair = generateKeyPairSync('ed25519');

function signPreAuth(privateKey: KeyObject, payloadType: string, payloadBytes: Uint8Array): Uint8Array {
  const preAuth = dssePreAuthEncoding(payloadType, payloadBytes);
  return new Uint8Array(cryptoSign(null, preAuth, privateKey));
}

/** Builds a canonical Delivery document's fields. */
function baseDeliveryFields() {
  return {
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    attempt: ATTEMPT_URI,
    task: `sha256:${'1'.repeat(64)}`,
    outputs: [],
    outcome: 'fulfilled' as const,
    executionIds: [EXECUTION_URI],
    evidenceRecords: [{ family: 'execution-evidence' as const, digest: `sha256:${'2'.repeat(64)}` as const }],
    createdAt: '2026-07-29T00:00:00Z',
  };
}

/**
 * Seals a genuine, verifiable executor-binding DSSE envelope over `deliveryBytes` -- signed by
 * `signerKeyPair`, under `keyid`, optionally with a tampering hook to produce adversarial
 * fixtures. Finding E31 close-out: the envelope is carried OUTSIDE the Delivery document (never
 * embedded, never re-sealed -- seal-once), so this only ever returns the envelope bytes; callers
 * wire them through `getDeliverySignature`, exactly as `composition-root.ts` wires the real
 * `LocalTaskExecutionBackend.getDeliverySignature`.
 */
function sealExecutorBindingEnvelope(deliveryBytes: Uint8Array, input: {
  readonly signerKeyPair?: { privateKey: KeyObject };
  readonly keyid?: string;
  readonly payloadType?: string;
  readonly tamperPayload?: (bytes: Uint8Array) => Uint8Array;
  readonly tamperSignature?: (sig: Uint8Array) => Uint8Array;
} = {}): Uint8Array {
  const payloadType = input.payloadType ?? EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE;
  const signer = input.signerKeyPair ?? executorKeyPair;
  const keyid = input.keyid ?? EXECUTOR_KEY_ID;
  let signature = signPreAuth(signer.privateKey, payloadType, deliveryBytes);
  if (input.tamperSignature) signature = input.tamperSignature(signature);
  const payloadBytes = input.tamperPayload ? input.tamperPayload(deliveryBytes) : deliveryBytes;
  return sealDsseEnvelope({ payloadBytes, payloadType, signatures: [{ signature, keyid }] });
}

/** A `getDeliverySignature` port that answers only for one digest -- mirrors how the real
 * backend's digest-keyed lookup behaves for a single produced Delivery. */
function getDeliverySignatureFor(
  digest: `sha256:${string}`,
  envelope: Uint8Array,
): (candidate: `sha256:${string}`) => Uint8Array | undefined {
  return (candidate) => (candidate === digest ? envelope : undefined);
}

function digestOf(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}

// ── Fakes for the other two checks ───────────────────────────────────────────────────────────

function fakeEngagementLedger(
  rows: Readonly<Record<string, EngagementRow>> = {},
  byRequestId: Readonly<Record<string, EngagementRow>> = {},
): EngagementLedgerReader {
  return {
    get: (idempotencyKey) => rows[idempotencyKey],
    getByRequestId: (requestId) => byRequestId[requestId],
  };
}

function engagementRow(overrides: Partial<EngagementRow> = {}): EngagementRow {
  return {
    idempotencyKey: `${BASE_SEPOLIA_TODAY.chainId}:${TASK_COORDINATOR}:7`,
    chainId: BASE_SEPOLIA_TODAY.chainId,
    taskCoordinator: TASK_COORDINATOR,
    taskId: '7',
    workKind: 'QmSolver',
    wiringJson: '{}',
    attemptIndex: 3,
    attemptUri: 'urn:jinn:attempt:...',
    claimTxHash: '0xclaimtxhash',
    // Finding E35: sealed at claim time, matches REVISED_ATTEMPT/TODAY_ATTEMPT's
    // expectedDispatchContextDigest below by default -- individual tests override to prove the
    // mismatch/absence cases fail.
    dispatchContextDigest: DISPATCH_DIGEST,
    dispatchContextBytes: null,
    outcome: 'claimed',
    createdAt: '2026-07-29T00:00:00Z',
    updatedAt: '2026-07-29T00:00:00Z',
    ...overrides,
  };
}

function fakeProfileStore(entries: Readonly<Record<string, unknown>> = {}) {
  return {
    get: (digest: `sha256:${string}`) =>
      entries[digest] === undefined ? undefined : (entries[digest] as TaskProfileDocument),
  };
}

function buildInput(overrides: Partial<BuildVerifySettlementGradeInput> = {}): BuildVerifySettlementGradeInput {
  return {
    profileStore: fakeProfileStore(),
    engagementLedger: fakeEngagementLedger(),
    executorKeyId: EXECUTOR_KEY_ID,
    executorPublicKey: executorKeyPair.publicKey,
    getDeliverySignature: () => undefined,
    ...overrides,
  };
}

const REVISED_ATTEMPT: SettlementAttempt = {
  taskId: 7n,
  attemptIndex: 3,
  expectedDispatchContextDigest: DISPATCH_DIGEST,
};

// ── Unit tests: each check in isolation ──────────────────────────────────────────────────────

describe('buildVerifySettlementGrade: executorBinding', () => {
  test('missing when no executor-binding envelope was recorded for this digest', async () => {
    const verify = buildVerifySettlementGrade(buildInput());
    const delivery = sealDelivery(baseDeliveryFields());
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: digestOf(delivery),
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding.status).toBe('missing');
  });

  test('invalid when the signature does not verify against the expected key', async () => {
    const delivery = sealDelivery(baseDeliveryFields());
    const digest = digestOf(delivery);
    const envelope = sealExecutorBindingEnvelope(delivery, { signerKeyPair: otherKeyPair });
    const verify = buildVerifySettlementGrade(buildInput({ getDeliverySignature: getDeliverySignatureFor(digest, envelope) }));
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: digest,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding).toEqual({
      status: 'invalid',
      detail: expect.stringContaining('does not verify against the expected key') as unknown as string,
    });
  });

  test('invalid when the envelope carries no signature under the expected keyid', async () => {
    const delivery = sealDelivery(baseDeliveryFields());
    const digest = digestOf(delivery);
    const envelope = sealExecutorBindingEnvelope(delivery, { keyid: 'did:key:zSomeoneElsesKey' });
    const verify = buildVerifySettlementGrade(buildInput({ getDeliverySignature: getDeliverySignatureFor(digest, envelope) }));
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: digest,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding).toEqual({
      status: 'invalid',
      detail: expect.stringContaining('no signature by expected key') as unknown as string,
    });
  });

  test('invalid when a signature byte is flipped (genuine cryptographic check, not eyeballed)', async () => {
    const delivery = sealDelivery(baseDeliveryFields());
    const digest = digestOf(delivery);
    const envelope = sealExecutorBindingEnvelope(delivery, {
      tamperSignature: (sig) => {
        const flipped = new Uint8Array(sig);
        flipped[0] = flipped[0]! ^ 0xff;
        return flipped;
      },
    });
    const verify = buildVerifySettlementGrade(buildInput({ getDeliverySignature: getDeliverySignatureFor(digest, envelope) }));
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: digest,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding.status).toBe('invalid');
  });

  test('invalid when the envelope payload is not the exact settling Delivery bytes (seal-once check)', async () => {
    const delivery = sealDelivery(baseDeliveryFields());
    const digest = digestOf(delivery);
    // The envelope was genuinely signed, but over bytes OTHER than the settling delivery's own --
    // exactly what a re-canonicalization / substitution attempt would look like.
    const envelope = sealExecutorBindingEnvelope(delivery, {
      tamperPayload: (bytes) => new Uint8Array([...bytes, 0x20]),
    });
    const verify = buildVerifySettlementGrade(buildInput({ getDeliverySignature: getDeliverySignatureFor(digest, envelope) }));
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: digest,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding).toEqual({
      status: 'invalid',
      detail: expect.stringContaining('not the exact settling Delivery bytes') as unknown as string,
    });
  });

  test('verified when genuinely signed by the expected key over the exact delivery bytes', async () => {
    const delivery = sealDelivery(baseDeliveryFields());
    const digest = digestOf(delivery);
    const envelope = sealExecutorBindingEnvelope(delivery);
    const verify = buildVerifySettlementGrade(buildInput({ getDeliverySignature: getDeliverySignatureFor(digest, envelope) }));
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: digest,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding).toEqual({ status: 'verified' });
  });
});

describe('buildVerifySettlementGrade: dispatchBinding', () => {
  const delivery = sealDelivery(baseDeliveryFields());
  const baseInput = {
    attempt: REVISED_ATTEMPT,
    delivery: JSON.parse(new TextDecoder().decode(delivery)) as unknown,
    deliveryBytes: delivery,
    deliveryDigest: digestOf(delivery),
    config: BASE_SEPOLIA_TODAY,
  };

  test('missing when no engagement-ledger row correlates to this settlement identity', async () => {
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: fakeEngagementLedger() }));
    const result = await verify(baseInput as Parameters<typeof verify>[0]);
    expect(result.dispatchBinding.status).toBe('missing');
  });

  test('failed when the ledger row names a different attemptIndex', async () => {
    const key = `${BASE_SEPOLIA_TODAY.chainId}:${TASK_COORDINATOR}:7`;
    const ledger = fakeEngagementLedger({ [key]: engagementRow({ attemptIndex: 9 }) });
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: ledger }));
    const result = await verify(baseInput as Parameters<typeof verify>[0]);
    expect(result.dispatchBinding.status).toBe('failed');
  });

  test('failed when the ledger row outcome is not an engaged claim', async () => {
    const key = `${BASE_SEPOLIA_TODAY.chainId}:${TASK_COORDINATOR}:7`;
    const ledger = fakeEngagementLedger({ [key]: engagementRow({ outcome: 'abandoned' }) });
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: ledger }));
    const result = await verify(baseInput as Parameters<typeof verify>[0]);
    expect(result.dispatchBinding.status).toBe('failed');
  });

  test('failed when the ledger row carries no claim transaction hash', async () => {
    const key = `${BASE_SEPOLIA_TODAY.chainId}:${TASK_COORDINATOR}:7`;
    const ledger = fakeEngagementLedger({ [key]: engagementRow({ claimTxHash: null }) });
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: ledger }));
    const result = await verify(baseInput as Parameters<typeof verify>[0]);
    expect(result.dispatchBinding.status).toBe('failed');
  });

  // Finding E35 (ruled): dispatchBinding must actually compare the sealed digest, not just prove
  // a row exists.
  test('failed when the ledger row carries no sealed dispatch-context digest (pre-seal row)', async () => {
    const key = `${BASE_SEPOLIA_TODAY.chainId}:${TASK_COORDINATOR}:7`;
    const ledger = fakeEngagementLedger({ [key]: engagementRow({ dispatchContextDigest: null }) });
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: ledger }));
    const result = await verify(baseInput as Parameters<typeof verify>[0]);
    expect(result.dispatchBinding).toEqual({
      status: 'failed',
      detail: expect.stringContaining('no sealed dispatch-context digest') as unknown as string,
    });
  });

  test('failed when the ledger row seals a different dispatch-context digest than this settlement expects', async () => {
    const key = `${BASE_SEPOLIA_TODAY.chainId}:${TASK_COORDINATOR}:7`;
    const wrongDigest = `sha256:${'9'.repeat(64)}` as const;
    const ledger = fakeEngagementLedger({ [key]: engagementRow({ dispatchContextDigest: wrongDigest }) });
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: ledger }));
    const result = await verify(baseInput as Parameters<typeof verify>[0]);
    expect(result.dispatchBinding).toEqual({
      status: 'failed',
      detail: expect.stringContaining('does not match settling expectedDispatchContextDigest') as unknown as string,
    });
  });

  test('verified when a matching, engaged, claimed ledger row exists', async () => {
    const key = `${BASE_SEPOLIA_TODAY.chainId}:${TASK_COORDINATOR}:7`;
    const ledger = fakeEngagementLedger({ [key]: engagementRow() });
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: ledger }));
    const result = await verify(baseInput as Parameters<typeof verify>[0]);
    expect(result.dispatchBinding).toEqual({ status: 'verified' });
  });
});

describe('buildVerifySettlementGrade: evaluationSpecification', () => {
  const delivery = sealDelivery(baseDeliveryFields());
  const baseCallInput = {
    delivery: JSON.parse(new TextDecoder().decode(delivery)) as unknown,
    deliveryBytes: delivery,
    deliveryDigest: digestOf(delivery),
    config: BASE_SEPOLIA_TODAY,
  };

  test('not-applicable when the attempt carries no taskEvaluationDigest', async () => {
    const verify = buildVerifySettlementGrade(buildInput());
    const attempt: SettlementAttempt = { ...REVISED_ATTEMPT, taskEvaluationDigest: undefined };
    const result = await verify({ ...baseCallInput, attempt } as Parameters<typeof verify>[0]);
    expect(result.evaluationSpecification).toEqual({ status: 'not-applicable' });
  });

  test('missing when the digest does not resolve in the profile store', async () => {
    const verify = buildVerifySettlementGrade(buildInput({ profileStore: fakeProfileStore() }));
    const attempt: SettlementAttempt = { ...REVISED_ATTEMPT, taskEvaluationDigest: EVALUATION_DIGEST };
    const result = await verify({ ...baseCallInput, attempt } as Parameters<typeof verify>[0]);
    expect(result.evaluationSpecification.status).toBe('missing');
  });

  test('verified when the digest resolves in the profile store', async () => {
    const verify = buildVerifySettlementGrade(
      buildInput({ profileStore: fakeProfileStore({ [EVALUATION_DIGEST]: { name: 'spec' } }) }),
    );
    const attempt: SettlementAttempt = { ...REVISED_ATTEMPT, taskEvaluationDigest: EVALUATION_DIGEST };
    const result = await verify({ ...baseCallInput, attempt } as Parameters<typeof verify>[0]);
    expect(result.evaluationSpecification).toEqual({ status: 'verified' });
  });
});

// ── End-to-end: the real binding path (`settleDelivery`), not eyeballed statuses ───────────────
//
// `BASE_SEPOLIA_TODAY` (`generation: "today"`) is the only currently-deployed chain config
// (finding E27) -- the mandatory proof obligation is a TODAY-mode settlement, exercised below via
// `attempt.requestId` (never `taskId`). `dispatchBinding` for today-generation attempts needs the
// `getByRequestId` correlation the real `EngagementLedger` does not implement yet (file header gap
// 2); the fake ledger below supplies it to prove `checkDispatchBinding`'s logic is correct once
// that correlation exists.

const TODAY_ATTEMPT: SettlementAttempt = {
  requestId: REQUEST_ID,
  expectedDispatchContextDigest: DISPATCH_DIGEST,
};

function todayLedgerWithRow(row: Partial<EngagementRow> = {}): EngagementLedgerReader {
  return fakeEngagementLedger(
    {},
    { [REQUEST_ID]: engagementRow({ taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator, ...row }) },
  );
}

function makeSettlementPorts(delivery: Uint8Array, verify: SettlementPorts['verifySettlementGrade']): SettlementPorts {
  const sha256Digest = digestOf(delivery);
  return {
    pin: async () => undefined,
    verifySettlementGrade: verify,
    readMechDeliveryFacts: async () => ({
      requestId: REQUEST_ID,
      sha256CidDigest: sha256Digest,
    }),
    readRouterDeliveryFacts: async () => ({
      generation: 'today',
      requestId: REQUEST_ID,
      keccakEvidenceHash: keccakEvidenceHash(delivery),
    }),
    claimSolutionDelivery: async () => ({ status: 'settled' }),
  };
}

/** A validly signed delivery + the `getDeliverySignature` port that answers for it -- the
 * common case for exercising dispatchBinding/evaluationSpecification in isolation. */
function signedTodayDeliveryAndPorts(engagementLedger: EngagementLedgerReader): {
  readonly delivery: Uint8Array;
  readonly verify: SettlementPorts['verifySettlementGrade'];
  readonly ports: SettlementPorts;
} {
  const delivery = sealDelivery(baseDeliveryFields());
  const digest = digestOf(delivery);
  const envelope = sealExecutorBindingEnvelope(delivery);
  const verify = buildVerifySettlementGrade(
    buildInput({ engagementLedger, getDeliverySignature: getDeliverySignatureFor(digest, envelope) }),
  );
  return { delivery, verify, ports: makeSettlementPorts(delivery, verify) };
}

describe('settleDelivery (real binding path) via buildVerifySettlementGrade', () => {
  test('a today-mode solution delivery settles end-to-end when every check holds', async () => {
    const { delivery, ports } = signedTodayDeliveryAndPorts(todayLedgerWithRow());

    const result = await settleDelivery(TODAY_ATTEMPT, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toEqual({ settled: true, state: 'delivered' });
  });

  test('a solution delivery with no evaluation specification (not-applicable) still settles', async () => {
    const { delivery, ports } = signedTodayDeliveryAndPorts(todayLedgerWithRow());
    const attempt: SettlementAttempt = { ...TODAY_ATTEMPT, taskEvaluationDigest: undefined };

    const result = await settleDelivery(attempt, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toEqual({ settled: true, state: 'delivered' });
  });

  test('rejects when executorBinding is invalid (tampered signature) -- executor-signature-invalid', async () => {
    const delivery = sealDelivery(baseDeliveryFields());
    const digest = digestOf(delivery);
    const envelope = sealExecutorBindingEnvelope(delivery, { signerKeyPair: otherKeyPair });
    const verify = buildVerifySettlementGrade(
      buildInput({ engagementLedger: todayLedgerWithRow(), getDeliverySignature: getDeliverySignatureFor(digest, envelope) }),
    );
    const ports = makeSettlementPorts(delivery, verify);

    const result = await settleDelivery(TODAY_ATTEMPT, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toMatchObject({ settled: false, state: 'rejected', kind: 'executor-signature-invalid' });
  });

  test('rejects when dispatchBinding is missing (no engagement-ledger correlation) -- dispatch-binding-failed', async () => {
    const { delivery, ports } = signedTodayDeliveryAndPorts(fakeEngagementLedger());

    const result = await settleDelivery(TODAY_ATTEMPT, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toMatchObject({ settled: false, state: 'rejected', kind: 'dispatch-binding-failed' });
  });

  test('rejects when evaluationSpecification is missing (digest set, not in profile store) -- evaluation-specification-mismatch', async () => {
    const delivery = sealDelivery(baseDeliveryFields());
    const digest = digestOf(delivery);
    const envelope = sealExecutorBindingEnvelope(delivery);
    const verify = buildVerifySettlementGrade(
      buildInput({
        engagementLedger: todayLedgerWithRow(),
        profileStore: fakeProfileStore(),
        getDeliverySignature: getDeliverySignatureFor(digest, envelope),
      }),
    );
    const ports = makeSettlementPorts(delivery, verify);
    const attempt: SettlementAttempt = { ...TODAY_ATTEMPT, taskEvaluationDigest: EVALUATION_DIGEST };

    const result = await settleDelivery(attempt, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toMatchObject({ settled: false, state: 'rejected', kind: 'evaluation-specification-mismatch' });
  });
});

// ── C1 proof: the REAL EngagementLedger, not a fake ─────────────────────────────────────────
//
// Everything above proves `checkDispatchBinding`'s logic against a fake `EngagementLedgerReader`
// supplying `getByRequestId`. This proves the real class (`../../src/daemon/engagement-ledger.js`)
// now implements that correlation for real, end to end: `admitClaimIntent` + `recordClaimed` (the
// same two calls `work-loop.ts` makes at claim time) populate a row a genuine
// `buildVerifySettlementGrade` port resolves through the real `getByRequestId`.

describe('buildVerifySettlementGrade: dispatchBinding against the real EngagementLedger (C1)', () => {
  const WIRING = {
    workKind: 'QmSolver',
    harness: 'claude-code',
    model: 'claude-haiku-4-5-20251001',
    plugins: [],
    credentialRef: 'claude-code-default',
    isolationPolicy: 'process',
    legacyManifestDigest: 'QmSolver',
  };

  function realLedgerWithClaimedRow(overrides: { requestId?: `0x${string}` } = {}): EngagementLedger {
    const led = new EngagementLedger(new Store(':memory:'));
    const idempotencyKey = `${BASE_SEPOLIA_TODAY.chainId}:${TASK_COORDINATOR}:7`;
    led.admitClaimIntent({
      idempotencyKey,
      chainId: BASE_SEPOLIA_TODAY.chainId,
      taskCoordinator: TASK_COORDINATOR,
      taskId: 7n,
      workKind: 'QmSolver',
      wiring: WIRING,
    });
    led.recordClaimed(idempotencyKey, {
      attemptIndex: 3,
      attemptUri: 'urn:jinn:attempt:...',
      claimTxHash: '0xclaimtxhash',
      requestId: overrides.requestId ?? REQUEST_ID,
      // Finding E35: exercises the real seal-once round-trip through `EngagementLedger`, not a
      // fake -- the bytes' own content is irrelevant to this check (only the digest is compared),
      // so a fixed fixture payload is enough; DISPATCH_DIGEST is what TODAY_ATTEMPT/REVISED_ATTEMPT
      // expect.
      dispatchContext: { digest: DISPATCH_DIGEST, bytes: new TextEncoder().encode('{"fixture":true}') },
    });
    return led;
  }

  test('a today-generation claim recorded through the real ledger verifies dispatchBinding', async () => {
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: realLedgerWithClaimedRow() }));
    const delivery = sealDelivery(baseDeliveryFields());
    const result = await verify({
      attempt: TODAY_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: digestOf(delivery),
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.dispatchBinding).toEqual({ status: 'verified' });
  });

  test('reports missing through the real ledger when no row carries this requestId', async () => {
    const verify = buildVerifySettlementGrade(
      buildInput({ engagementLedger: realLedgerWithClaimedRow({ requestId: `0x${'9'.repeat(64)}` }) }),
    );
    const delivery = sealDelivery(baseDeliveryFields());
    const result = await verify({
      attempt: TODAY_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: digestOf(delivery),
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.dispatchBinding.status).toBe('missing');
  });

  test('a today-mode solution delivery settles end-to-end against the real ledger (not a fake)', async () => {
    const { delivery, ports } = signedTodayDeliveryAndPorts(realLedgerWithClaimedRow());

    const result = await settleDelivery(TODAY_ATTEMPT, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toEqual({ settled: true, state: 'delivered' });
  });
});

// ── Finding E31: end-to-end against a REAL LocalTaskExecutionBackend ────────────────────────
//
// Everything above hand-builds envelopes via trust-core's `sealDsseEnvelope` directly. This
// drives a REAL `LocalTaskExecutionBackend.completeAttempt` -> `getDeliverySignature` pass
// (exactly as `composition-root.ts` wires `trustKeys.deliverySigningKey` and
// `getDeliverySignature`), proving the production envelope this daemon would actually produce
// verifies against this exact checker -- not just a hand-built fixture shaped like one.

describe('executorBinding against a REAL LocalTaskExecutionBackend delivery (finding E31)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const profile = buildRepositoryWorkProfile();
  const sealedProfile = sealTaskProfile(profile);
  const backendProfileStore: ProfileStore = {
    get(digest) {
      return digest === sealedProfile.digest ? profile : undefined;
    },
  };

  async function produceRealSignedDelivery(): Promise<{
    readonly deliveryBytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly getDeliverySignature: (candidate: `sha256:${string}`) => Uint8Array | undefined;
    readonly publicKey: KeyObject;
  }> {
    const stateRoot = await mkdtemp(join(tmpdir(), 'jinn-settlement-grade-e31-'));
    roots.push(stateRoot);
    const keyPair = generateKeyPairSync('ed25519');

    const task = sealTask({
      protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
      profile: { uri: profile.profile, digest: { sha256: sealedProfile.digest.slice('sha256:'.length) } },
      instructions: 'Capture this execution.',
      outputs: [{ name: 'patch', mediaType: 'text/x-diff', required: true }],
    });
    const submissionUri = `urn:uuid:${crypto.randomUUID()}` as const;
    const submission = sealSubmission({
      protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
      submission: submissionUri,
      task: { digest: { sha256: documentDigest(task).slice('sha256:'.length) } },
      requester: 'urn:uuid:40000000-0000-4000-8000-000000000001',
      idempotencyKey: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      deadline: '2099-01-01T00:00:00Z',
    });

    const launcher: LauncherContract = {
      id: 'fixture',
      capabilities: () => ({
        taskProfiles: [profile.profile],
        inputMediaTypes: ['application/json'],
        outputMediaTypes: ['text/x-diff'],
        structuredOutput: false,
        resume: false,
        interruptionBehaviorDefault: 'repeatable',
        secretForwards: [],
        runPinning: { keys: [] },
      }),
      plan(_view, paths) {
        return {
          argv: [process.execPath, '-e', 'process.exit(0)'],
          env: {},
          cwd: paths.work,
          validExitCodes: [0],
          resultContract: { envelopeFormat: 'fixture' },
          interruptionBehavior: 'repeatable',
        };
      },
    };
    const provisioner: ProvisionerContract = {
      workspaceKind: () => 'dir',
      async setup(_view, paths) {
        await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
      },
      executionEnv: ({ env }) => ({ ...env }),
      async harvest() {
        return { manifest: [], omissions: ['patch'], integrityViolations: [] };
      },
    };

    const backend = makeLocalTaskExecutionBackend({
      stateRoot,
      source: 'urn:jinn:operator:0xoperator',
      executor: 'urn:jinn:operator-runtime:test',
      profileStore: backendProfileStore,
      launchers: [launcher],
      provisioner: () => ({ id: 'fixture', contract: provisioner }),
      provisionerCapabilities: {
        taskProfiles: [profile.profile],
        workspaceKinds: ['dir'],
        inputMediaTypes: ['application/json'],
        outputMediaTypes: ['text/x-diff'],
        isolation: ['process'],
      },
      recorderAvailability: 'none',
      // Exactly the shape `composition-root.ts` wires `input.deliverySigningKey` into.
      trustKeys: {
        deliverySigningKey: {
          keyId: EXECUTOR_KEY_ID,
          sign: (payload) => new Uint8Array(cryptoSign(null, payload, keyPair.privateKey)),
        },
      },
    });

    const ack = await backend.submit(task, submission);
    if (!ack.accepted) throw new Error(`submit rejected: ${ack.error.message}`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await backend.observe(ack.submission);
      if (snapshot.descriptor.derived.terminal) {
        if (snapshot.descriptor.derived.state !== 'delivered') {
          throw new Error(`attempt did not deliver: ${snapshot.descriptor.derived.state}`);
        }
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const snapshot = await backend.observe(ack.submission);
    const [deliveryRef] = await backend.deliveries(snapshot.descriptor.attempt);
    if (deliveryRef === undefined) throw new Error('expected exactly one delivery');
    const deliveryBytes = await backend.fetchDelivery(deliveryRef);
    const digest = documentDigest(deliveryBytes);
    return {
      deliveryBytes,
      digest,
      getDeliverySignature: (candidate) => backend.getDeliverySignature(candidate),
      publicKey: keyPair.publicKey,
    };
  }

  test('a delivery this daemon actually produced and signed verifies against checkExecutorBinding', async () => {
    const { deliveryBytes, digest, getDeliverySignature, publicKey } = await produceRealSignedDelivery();
    const verify = buildVerifySettlementGrade(
      buildInput({ executorKeyId: EXECUTOR_KEY_ID, executorPublicKey: publicKey, getDeliverySignature }),
    );
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(deliveryBytes)),
      deliveryBytes,
      deliveryDigest: digest,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding).toEqual({ status: 'verified' });
  });
});
