/**
 * `verifySettlementGrade` for real (cutover stage 1, close-out C6). Proof obligations (see
 * `../../src/daemon/settlement-grade.ts`'s file header for what each check does and does not
 * prove):
 *
 *  - A today-mode solution delivery settles end-to-end via the real binding `settleDelivery`
 *    (not by eyeballing statuses).
 *  - Each check has a negative test proving it rejects when it should.
 *  - `evaluationSpecification: "not-applicable"` does not reject settlement.
 *  - `executorBinding`'s cryptographic signature check is genuine: a real Ed25519 keypair signs
 *    real DSSE envelopes via Node's built-in `crypto`, and flipping a signature byte flips the
 *    verification result.
 */
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { sealDsseEnvelope, dssePreAuthEncoding } from '@jinn-network/trust-core';
import {
  BASE_SEPOLIA_TODAY,
  keccakEvidenceHash,
  settleDelivery,
  type SettlementAttempt,
  type SettlementPorts,
} from '@jinn-network/marketplace-binding';
import { sealDelivery, sha256Hex } from '@jinn-network/task-execution-protocol';
import type { TaskProfileDocument } from '@jinn-network/task-execution-profiles';
import { Store } from '../../src/store/store.js';
import { EngagementLedger, type EngagementRow } from '../../src/daemon/engagement-ledger.js';
import {
  EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE,
  EXECUTOR_BINDING_EXTENSION_URI,
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

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Builds a canonical Delivery document's fields (no executor-binding extension yet). */
function baseDeliveryFields() {
  return {
    protocol: 'https://jinn.network/profiles/task-execution/1.0',
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
 * Seals a Delivery carrying a genuine, verifiable executor-binding extension: signs the
 * delivery-minus-extension canonical bytes with `signerKeyPair`, under `keyid`, optionally with a
 * tampering hook to produce adversarial fixtures.
 */
function makeSignedDelivery(input: {
  readonly signerKeyPair?: { privateKey: KeyObject };
  readonly keyid?: string;
  readonly payloadType?: string;
  readonly tamperPayload?: (bytes: Uint8Array) => Uint8Array;
  readonly tamperSignature?: (sig: Uint8Array) => Uint8Array;
}): Uint8Array {
  const unsignedBytes = sealDelivery(baseDeliveryFields());
  const payloadType = input.payloadType ?? EXECUTOR_BINDING_DSSE_PAYLOAD_TYPE;
  const signer = input.signerKeyPair ?? executorKeyPair;
  const keyid = input.keyid ?? EXECUTOR_KEY_ID;
  let signature = signPreAuth(signer.privateKey, payloadType, unsignedBytes);
  if (input.tamperSignature) signature = input.tamperSignature(signature);
  const payloadBytes = input.tamperPayload ? input.tamperPayload(unsignedBytes) : unsignedBytes;
  const envelopeBytes = sealDsseEnvelope({
    payloadBytes,
    payloadType,
    signatures: [{ signature, keyid }],
  });
  return sealDelivery({
    ...baseDeliveryFields(),
    [EXECUTOR_BINDING_EXTENSION_URI]: { envelope: base64(envelopeBytes) },
  });
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
  test('missing when the delivery carries no executor-binding extension', async () => {
    const verify = buildVerifySettlementGrade(buildInput());
    const delivery = sealDelivery(baseDeliveryFields());
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: `sha256:${sha256Hex(delivery)}`,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding.status).toBe('missing');
  });

  test('invalid when the signature does not verify against the expected key', async () => {
    const delivery = makeSignedDelivery({ signerKeyPair: otherKeyPair });
    const verify = buildVerifySettlementGrade(buildInput());
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: `sha256:${sha256Hex(delivery)}`,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding).toEqual({
      status: 'invalid',
      detail: expect.stringContaining('does not verify against the expected key') as unknown as string,
    });
  });

  test('invalid when the envelope carries no signature under the expected keyid', async () => {
    const delivery = makeSignedDelivery({ keyid: 'did:key:zSomeoneElsesKey' });
    const verify = buildVerifySettlementGrade(buildInput());
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: `sha256:${sha256Hex(delivery)}`,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding).toEqual({
      status: 'invalid',
      detail: expect.stringContaining('no signature by expected key') as unknown as string,
    });
  });

  test('invalid when a signature byte is flipped (genuine cryptographic check, not eyeballed)', async () => {
    const delivery = makeSignedDelivery({
      tamperSignature: (sig) => {
        const flipped = new Uint8Array(sig);
        flipped[0] = flipped[0]! ^ 0xff;
        return flipped;
      },
    });
    const verify = buildVerifySettlementGrade(buildInput());
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: `sha256:${sha256Hex(delivery)}`,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding.status).toBe('invalid');
  });

  test('invalid when the signed payload was tampered (does not equal delivery-minus-extension bytes)', async () => {
    const delivery = makeSignedDelivery({
      tamperPayload: (bytes) => new Uint8Array([...bytes, 0x20]),
    });
    const verify = buildVerifySettlementGrade(buildInput());
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: `sha256:${sha256Hex(delivery)}`,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.executorBinding.status).toBe('invalid');
  });

  test('verified when genuinely signed by the expected key over the exact delivery bytes', async () => {
    const delivery = makeSignedDelivery({});
    const verify = buildVerifySettlementGrade(buildInput());
    const result = await verify({
      attempt: REVISED_ATTEMPT,
      delivery: JSON.parse(new TextDecoder().decode(delivery)),
      deliveryBytes: delivery,
      deliveryDigest: `sha256:${sha256Hex(delivery)}`,
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
    deliveryDigest: `sha256:${sha256Hex(delivery)}` as const,
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
    deliveryDigest: `sha256:${sha256Hex(delivery)}` as const,
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
  const sha256Digest = `sha256:${sha256Hex(delivery)}` as const;
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

describe('settleDelivery (real binding path) via buildVerifySettlementGrade', () => {
  test('a today-mode solution delivery settles end-to-end when every check holds', async () => {
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: todayLedgerWithRow() }));
    const delivery = makeSignedDelivery({});
    const ports = makeSettlementPorts(delivery, verify);

    const result = await settleDelivery(TODAY_ATTEMPT, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toEqual({ settled: true, state: 'delivered' });
  });

  test('a solution delivery with no evaluation specification (not-applicable) still settles', async () => {
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: todayLedgerWithRow() }));
    const delivery = makeSignedDelivery({});
    const ports = makeSettlementPorts(delivery, verify);
    const attempt: SettlementAttempt = { ...TODAY_ATTEMPT, taskEvaluationDigest: undefined };

    const result = await settleDelivery(attempt, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toEqual({ settled: true, state: 'delivered' });
  });

  test('rejects when executorBinding is invalid (tampered signature) -- executor-signature-invalid', async () => {
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: todayLedgerWithRow() }));
    const delivery = makeSignedDelivery({ signerKeyPair: otherKeyPair });
    const ports = makeSettlementPorts(delivery, verify);

    const result = await settleDelivery(TODAY_ATTEMPT, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toMatchObject({ settled: false, state: 'rejected', kind: 'executor-signature-invalid' });
  });

  test('rejects when dispatchBinding is missing (no engagement-ledger correlation) -- dispatch-binding-failed', async () => {
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: fakeEngagementLedger() }));
    const delivery = makeSignedDelivery({});
    const ports = makeSettlementPorts(delivery, verify);

    const result = await settleDelivery(TODAY_ATTEMPT, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toMatchObject({ settled: false, state: 'rejected', kind: 'dispatch-binding-failed' });
  });

  test('rejects when evaluationSpecification is missing (digest set, not in profile store) -- evaluation-specification-mismatch', async () => {
    const verify = buildVerifySettlementGrade(
      buildInput({ engagementLedger: todayLedgerWithRow(), profileStore: fakeProfileStore() }),
    );
    const delivery = makeSignedDelivery({});
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
      deliveryDigest: `sha256:${sha256Hex(delivery)}`,
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
      deliveryDigest: `sha256:${sha256Hex(delivery)}`,
      config: BASE_SEPOLIA_TODAY,
    });
    expect(result.dispatchBinding.status).toBe('missing');
  });

  test('a today-mode solution delivery settles end-to-end against the real ledger (not a fake)', async () => {
    const verify = buildVerifySettlementGrade(buildInput({ engagementLedger: realLedgerWithClaimedRow() }));
    const delivery = makeSignedDelivery({});
    const ports = makeSettlementPorts(delivery, verify);

    const result = await settleDelivery(TODAY_ATTEMPT, delivery, BASE_SEPOLIA_TODAY, ports);

    expect(result).toEqual({ settled: true, state: 'delivered' });
  });
});
