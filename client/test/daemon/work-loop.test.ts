/**
 * The work loop (Task 13). Fixtures are inlined here rather than in a separate
 * `_work-loop-fixtures.ts` — that file is not in this task's write scope (see the execution
 * report). `composition()` drives the REAL `runPipeline` (`@jinn-network/marketplace-pipeline`)
 * through a full claim -> finalized -> submit -> deliver -> settle happy path by default, using
 * unsigned sealed documents (`sealTask`/`sealSubmission`/`sealDelivery`) the same way
 * `packages/marketplace/pipeline/src/pipeline.test.ts` does, so the ordering assertions below
 * exercise the real pipeline sequencing, not a stubbed-out shortcut.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
  sha256Hex,
} from '@jinn-network/task-execution-protocol';
import { RECORD_KINDS } from '@jinn-network/record-discovery-protocol';
import {
  TaskExecutionError,
  type BackendCapabilities,
  type DeliveryRef,
  type TaskExecutionBackend,
} from '@jinn-network/task-execution-backend';
import {
  BASE_SEPOLIA_TODAY,
  deriveMarketplaceAttemptUri,
  keccakEvidenceHash,
} from '@jinn-network/marketplace-binding';
import {
  takeEveryRunnable,
  type ExecutionWiringEntry,
  type PipelineConfig,
  type PipelinePorts,
} from '@jinn-network/marketplace-pipeline';
import type { BaseVenue, BaseVenueSafeBroadcaster } from '@jinn-network/marketplace-venue-base';
import { Store } from '../../src/store/store.js';
import { EngagementLedger } from '../../src/daemon/engagement-ledger.js';
import { WorkLoop, type WorkLoopConfig } from '../../src/daemon/work-loop.js';
import type { ClaimGate } from '../../src/daemon/claim-gate.js';
import type { OperatorComposition } from '../../src/daemon/composition-root.js';
import {
  LEGACY_SUBMISSION_RECORD_KIND,
  type AnnouncedSubmissionCard,
} from '../../src/daemon/native-submission-facts.js';

const PROFILE_URI = 'https://spec.jinn.network/task-profiles/repository-work/1.0';
const WORK_KIND = 'repo-fix';
const TASK_ID = 7n;
const TASK_DIGEST_HEX = 'a'.repeat(64);
const TASK_DIGEST = `sha256:${TASK_DIGEST_HEX}` as const;
const SUBMISSION_URI = 'urn:uuid:22222222-2222-4222-8222-222222222222' as const;
const NONCE = 'nonce-1';
const REQUEST_ID = `0x${'b'.repeat(64)}` as const;
const CLAIM_TX = `0x${'c'.repeat(64)}` as const;
const ATTEMPT_INDEX = 3;
const SAFE_ADDRESS = `0x${'5'.repeat(40)}` as const;

const ATTEMPT_URI = deriveMarketplaceAttemptUri({
  chainId: BASE_SEPOLIA_TODAY.chainId,
  coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
  taskId: TASK_ID,
  attemptIndex: ATTEMPT_INDEX,
});

const WIRING: readonly ExecutionWiringEntry[] = [
  {
    workKind: WORK_KIND,
    harness: 'claude-code',
    model: 'claude-haiku',
    plugins: [],
    credentialRef: 'cred-1',
    isolationPolicy: 'process',
  },
];

function goldenTask(): Uint8Array {
  return sealTask({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    profile: { uri: PROFILE_URI, digest: { sha256: TASK_DIGEST_HEX } },
    instructions: 'Fix the failing test.',
    outputs: [{ name: 'patch', mediaType: 'text/x-diff', required: true }],
  });
}

function goldenSubmission(): Uint8Array {
  return sealSubmission({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    submission: SUBMISSION_URI,
    task: { digest: { sha256: TASK_DIGEST_HEX } },
    requester: 'urn:uuid:33333333-3333-4333-8333-333333333333',
    idempotencyKey: 'key-1',
    nonce: NONCE,
    deadline: '2099-01-01T00:00:00Z',
  });
}

function goldenDelivery(): Uint8Array {
  return sealDelivery({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    attempt: ATTEMPT_URI,
    task: TASK_DIGEST,
    outputs: [],
    outcome: 'fulfilled',
    executionIds: ['urn:uuid:44444444-4444-4444-8444-444444444444'],
    evidenceRecords: [{ family: 'execution-evidence', digest: `sha256:${'2'.repeat(64)}` }],
    createdAt: '2026-07-29T00:00:00Z',
  });
}

function card(): AnnouncedSubmissionCard {
  return {
    record: { kind: RECORD_KINDS.submission, digest: `sha256:${'d'.repeat(64)}` },
    facts: {
      taskDigest: TASK_DIGEST,
      taskProfileUri: PROFILE_URI,
      workKind: WORK_KIND,
    },
    chain: {
      taskId: TASK_ID,
      submission: SUBMISSION_URI,
      nonce: NONCE,
      intendedSpendWei: 1n,
    },
  };
}

// E39 diagnose→fix cycle 1: a legacy-bridged card, as `bridge-legacy-delivery.ts`'s
// `synthesizeLegacyFactsCard` actually produces one -- `facts` carries no `workKind` at all (the
// projector has no wiring context to resolve one from), and `derivationKind`/`legacyManifestDigest`
// mark it as legacy per `facts-mapper.ts`'s own contract.
const LEGACY_MANIFEST_DIGEST = `0x${'e'.repeat(64)}`;

function legacyCard(): AnnouncedSubmissionCard {
  return {
    record: { kind: LEGACY_SUBMISSION_RECORD_KIND, digest: `sha256:${'d'.repeat(64)}` },
    facts: {
      taskDigest: TASK_DIGEST,
      taskProfileUri: PROFILE_URI,
    },
    chain: {
      taskId: TASK_ID,
      submission: SUBMISSION_URI,
      nonce: NONCE,
      intendedSpendWei: 1n,
    },
    derivationKind: 'legacy',
    legacyManifestDigest: LEGACY_MANIFEST_DIGEST,
  };
}

// The operator's wiring, as it would actually be configured for a bridged legacy SolverNet: one
// entry keyed by the human `workKind`, declaring which anchored manifest digest it bridges.
const LEGACY_WIRING: readonly ExecutionWiringEntry[] = [
  { ...WIRING[0]!, legacyManifestDigest: LEGACY_MANIFEST_DIGEST },
];

function backendCapabilities(): BackendCapabilities {
  return {
    taskProfiles: [PROFILE_URI],
    inputMediaTypes: ['application/json'],
    outputMediaTypes: ['application/json'],
    cancel: false,
    watch: false,
    preflight: true,
    fetchArtifact: false,
    confidentialInputs: false,
    signedObservations: false,
    signedDeliveries: false,
    evidenceCapture: 'none',
    deadlineEnforcement: false,
    isolation: [],
    attempts: {},
    runPinning: { keys: [] },
  };
}

interface CompositionHooks {
  onClaimBroadcast?: () => void;
  onMechDeliver?: () => void;
  onDeliveryClassify?: () => void;
  onReadMechFacts?: () => void;
  onAwaitIndexed?: () => void;
  onSettled?: () => void;
  /** Forces `runPipeline` to a specific non-happy-path outcome (submit rejected post-claim). */
  pipelineOutcome?: { readonly detail: string; readonly released: boolean };
}

/** Drives the REAL `runPipeline` through a full claim -> ... -> delivered happy path by default. */
function composition(hooks: CompositionHooks = {}): OperatorComposition {
  const deliveryBytes = goldenDelivery();
  const sha256Digest = `sha256:${sha256Hex(deliveryBytes)}` as const;
  const keccak = keccakEvidenceHash(deliveryBytes);

  const backend: TaskExecutionBackend = {
    capabilities: async () => backendCapabilities(),
    preflight: async () => ({ ready: true }),
    submit:
      hooks.pipelineOutcome !== undefined
        ? async () => ({
            accepted: false,
            error: new TaskExecutionError('backend-unavailable', {
              message: hooks.pipelineOutcome!.detail,
            }),
          })
        : async () => ({ accepted: true, submission: SUBMISSION_URI, digest: TASK_DIGEST }),
    observe: async () => {
      throw new Error('work-loop test: observe not used');
    },
    deliveries: async (): Promise<DeliveryRef[]> => [],
    fetchDelivery: async () => {
      throw new Error('work-loop test: fetchDelivery not used');
    },
    recover: async () => {
      throw new Error('work-loop test: recover not used');
    },
  };

  const pipelinePorts: PipelinePorts = {
    claim: {
      taskDigest: TASK_DIGEST,
      submission: SUBMISSION_URI,
      nonce: NONCE,
      priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace,
      capabilityMatch: async () => ({ ok: true }),
      claimTask: async () => {
        hooks.onClaimBroadcast?.();
        return { attemptIndex: ATTEMPT_INDEX, requestId: REQUEST_ID, txHash: CLAIM_TX };
      },
    },
    finality: { awaitFinalized: async () => ({ ok: true }) },
    deliveryWait: { waitForDelivery: async () => ({ ok: true, deliveryBytes }) },
    settlement: {
      pin: async () => undefined,
      verifySettlementGrade: async () => ({
        executorBinding: { status: 'verified' },
        dispatchBinding: { status: 'verified' },
        evaluationSpecification: { status: 'not-applicable' },
      }),
      readMechDeliveryFacts: async () => {
        hooks.onReadMechFacts?.();
        return { requestId: REQUEST_ID, sha256CidDigest: sha256Digest };
      },
      readRouterDeliveryFacts: async () => ({
        generation: 'today',
        requestId: REQUEST_ID,
        keccakEvidenceHash: keccak,
      }),
      claimSolutionDelivery: async () => {
        hooks.onSettled?.();
        return { status: 'settled' };
      },
    },
    ipfs: { pin: async () => undefined },
    release: {
      releaseAttempt:
        hooks.pipelineOutcome?.released === false
          ? async () => ({ ok: false, kind: 'unsupported' })
          : async () => undefined,
    },
  };

  const venueSafe: BaseVenueSafeBroadcaster = {
    broadcastCreateTask: async () => {
      throw new Error('work-loop test: broadcastCreateTask not used');
    },
    execute: async () => {
      hooks.onMechDeliver?.();
      // Short-circuits `deliverToMarketplace` to its idempotent "already" branch via
      // `classify()` below, without needing a real decodable `Deliver` event log.
      throw new Error('already delivered');
    },
    classify: () => {
      hooks.onDeliveryClassify?.();
      return 'already-settled';
    },
  };

  return {
    mode: 'legacy',
    backend,
    pipelineConfig: {
      chain: BASE_SEPOLIA_TODAY,
      predicate: takeEveryRunnable(),
      caps: { spendCapWei: 10n ** 30n, aiUnitCap: Number.MAX_SAFE_INTEGER },
      wiring: WIRING,
      priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace,
    } satisfies PipelineConfig,
    pipelinePorts,
    venue: { safe: venueSafe } as unknown as BaseVenue,
    deliveryBroadcaster: venueSafe,
    evidence: {
      runtime: {} as never,
      ports: {
        repository: {} as never,
        catalog: {} as never,
        awaitIndexed: async (reference) => {
          hooks.onAwaitIndexed?.();
          return { status: 'indexed', reference, projection: undefined };
        },
      },
      close: async () => undefined,
    } as never,
    chain: BASE_SEPOLIA_TODAY,
    safeAddress: SAFE_ADDRESS,
    mechAddress: BASE_SEPOLIA_TODAY.mechMarketplace as `0x${string}`,
    // C7 workKind seam (finding E24): a no-op fixture is enough here -- these tests exercise the
    // ledger/pipeline ordering, not the legacy bridge. `composition-root.test.ts` covers the real
    // wiring; `client/test/bridge/*` covers the seam producing a real Delivery.
    noteAttemptWorkKind: () => undefined,
    close: async () => undefined,
  };
}

function openGate(): ClaimGate {
  return { isOpen: () => true, waitUntilOpen: async () => undefined };
}

function closedGate(): ClaimGate {
  return { isOpen: () => false, waitUntilOpen: async () => undefined };
}

function build(overrides: Record<string, unknown> = {}) {
  const store = new Store(':memory:');
  return {
    store,
    ledger: new EngagementLedger(store),
    loop: new WorkLoop({
      composition: composition(),
      archive: { since: async () => [card()] },
      ledger: new EngagementLedger(store),
      claimGate: openGate(),
      store,
      estimateAiUnits: () => 1,
      readSealedDocuments: async () => ({
        taskBytes: goldenTask(),
        submissionBytes: goldenSubmission(),
      }),
      pollIntervalMs: 5,
      acceptLegacyCards: true,
      ...overrides,
    } as WorkLoopConfig),
  };
}

describe('work loop', () => {
  it('uses the verified native queue and never falls through to the legacy archive adapter', async () => {
    const archiveSince = vi.fn(async () => [card()]);
    const sync = vi.fn(async () => ({ accepted: 0, verifiedSources: 1 }));
    const takePending = vi.fn(() => []);
    const coordinator = {
      startWorker: vi.fn(),
      renewWorker: vi.fn(),
      reconcileStartup: vi.fn(async () => ({ reconciled: 0, finalized: 0 })),
      process: vi.fn(),
    };
    const solutionCoordinator = {
      reconcileStartup: vi.fn(async () => []),
      reconcileEngagement: vi.fn(),
    };
    const corrections = { reconcile: vi.fn(async () => undefined) };
    const { loop } = build({
      composition: { ...composition(), mode: 'native' },
      archive: undefined,
      nativeDiscovery: {
        sync,
        takePending,
        takePendingWithdrawals: () => [],
        acknowledge: vi.fn(),
        acknowledgeWithdrawal: vi.fn(),
        checkpoint: () => undefined,
        resumeSse: () => ({ close: () => undefined }),
      },
      nativeClaimCoordinator: coordinator,
      nativeSolutionCoordinator: solutionCoordinator,
      nativeSolutionCorrections: corrections,
      acceptLegacyCards: false,
    });

    await loop.initialize();
    await expect(loop.tick()).resolves.toEqual([]);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(takePending).toHaveBeenCalledOnce();
    expect(coordinator.renewWorker).toHaveBeenCalledOnce();
    expect(solutionCoordinator.reconcileStartup).toHaveBeenCalledOnce();
    expect(archiveSince).not.toHaveBeenCalled();
    // The signed reorg-correction pass runs once per tick, and NOT during initialize() --
    // initialization owns the worker and reconciles chain effects; correcting already-published
    // announcements is per-tick work that must precede each source read.
    expect(corrections.reconcile).toHaveBeenCalledOnce();
  });

  it('initializes native ownership, reconciliation, and verified source sync in that order', async () => {
    const order: string[] = [];
    const { loop } = build({
      composition: { ...composition(), mode: 'native' },
      archive: undefined,
      acceptLegacyCards: false,
      nativeDiscovery: {
        sync: vi.fn(async () => { order.push('sync'); return { accepted: 0, verifiedSources: 1 }; }),
        takePending: () => { order.push('take-pending'); return []; },
        takePendingWithdrawals: () => { order.push('withdrawals'); return []; },
        acknowledge: vi.fn(),
        acknowledgeWithdrawal: vi.fn(),
        checkpoint: () => undefined,
        resumeSse: () => ({ close: () => undefined }),
      },
      nativeClaimCoordinator: {
        startWorker: () => { order.push('lease'); },
        renewWorker: () => { order.push('renew'); },
        reconcileStartup: async () => { order.push('reconcile'); return { reconciled: 0, finalized: 0 }; },
        process: vi.fn(),
      },
      nativeSolutionCoordinator: {
        reconcileStartup: async () => { order.push('solution-reconcile'); return []; },
        reconcileEngagement: vi.fn(),
      },
      nativeSolutionCorrections: {
        reconcile: async () => { order.push('corrections'); },
      },
    });
    await loop.initialize();
    expect(order).toEqual(['lease', 'reconcile', 'solution-reconcile', 'sync']);
    await loop.tick();
    // Per tick, and every step's position is load-bearing:
    //   renew        - own the worker lease before touching anything.
    //   corrections  - correct this operator's own published announcements against the canonical
    //                  chain BEFORE accepting a source head. Correcting after the read would let a
    //                  card be admitted while a reorged delivery still advertises as available.
    //   sync         - the verified signed-head gate. A stale/tampered/rewound head rejects here.
    //   withdrawals  - drain the requester's signed retractions BEFORE deciding what to claim, so
    //                  a retracted announcement cannot be picked up in the same pass that learned
    //                  of its retraction.
    //   take-pending - only now is the queue read.
    expect(order).toEqual([
      'lease', 'reconcile', 'solution-reconcile', 'sync',
      'renew', 'corrections', 'sync', 'withdrawals', 'take-pending',
    ]);
  });

  it('fails an idle native tick before source sync when lease renewal fails', async () => {
    const sync = vi.fn();
    const { loop } = build({
      composition: { ...composition(), mode: 'native' },
      archive: undefined,
      acceptLegacyCards: false,
      nativeDiscovery: {
        sync,
        takePending: () => [],
        takePendingWithdrawals: () => [],
        acknowledge: vi.fn(),
        acknowledgeWithdrawal: vi.fn(),
        checkpoint: () => undefined,
        resumeSse: () => ({ close: () => undefined }),
      },
      nativeClaimCoordinator: {
        startWorker: vi.fn(),
        renewWorker: () => { throw new Error('lease expired'); },
        reconcileStartup: vi.fn(async () => ({ reconciled: 0, finalized: 0 })),
        process: vi.fn(),
      },
      nativeSolutionCoordinator: {
        reconcileStartup: vi.fn(async () => []),
        reconcileEngagement: vi.fn(),
      },
      nativeSolutionCorrections: { reconcile: vi.fn(async () => undefined) },
    });
    await loop.initialize();
    sync.mockClear();
    await expect(loop.tick()).rejects.toThrow('lease expired');
    expect(sync).not.toHaveBeenCalled();
  });

  it('routes a verified native card only through the durable claim coordinator and never acknowledges separately', async () => {
    const nativeCard: AnnouncedSubmissionCard = {
      ...card(),
      discovery: {
        source: { agent: 'urn:jinn:requester:one', name: 'requester' },
        sequence: '0000000000000001',
        entryDigest: `sha256:${'a'.repeat(64)}`,
        signedHighWater: {
          sequence: '0000000000000001',
          entry: `sha256:${'a'.repeat(64)}`,
          issuedAt: '2026-08-02T00:00:00.000Z',
          refreshBy: '2026-08-03T00:00:00.000Z',
          signature: {},
        },
      },
    };
    const queued = { id: 1, announcementId: 'announcement-1', card: nativeCard };
    const acknowledge = vi.fn();
    const process = vi.fn(async () => ({
      kind: 'claim-finalized' as const,
      operationId: `sha256:${'b'.repeat(64)}` as const,
      engagementId: `sha256:${'c'.repeat(64)}` as const,
    }));
    const readSealedDocuments = vi.fn(async () => ({
      taskBytes: goldenTask(),
      submissionBytes: goldenSubmission(),
    }));
    const reconcileEngagement = vi.fn(async () => ({ kind: 'solution-settled' as const, operationId: `sha256:${'d'.repeat(64)}` as const }));
    const { loop } = build({
      composition: { ...composition(), mode: 'native' },
      archive: undefined,
      acceptLegacyCards: false,
      nativeDiscovery: {
        sync: async () => ({ accepted: 0, verifiedSources: 1 }),
        takePending: () => [queued],
        takePendingWithdrawals: () => [],
        acknowledge,
        acknowledgeWithdrawal: vi.fn(),
        checkpoint: () => undefined,
        resumeSse: () => ({ close: () => undefined }),
      },
      nativeClaimCoordinator: {
        startWorker: vi.fn(),
        renewWorker: vi.fn(),
        reconcileStartup: vi.fn(async () => ({ reconciled: 0, finalized: 0 })),
        process,
      },
      nativeSolutionCoordinator: {
        reconcileStartup: vi.fn(async () => []),
        reconcileEngagement,
      },
      nativeSolutionCorrections: { reconcile: vi.fn(async () => undefined) },
      readSealedDocuments,
    });

    await loop.initialize();
    await expect(loop.tick()).resolves.toEqual([{
      card: SUBMISSION_URI,
      outcome: { kind: 'native-claim', result: expect.objectContaining({ kind: 'claim-finalized' }) },
    }]);
    expect(readSealedDocuments).toHaveBeenCalledWith(nativeCard);
    expect(process).toHaveBeenCalledWith(queued, await readSealedDocuments.mock.results[0]!.value);
    expect(reconcileEngagement).toHaveBeenCalledWith(`sha256:${'c'.repeat(64)}`);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('refuses to claim before the projector catch-up gate opens', async () => {
    const { loop } = build({ claimGate: closedGate() });
    expect(await loop.tick()).toEqual([
      { card: expect.any(String), outcome: { kind: 'skipped', reason: 'gate-closed' } },
    ]);
  });

  it('writes the ledger row before the claim broadcast', async () => {
    const order: string[] = [];
    const store = new Store(':memory:');
    const ledger = new EngagementLedger(store);
    const admit = vi.spyOn(ledger, 'admitClaimIntent').mockImplementation((...args) => {
      order.push('ledger');
      return EngagementLedger.prototype.admitClaimIntent.apply(ledger, args as never);
    });
    const loop = new WorkLoop({
      composition: composition({ onClaimBroadcast: () => order.push('broadcast') }),
      archive: { since: async () => [card()] },
      ledger,
      claimGate: openGate(),
      store,
      estimateAiUnits: () => 1,
      readSealedDocuments: async () => ({
        taskBytes: goldenTask(),
        submissionBytes: goldenSubmission(),
      }),
      pollIntervalMs: 5,
      acceptLegacyCards: true,
    } as WorkLoopConfig);
    await loop.tick();
    expect(order).toEqual(['ledger', 'broadcast']);
    expect(admit).toHaveBeenCalledOnce();
  });

  it('never claims the same task twice across ticks', async () => {
    const { loop, ledger } = build();
    await loop.tick();
    const second = await loop.tick();
    expect(second[0]!.outcome).toEqual({ kind: 'skipped', reason: 'already-engaged' });
    expect(ledger.listUnreconciled().length).toBeLessThanOrEqual(1);
  });

  // Close-out C1: the engagement ledger row gets the claim's requestId at claim time, so
  // `settlement-grade.ts`'s dispatchBinding check can later correlate a today-generation
  // settlement back to it.
  it('persists the claim receipt requestId on the ledger row', async () => {
    const { loop, ledger } = build();
    await loop.tick();
    const key = `${BASE_SEPOLIA_TODAY.chainId}:${BASE_SEPOLIA_TODAY.taskCoordinator}:${TASK_ID.toString()}`;
    expect(ledger.get(key)!.requestId).toBe(REQUEST_ID);
  });

  // Finding E35 (ruled): the work loop seals the dispatch-context document once, at claim time,
  // into the engagement-ledger row it already owns.
  describe('dispatch-context seal (E35)', () => {
    const key = `${BASE_SEPOLIA_TODAY.chainId}:${BASE_SEPOLIA_TODAY.taskCoordinator}:${TASK_ID.toString()}`;

    // The exact document `claimAttempt` (packages/marketplace/binding/src/claim.ts) builds
    // in-memory for this same claim -- taskDigest/submission/nonce from the card's facts, attempt
    // from the same deterministic derivation this fixture's own `ATTEMPT_URI` uses.
    function expectedDispatchContextBytes(): Uint8Array {
      return serializeCanonicalJson({
        taskDigest: TASK_DIGEST,
        submission: SUBMISSION_URI,
        nonce: NONCE,
        attempt: ATTEMPT_URI,
      });
    }

    it('persists the sealed dispatch-context digest and exact bytes on the ledger row', async () => {
      const { loop, ledger } = build();
      await loop.tick();
      const row = ledger.get(key)!;
      const expectedBytes = expectedDispatchContextBytes();
      expect(row.dispatchContextDigest).toBe(documentDigest(expectedBytes));
      expect(new Uint8Array(Buffer.from(row.dispatchContextBytes!, 'base64'))).toEqual(expectedBytes);
    });

    it('seals byte-stably: the same claim inputs always produce the same digest', async () => {
      const first = build();
      await first.loop.tick();
      const firstDigest = first.ledger.get(key)!.dispatchContextDigest;

      const second = build();
      await second.loop.tick();
      const secondDigest = second.ledger.get(key)!.dispatchContextDigest;

      expect(firstDigest).not.toBeNull();
      expect(firstDigest).toBe(secondDigest);
      expect(firstDigest).toBe(documentDigest(expectedDispatchContextBytes()));
    });
  });

  it('sends the mech Deliver leg before settlement reads its facts', async () => {
    const order: string[] = [];
    const { loop } = build({
      composition: composition({
        onMechDeliver: () => order.push('deliver'),
        onReadMechFacts: () => order.push('read-facts'),
      }),
    });
    await loop.tick();
    expect(order).toEqual(['deliver', 'read-facts']);
  });

  it('supplies the delivery broadcaster error classifier to the real deliver leg', async () => {
    const classify = vi.fn();
    const { loop } = build({ composition: composition({ onDeliveryClassify: classify }) });

    await loop.tick();

    expect(classify).toHaveBeenCalledOnce();
  });

  it('awaits evidence indexing before recording settlement', async () => {
    const order: string[] = [];
    const { loop } = build({
      composition: composition({
        onAwaitIndexed: () => order.push('await-indexed'),
        onSettled: () => order.push('settled'),
      }),
    });
    await loop.tick();
    expect(order).toEqual(['settled', 'await-indexed']);
  });

  it('logs the unreleased-attempt state message when a post-claim failure did not release', async () => {
    const warn = vi.fn();
    const { loop } = build({
      composition: composition({
        pipelineOutcome: { detail: 'backend refused', released: false },
      }),
      logger: { info: vi.fn(), warn },
    });
    await loop.tick();
    expect(warn.mock.calls.flat().join('\n')).toContain('unreleased attempt');
  });

  it('respects the SQLite rolling-window AI-unit cap', async () => {
    const { loop } = build({
      aiUnits: { capPerBlockUsdMicros: 1, capPerWeekUsdMicros: 1, credentialId: 'c' },
      estimateAiUnits: () => 10_000,
    });
    expect((await loop.tick())[0]!.outcome).toEqual({
      kind: 'skipped',
      reason: 'ai-units-capped',
    });
  });

  // Finding E39 (diagnose→fix cycle 1): `mapAnnouncedSubmissionToFacts` sets `facts.workKind` to
  // the raw anchored manifest digest for a legacy-bridged card -- the projector that synthesizes
  // it has no wiring context to resolve a human workKind from. Left unresolved, every wiring
  // lookup downstream (this loop's own `resolveWiringEntry` call, and `runPipeline`'s internal
  // one) fails, and the card is refused regardless of the operator's actual wiring config.
  describe('legacy-bridged workKind resolution (E39)', () => {
    const key = `${BASE_SEPOLIA_TODAY.chainId}:${BASE_SEPOLIA_TODAY.taskCoordinator}:${TASK_ID.toString()}`;

    it('resolves the wiring workKind for a legacy card by its anchored manifest digest, and the full pipeline runs', async () => {
      const base = composition();
      const comp: OperatorComposition = {
        ...base,
        pipelineConfig: { ...base.pipelineConfig, wiring: LEGACY_WIRING },
      };
      const { loop, ledger } = build({
        composition: comp,
        archive: { since: async () => [legacyCard()] },
      });

      const [{ outcome }] = await loop.tick();

      expect(outcome).toEqual({
        kind: 'pipeline',
        result: { kind: 'delivered', state: expect.anything() },
      });
      expect(ledger.get(key)!.workKind).toBe(WORK_KIND);
    });

    it('leaves workKind unresolved (and declines) when no wiring entry declares a matching manifest digest', async () => {
      const { loop } = build({
        // Default WIRING (no `legacyManifestDigest` on any entry) -> no match possible.
        archive: { since: async () => [legacyCard()] },
      });

      const [{ outcome }] = await loop.tick();

      expect(outcome).toEqual({
        kind: 'pipeline',
        result: { kind: 'not-claimed', reason: 'wiring-missing' },
      });
    });
  });

  // Finding E39: `WorkLoopOutcome`s were computed and discarded every tick, leaving an operator
  // (or a diagnostic session) with no way to see why an announced card was not claimed. These
  // tests cover the permanent fix: a structured per-tick log line naming each card's outcome,
  // deduped so a steady-state loop does not spam the same line every poll.
  describe('per-tick outcome logging (E39)', () => {
    it('names each card outcome in a structured log line', async () => {
      const info = vi.fn();
      const { loop } = build({ claimGate: closedGate(), logger: { info, warn: vi.fn() } });

      await loop.tick();

      expect(info).toHaveBeenCalledOnce();
      const payload = JSON.parse(info.mock.calls[0]![0] as string) as {
        component: string;
        cards: { card: string; workKind: string; reason: string }[];
      };
      expect(payload.component).toBe('work');
      expect(payload.cards).toEqual([
        { card: SUBMISSION_URI, workKind: WORK_KIND, reason: 'gate-closed' },
      ]);
    });

    it('does not re-log an unchanged outcome set on the next tick', async () => {
      const info = vi.fn();
      const { loop } = build({ claimGate: closedGate(), logger: { info, warn: vi.fn() } });

      await loop.tick();
      await loop.tick();

      expect(info).toHaveBeenCalledOnce();
    });

    it('re-logs once the outcome set changes', async () => {
      const info = vi.fn();
      let open = false;
      const flippingGate: ClaimGate = {
        isOpen: () => open,
        waitUntilOpen: async () => undefined,
      };
      const { loop } = build({ claimGate: flippingGate, logger: { info, warn: vi.fn() } });

      await loop.tick();
      open = true;
      await loop.tick();

      expect(info).toHaveBeenCalledTimes(2);
      const second = JSON.parse(info.mock.calls[1]![0] as string) as {
        cards: { reason: string }[];
      };
      expect(second.cards[0]!.reason).not.toBe('gate-closed');
    });

    it('logs the zero-cards case, distinguishing an empty archive from a skipped card', async () => {
      const info = vi.fn();
      const { loop } = build({
        archive: { since: async () => [] },
        logger: { info, warn: vi.fn() },
      });

      await loop.tick();

      expect(info).toHaveBeenCalledOnce();
      const payload = JSON.parse(info.mock.calls[0]![0] as string) as { cards: unknown[] };
      expect(payload.cards).toEqual([]);
    });
  });

  /**
   * #2540. `reconcileStartup()` ran only in `initialize()`, and `tick()` processes only PENDING
   * discovery cards — a card is acknowledged inside the coordinator's claim-admission
   * transaction, so once a claim is admitted nothing re-drives it. Task 1221 sat at claim
   * `observed-safe` for 35 minutes with the projector's finalized cursor 855 blocks past it;
   * restarting the daemon advanced it to `finalized` in 35 seconds. Round 7's task 1220 shows the
   * same signature — promoted 42ms before its restart's startup event.
   *
   * The property under test is exactly the acceptance criterion: an ADMITTED claim reaches its
   * terminal on-chain state with NO restart.
   */
  describe('steady-state reconcile (#2540)', () => {
    /**
     * A claim coordinator standing in for the live shape: the card is admitted once and then
     * disappears from the pending queue (acknowledged inside admission), and the operation needs a
     * later canonical promotion that only a reconcile pass can observe.
     */
    function admittedClaimAwaitingPromotion() {
      const state = { admitted: false, terminal: false, promotions: 0 };
      const queued = { id: 1, announcementId: 'announcement-1', card: card() };
      const claim = {
        startWorker: vi.fn(),
        renewWorker: vi.fn(),
        reconcileStartup: vi.fn(async () => {
          if (!state.admitted || state.terminal) return { reconciled: 0, finalized: 0 };
          state.promotions += 1;
          // The live promotion: observed-safe becomes finalized once the projector catches up.
          state.terminal = true;
          return { reconciled: 1, finalized: 1 };
        }),
        process: vi.fn(async () => {
          state.admitted = true;
          return { kind: 'claim-pending' as const, operationId: `sha256:${'b'.repeat(64)}` as const, reason: 'observed-safe' as const };
        }),
      };
      return { state, queued, claim };
    }

    function nativeBuild(overrides: Record<string, unknown>, extras: Record<string, unknown> = {}) {
      return build({
        composition: { ...composition(), mode: 'native' },
        archive: undefined,
        acceptLegacyCards: false,
        nativeSolutionCorrections: { reconcile: vi.fn(async () => undefined) },
        ...overrides,
        ...extras,
      });
    }

    it('drives an admitted claim to its terminal state with no restart', async () => {
      const { state, queued, claim } = admittedClaimAwaitingPromotion();
      let pending = [queued];
      let now = 0;
      const { loop } = nativeBuild({
        nativeDiscovery: {
          sync: async () => ({ accepted: 0, verifiedSources: 1 }),
          takePending: () => pending,
          takePendingWithdrawals: () => [],
          acknowledge: vi.fn(),
          acknowledgeWithdrawal: vi.fn(),
          checkpoint: () => undefined,
          resumeSse: () => ({ close: () => undefined }),
        },
        nativeClaimCoordinator: claim,
        nativeSolutionCoordinator: { reconcileStartup: vi.fn(async () => []), reconcileEngagement: vi.fn() },
        nativeReconcileIntervalMs: 30_000,
        now: () => now,
      });

      await loop.initialize();
      await loop.tick();                       // admits the claim; it is now unacknowledged nowhere
      pending = [];                            // acknowledged inside admission — nothing re-drives it
      expect(state.admitted).toBe(true);
      expect(state.terminal).toBe(false);

      // Ticking inside the cadence changes nothing — the frozen state the live gate observed.
      now = 10_000;
      await loop.tick();
      expect(state.terminal).toBe(false);

      // One cadence later, with no restart and no new card, the claim reaches its terminal state.
      now = 40_000;
      await loop.tick();
      expect(state.terminal).toBe(true);
      expect(state.promotions).toBe(1);
    });

    it('reconciles claims and solutions in the same order initialize() does', async () => {
      const order: string[] = [];
      let now = 0;
      const { loop } = nativeBuild({
        nativeDiscovery: {
          sync: async () => ({ accepted: 0, verifiedSources: 1 }),
          takePending: () => [],
          takePendingWithdrawals: () => [],
          acknowledge: vi.fn(),
          acknowledgeWithdrawal: vi.fn(),
          checkpoint: () => undefined,
          resumeSse: () => ({ close: () => undefined }),
        },
        nativeClaimCoordinator: {
          startWorker: vi.fn(),
          renewWorker: vi.fn(),
          reconcileStartup: vi.fn(async () => { order.push('claim'); return { reconciled: 0, finalized: 0 }; }),
          process: vi.fn(),
        },
        nativeSolutionCoordinator: {
          reconcileStartup: vi.fn(async () => { order.push('solution'); return []; }),
          reconcileEngagement: vi.fn(),
        },
        nativeReconcileIntervalMs: 1_000,
        now: () => now,
      });

      await loop.initialize();
      order.length = 0;
      now = 5_000;
      await loop.tick();

      expect(order).toStrictEqual(['claim', 'solution']);
    });

    // Isolation, the same lesson as #2529/#2530/#2533/#2539: a recovery that cannot run is not a
    // reason to stop taking new work.
    it('keeps claiming when the steady-state reconcile fails, and names the cause', async () => {
      const warn = vi.fn();
      let now = 0;
      const process = vi.fn(async () => ({
        kind: 'claim-finalized' as const,
        operationId: `sha256:${'b'.repeat(64)}` as const,
        engagementId: `sha256:${'c'.repeat(64)}` as const,
      }));
      const { loop } = nativeBuild({
        nativeDiscovery: {
          sync: async () => ({ accepted: 0, verifiedSources: 1 }),
          takePending: () => [{ id: 1, announcementId: 'announcement-1', card: card() }],
          takePendingWithdrawals: () => [],
          acknowledge: vi.fn(),
          acknowledgeWithdrawal: vi.fn(),
          checkpoint: () => undefined,
          resumeSse: () => ({ close: () => undefined }),
        },
        nativeClaimCoordinator: {
          startWorker: vi.fn(),
          renewWorker: vi.fn(),
          // Boot reconciles fine; the chain read goes away afterwards. `initialize()` stays
          // fail-fast — it is the STEADY-STATE reconcile whose failure must not cost a claim.
          reconcileStartup: (() => {
            let calls = 0;
            return vi.fn(async (): Promise<{ reconciled: number; finalized: number }> => {
              calls += 1;
              if (calls === 1) return { reconciled: 0, finalized: 0 };
              throw new Error('canonical claim read unavailable');
            });
          })(),
          process,
        },
        nativeSolutionCoordinator: { reconcileStartup: vi.fn(async () => []), reconcileEngagement: vi.fn() },
        nativeReconcileIntervalMs: 1_000,
        now: () => now,
        logger: { info: vi.fn(), warn },
      });

      await loop.initialize();
      now = 5_000;
      const results = await loop.tick();

      expect(process).toHaveBeenCalledOnce();
      expect(results).toHaveLength(1);
      expect((warn.mock.calls.at(-1)![0] as string)).toContain('canonical claim read unavailable');
    });

    /**
     * The secondary defect. `logOutcomes` deduped identical summaries with no time bound, so B
     * logged one line at 03:12:06 and nothing for 25 minutes while ticking normally — a healthy
     * idle loop was indistinguishable from a dead one, and the wrong diagnosis cost a round.
     */
    it('re-logs an unchanged tick summary once the silence bound elapses', async () => {
      const info = vi.fn();
      let now = 0;
      const { loop } = build({
        archive: { since: async () => [] },
        logger: { info, warn: vi.fn() },
        tickSummaryMaxSilenceMs: 60_000,
        now: () => now,
      });

      await loop.tick();
      expect(info).toHaveBeenCalledOnce();

      now = 30_000;
      await loop.tick();
      expect(info).toHaveBeenCalledOnce();      // still deduped inside the bound

      now = 61_000;
      await loop.tick();
      expect(info).toHaveBeenCalledTimes(2);    // and audible again once it elapses
    });
  });
});
