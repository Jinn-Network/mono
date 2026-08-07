import { describe, expect, it, vi } from 'vitest';
import type { BackendCapabilities, TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import {
  documentDigest,
  sealSubmission,
  sealTask,
} from '@jinn-network/task-execution-protocol';
import { RECORD_KINDS } from '@jinn-network/record-discovery-protocol';
import {
  PREDICTION_FORECAST_PROFILE_URI,
  buildPredictionForecastProfile,
  sealTaskProfile,
} from '@jinn-network/task-execution-profiles';
import { DEFAULT_SUBMISSION_DEADLINE_LEAD_MS } from '@jinn-network/marketplace-binding';
import {
  evaluateNativeClaim,
  type NativeClaimEvaluationInput,
} from '../../src/daemon/native-claim-policy.js';
import { buildNativeClaimPolicy } from '../../src/daemon/native-assembly.js';

const COORDINATOR = '0x8a34793e10595c89b7e41cc7ff0f76850f44ad98' as const;
const SUBMISSION_URI = 'urn:uuid:11111111-1111-4111-8111-111111111111' as const;
const profile = sealTaskProfile(buildPredictionForecastProfile());

function documents(
  deadline = '2026-08-02T01:00:00.000Z',
  requirements: Record<string, unknown> = {
    harness: { id: 'prediction-v1-baseline' },
    isolationPolicy: 'process',
  },
) {
  const taskBytes = sealTask({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    profile: { uri: PREDICTION_FORECAST_PROFILE_URI, digest: { sha256: profile.digest.slice(7) } },
    instructions: 'Return the pinned forecast.',
    payload: {
      forecast: {
        marketId: 'golden',
        question: 'Will it pass?',
        consensusProbabilityYes: '0.75',
        observedAt: '2026-08-01T00:00:00.000Z',
        resolvesAt: '2026-08-03T00:00:00.000Z',
      },
    },
    outputs: [{ name: 'prediction', mediaType: 'application/json', required: true }],
    requirements,
  });
  const submissionBytes = sealSubmission({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    submission: SUBMISSION_URI,
    task: { digest: { sha256: documentDigest(taskBytes).slice(7) } },
    requester: 'urn:jinn:requester:one',
    idempotencyKey: 'golden-1',
    nonce: 'nonce-1',
    deadline,
    requirements,
  });
  return { taskBytes, submissionBytes };
}

function capabilities(overrides: Partial<BackendCapabilities> = {}): BackendCapabilities {
  return {
    taskProfiles: [PREDICTION_FORECAST_PROFILE_URI],
    inputMediaTypes: ['application/json'],
    outputMediaTypes: ['application/json'],
    cancel: false,
    watch: false,
    preflight: true,
    fetchArtifact: false,
    confidentialInputs: false,
    signedObservations: true,
    signedDeliveries: true,
    evidenceCapture: 'always',
    deadlineEnforcement: true,
    isolation: ['process'],
    attempts: {},
    runPinning: {
      keys: [
        { key: 'harness', inventory: ['prediction-v1-baseline'], posture: 'enforced' },
        { key: 'isolationPolicy', inventory: ['process'], posture: 'enforced' },
      ],
    },
    ...overrides,
  };
}

function backend(input: {
  caps?: BackendCapabilities;
  preflight?: TaskExecutionBackend['preflight'];
} = {}): TaskExecutionBackend {
  return {
    capabilities: async () => input.caps ?? capabilities(),
    preflight: input.preflight ?? (async () => ({ ready: true })),
    submit: async () => { throw new Error('not used in B5'); },
    observe: async () => { throw new Error('not used in B5'); },
    deliveries: async () => [],
    fetchDelivery: async () => { throw new Error('not used in B5'); },
    recover: async () => { throw new Error('not used in B5'); },
  };
}

function input(overrides: Partial<NativeClaimEvaluationInput> = {}): NativeClaimEvaluationInput {
  const docs = documents();
  return {
    card: {
      record: { kind: RECORD_KINDS.submission, digest: documentDigest(docs.submissionBytes) },
      facts: {
        taskDigest: documentDigest(docs.taskBytes),
        taskProfileUri: PREDICTION_FORECAST_PROFILE_URI,
        workKind: PREDICTION_FORECAST_PROFILE_URI,
        requirements: { harness: { id: 'prediction-v1-baseline' }, isolationPolicy: 'process' },
      },
      chain: { taskId: 7n, submission: SUBMISSION_URI, nonce: 'nonce-1', intendedSpendWei: 2n },
      discovery: {
        source: { agent: 'urn:jinn:requester:one', name: 'native-requester' },
        sequence: '0000000000000001',
        entryDigest: `sha256:${'7'.repeat(64)}`,
        signedHighWater: {
          sequence: '0000000000000001',
          entry: `sha256:${'7'.repeat(64)}`,
          issuedAt: '2026-08-02T00:00:00.000Z',
          refreshBy: '2026-08-03T00:00:00.000Z',
          signature: {},
        },
      },
    },
    taskBytes: docs.taskBytes,
    submissionBytes: docs.submissionBytes,
    backend: backend(),
    launcher: {
      inspect: async () => ({
        launcherId: 'prediction-v1-baseline',
        taskProfiles: [PREDICTION_FORECAST_PROFILE_URI],
        executable: { path: '/opt/jinn/node', digest: 'a'.repeat(64) },
        probe: { ready: true, executable: { path: '/opt/jinn/node', digest: 'a'.repeat(64) } },
      }),
    },
    policy: {
      chainId: 84532,
      coordinator: COORDINATOR,
      generation: 'today',
      maxSpendWei: 10n,
      minDeadlineLeadMs: 60_000,
      maxConcurrent: 1,
    },
    activeEngagements: 0,
    canonicalFinalized: true,
    now: new Date('2026-08-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('evaluateNativeClaim', () => {
  it('joins exact documents, backend inventory, launcher probe, preflight, and Tier 4 policy', async () => {
    const result = await evaluateNativeClaim(input());
    expect(result).toMatchObject({
      ok: true,
      facts: { profileUri: PREDICTION_FORECAST_PROFILE_URI },
      capability: {
        ok: true,
        backend: { taskProfiles: [PREDICTION_FORECAST_PROFILE_URI] },
        launcher: { launcherId: 'prediction-v1-baseline', probe: { ready: true } },
        preflight: { ready: true },
      },
      policy: { ok: true },
    });
  });

  it('fails closed when capability or launcher ports are missing and classifies dependency failures', async () => {
    const missingCapabilities = backend();
    (missingCapabilities as { capabilities?: unknown }).capabilities = undefined;
    await expect(evaluateNativeClaim(input({ backend: missingCapabilities }))).resolves.toMatchObject({
      ok: false, reason: 'capability-unavailable', retryable: true,
    });
    await expect(evaluateNativeClaim(input({ launcher: undefined }))).resolves.toMatchObject({
      ok: false, reason: 'launcher-capability-unavailable', retryable: false,
    });
    await expect(evaluateNativeClaim(input({
      launcher: { inspect: async () => ({
        launcherId: 'prediction-v1-baseline',
        taskProfiles: [PREDICTION_FORECAST_PROFILE_URI],
        executable: { path: '/missing', digest: 'unresolved' },
        probe: { ready: false, detail: 'missing executable' },
      }) },
    }))).resolves.toMatchObject({ ok: false, reason: 'launcher-probe-failed', retryable: true });
  });

  it('refuses unsupported profiles and requirements before backend preflight', async () => {
    const preflight = vi.fn(async () => ({ ready: true }));
    await expect(evaluateNativeClaim(input({
      backend: backend({ caps: capabilities({ taskProfiles: [] }), preflight }),
    }))).resolves.toMatchObject({ ok: false, reason: 'profile-mismatch', retryable: false });
    expect(preflight).not.toHaveBeenCalled();

    const docs = documents('2026-08-02T01:00:00.000Z', { gpu: 'h100' });
    await expect(evaluateNativeClaim(input({
      taskBytes: docs.taskBytes,
      submissionBytes: docs.submissionBytes,
      card: {
        ...input().card,
        record: { kind: RECORD_KINDS.submission, digest: documentDigest(docs.submissionBytes) },
        facts: {
          ...input().card.facts,
          taskDigest: documentDigest(docs.taskBytes),
          requirements: { gpu: 'h100' },
        },
      },
      backend: backend({ preflight }),
    }))).resolves.toMatchObject({ ok: false, reason: 'unsupported-requirement', retryable: false });
  });

  it('captures backend preflight refusal and error without claiming', async () => {
    await expect(evaluateNativeClaim(input({
      backend: backend({ preflight: async () => ({ ready: false, detail: 'launcher offline' }) }),
    }))).resolves.toMatchObject({ ok: false, reason: 'preflight-not-ready', retryable: true });
    await expect(evaluateNativeClaim(input({
      backend: backend({ preflight: async () => { throw new Error('probe exploded'); } }),
    }))).resolves.toMatchObject({ ok: false, reason: 'preflight-not-ready', retryable: true });
  });

  it.each([
    ['preflight-unavailable', { preflight: false }],
    ['unsigned-deliveries', { signedDeliveries: false }],
    ['evidence-unavailable', { evidenceCapture: 'none' }],
    ['deadline-unenforced', { deadlineEnforcement: false }],
    ['output-media-type-unsupported', { outputMediaTypes: [] }],
  ] as const)('refuses settlement-incomplete backend capability: %s', async (reason, capabilityOverride) => {
    await expect(evaluateNativeClaim(input({
      backend: backend({ caps: capabilities(capabilityOverride as Partial<BackendCapabilities>) }),
    }))).resolves.toMatchObject({ ok: false, reason, retryable: false });
  });

  it('requires every effective run pin to be enforced rather than merely attested', async () => {
    await expect(evaluateNativeClaim(input({
      backend: backend({ caps: capabilities({
        runPinning: {
          keys: [
            { key: 'harness', inventory: ['prediction-v1-baseline'], posture: 'attested' },
            { key: 'isolationPolicy', inventory: ['process'], posture: 'enforced' },
          ],
        },
      }) }),
    }))).resolves.toMatchObject({ ok: false, reason: 'run-pinning-not-enforced', retryable: false });
  });

  it('requires the preflight port to be callable even when capabilities advertise it', async () => {
    const subject = backend();
    (subject as { preflight?: unknown }).preflight = undefined;
    await expect(evaluateNativeClaim(input({ backend: subject })))
      .resolves.toMatchObject({ ok: false, reason: 'preflight-unavailable', retryable: false });
  });

  it.each([
    ['network-policy', { policy: { ...input().policy, chainId: 8453 } }],
    ['unsupported-profile', { policy: { ...input().policy, allowedProfiles: [] } }],
    ['spend-policy', { policy: { ...input().policy, maxSpendWei: 1n } }],
    ['deadline-policy', { now: new Date('2026-08-02T00:59:30.000Z') }],
    ['capacity-policy', { activeEngagements: 1 }],
    ['finality-policy', { canonicalFinalized: false }],
  ] as const)('refuses %s before any claim intent', async (reason, overrides) => {
    await expect(evaluateNativeClaim(input(overrides as Partial<NativeClaimEvaluationInput>)))
      .resolves.toMatchObject({ ok: false, reason });
  });

  // --- issue #2526: the deadline predicate against a REAL posting ------------------------------
  //
  // The block above pins the predicate against the suite's own 60s lead. This one joins the two
  // production constants that actually decide leg 3 — the requester's sealed lead
  // (`DEFAULT_SUBMISSION_DEADLINE_LEAD_MS`) and the shipped claim policy's floor
  // (`buildNativeClaimPolicy().minDeadlineLeadMs`) — because the live gate's failure was precisely
  // that nobody had ever evaluated one against the other.
  describe('deadline predicate against production constants', () => {
    const POLICY = buildNativeClaimPolicy({
      chainId: 84532,
      generation: 'today',
      contracts: {
        taskCoordinator: COORDINATOR,
        jinnRouter: '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247',
        mechMarketplace: '0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7',
        activityChecker: '0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70',
      },
      transactionCaps: { escrowMaxWei: '10' },
    });
    /** The authority instant a posting seals against, and the wall clock a solver discovers it at. */
    const POSTED_AT = '2026-08-02T00:00:00.000Z';

    function atDeadline(deadline: string, overrides: Partial<NativeClaimEvaluationInput> = {}) {
      const docs = documents(deadline);
      const base = input();
      return input({
        taskBytes: docs.taskBytes,
        submissionBytes: docs.submissionBytes,
        card: {
          ...base.card,
          record: { kind: RECORD_KINDS.submission, digest: documentDigest(docs.submissionBytes) },
          facts: { ...base.card.facts, taskDigest: documentDigest(docs.taskBytes) },
        },
        policy: { ...POLICY, maxSpendWei: 10n },
        now: new Date(POSTED_AT),
        ...overrides,
      });
    }

    /** Exactly what `sealedDeadline` produces for a posting whose authority time is `POSTED_AT`. */
    const freshlySealed = new Date(
      Date.parse(POSTED_AT) + DEFAULT_SUBMISSION_DEADLINE_LEAD_MS,
    ).toISOString();

    it('accepts a freshly posted task on the deadline predicate', async () => {
      await expect(evaluateNativeClaim(atDeadline(freshlySealed)))
        .resolves.toMatchObject({ ok: true, policy: { ok: true } });
    });

    it.each([
      // The live case: the digest-pinned fixture literal, five days stale at task 1218's post time.
      ['the pinned fixture literal at a later post time', '2026-08-02T12:00:00Z', '2026-08-07T15:30:00.000Z'],
      ['a past deadline', '2026-08-01T23:59:59.000Z', POSTED_AT],
      // One millisecond inside the floor — the boundary, not a comfortable miss.
      ['a deadline one ms inside the minimum lead',
        new Date(Date.parse(POSTED_AT) + 5 * 60 * 1_000 - 1).toISOString(), POSTED_AT],
    ])('still refuses %s, non-retryably', async (_label, deadline, now) => {
      await expect(evaluateNativeClaim(atDeadline(deadline, { now: new Date(now) })))
        .resolves.toMatchObject({ ok: false, reason: 'deadline-policy', retryable: false });
    });

    it('leaves the sealed lead comfortably clear of the floor rather than exactly on it', () => {
      // `responseTimeoutSeconds` is capped at 300s by the deployed marketplace and the floor is
      // also 300s, so a deadline derived from the posting terms would clear by zero. This pins that
      // the lead the requester actually seals is not that value.
      expect(DEFAULT_SUBMISSION_DEADLINE_LEAD_MS).toBeGreaterThan(POLICY.minDeadlineLeadMs * 2);
    });
  });

  it('rejects a bridge card or any exact-byte identity mismatch', async () => {
    await expect(evaluateNativeClaim(input({
      card: { ...input().card, derivationKind: 'legacy', legacyManifestDigest: '0xlegacy' },
    }))).resolves.toMatchObject({ ok: false, reason: 'legacy-card', retryable: false });
    await expect(evaluateNativeClaim(input({ taskBytes: new TextEncoder().encode('{}') })))
      .resolves.toMatchObject({ ok: false, reason: 'sealed-document-mismatch', retryable: false });
  });
});
