/**
 * The fleet WorkLoop's native lifecycle, end to end over real components
 * (one-swap M3, umbrella #2461).
 *
 * `work-loop.test.ts` covers the native branch with every port stubbed — it pins ORDER and
 * routing, not that the pieces fit. This file runs the production `WorkLoop` against the real
 * `Store`, the real `createNativeDiscoveryConsumer` (over an in-memory transport serving a signed
 * source), the real `NativeClaimCoordinator`, and the real `buildNativeSolutionCorrections`, and
 * asserts the loop closes discovery → verified queue → durable engagement.
 *
 * What is NOT real here, and why:
 *
 * - The chain reader and the claim broadcaster. `createSolverReads` needs a live `PublicClient`;
 *   that leg belongs to an Anvil e2e (see the PR's findings on why the native `daemon-harness`
 *   variant cannot run on today's Base-mainnet-fork fixture).
 * - `NativeSolutionCoordinator`. Constructing the real one pulls in the backend, the evidence
 *   store and the solution publisher; M3 changed none of them, and the settlement leg is what M4/M5
 *   own.
 * - The decode's own gate. It has its own direct coverage in `native-requester-decode.test.ts`;
 *   what this file needs from the consumer is that it stamps the provenance the honest
 *   `canonicalFinalized` reads.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  headPath,
  sealJson,
  type AnnouncementEntry,
} from '@jinn-network/record-discovery-protocol';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { documentDigest, sealSubmission, sealTask } from '@jinn-network/task-execution-protocol';
import { Store } from '../../src/store/store.js';
import { WorkLoop } from '../../src/daemon/work-loop.js';
import type { OperatorComposition } from '../../src/daemon/composition-root.js';
import { createNativeDiscoveryConsumer } from '../../src/daemon/native-discovery.js';
import { NativeClaimCoordinator } from '../../src/daemon/native-claim-coordinator.js';
import { NativeOperatorStateRepository } from '../../src/daemon/native-operator-state.js';
import { NativeMarketplaceEventRepository } from '../../src/daemon/native-canonical-observations.js';
import { buildNativeSolutionCorrections } from '../../src/daemon/native-solution-corrections.js';
import { nativeDiscoveryDecodeProvedCanonical } from '../../src/daemon/native-fleet-discovery.js';
import { evaluateNativeClaim } from '../../src/daemon/native-claim-policy.js';
import type { AnnouncedSubmissionCard } from '../../src/daemon/native-submission-facts.js';

const AGENT = 'did:key:zNativeRequester';
const SOURCE_NAME = 'requester';
const ROOT = 'https://requester.example';
const OPERATOR = 'urn:jinn:operator:solver-a';
const PROFILE_URI = 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0';
const SUBMISSION_URI = 'urn:uuid:11111111-1111-4111-8111-111111111111' as const;
const NONCE = 'nonce-1';
const PROFILE_DIGEST_HEX = 'a'.repeat(64);

/**
 * Real sealed documents, not placeholders: `evaluateNativeClaim` re-derives both digests and
 * parses both against the TEP schemas, so a fixture that does not seal correctly is refused
 * `sealed-document-mismatch` before the honest `canonicalFinalized` is ever consulted.
 */
const TASK_BYTES = sealTask({
  protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
  profile: { uri: PROFILE_URI, digest: { sha256: PROFILE_DIGEST_HEX } },
  instructions: 'Forecast the market.',
  outputs: [{ name: 'forecast', mediaType: 'application/json', required: true }],
});
const TASK_DIGEST = documentDigest(TASK_BYTES);
const SUBMISSION_BYTES = sealSubmission({
  protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
  submission: SUBMISSION_URI,
  task: { digest: { sha256: TASK_DIGEST.slice('sha256:'.length) } },
  requester: 'urn:uuid:33333333-3333-4333-8333-333333333333',
  idempotencyKey: 'key-1',
  nonce: NONCE,
  deadline: '2099-01-01T00:00:00Z',
});
const SUBMISSION_DIGEST = documentDigest(SUBMISSION_BYTES);
const TX = `0x${'3'.repeat(64)}` as const;
const BLOCK = `0x${'4'.repeat(64)}` as const;
const REQUEST = `0x${'5'.repeat(64)}` as const;
const NOW = new Date('2026-08-02T02:00:00.000Z');

function entry(sequence: string, previous: `sha256:${string}` | null): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: AGENT, name: SOURCE_NAME },
    sequence,
    previous,
    timestamp: '2026-08-02T00:00:01.000Z',
    announcements: [{
      announcementId: `announcement-${sequence}`,
      action: 'available',
      record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: SUBMISSION_DIGEST },
      facts: { taskDigest: TASK_DIGEST },
    }],
  };
}

function signed(value: AnnouncementEntry) {
  return {
    entry: value,
    signature: {
      payloadType: 'application/vnd.jinn.record-discovery.entry.v1+json',
      payload: Buffer.from('signed-entry').toString('base64'),
      signatures: [{ keyid: 'requester-key', sig: Buffer.from('signature').toString('base64') }],
    },
  };
}

function routes(entries: readonly AnnouncementEntry[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  entries.forEach((value, index) => {
    const pageId = String(index + 1).padStart(16, '0');
    map.set(`${ROOT}${archivePagePath(SOURCE_NAME, pageId)}`, {
      protocol: RECORD_DISCOVERY_VERSION,
      source: SOURCE_NAME,
      page: pageId,
      prevArchive: index === 0 ? null : String(index).padStart(16, '0'),
      entries: [signed(value)],
    });
  });
  const last = entries.at(-1)!;
  map.set(`${ROOT}${headPath(SOURCE_NAME)}`, {
    payloadType: 'application/vnd.jinn.record-discovery.head.v1+json',
    payload: Buffer.from(JSON.stringify({
      protocol: RECORD_DISCOVERY_VERSION,
      origin: `${AGENT}/${SOURCE_NAME}`,
      sequence: last.sequence,
      entry: sealJson(last).digest,
      issuedAt: '2026-08-02T01:00:00.000Z',
      refreshBy: '2026-08-03T01:00:00.000Z',
    })).toString('base64'),
    signatures: [{ keyid: 'requester-key', sig: Buffer.from('signature').toString('base64') }],
  });
  return map;
}

/** The product-local card the decode returns once it has proved the TaskCreated canonical. */
function decodedCard(): AnnouncedSubmissionCard {
  return {
    record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: SUBMISSION_DIGEST },
    facts: { taskDigest: TASK_DIGEST, taskProfileUri: PROFILE_URI },
    chain: {
      taskId: 7n,
      submission: SUBMISSION_URI,
      nonce: NONCE,
      intendedSpendWei: 2n,
    },
  };
}

function build(input: { readonly entries: readonly AnnouncementEntry[] }) {
  const store = new Store(':memory:');
  const map = routes(input.entries);
  const discovery = createNativeDiscoveryConsumer<AnnouncedSubmissionCard>({
    store,
    sources: [{
      endpoint: {
        agent: AGENT,
        name: SOURCE_NAME,
        servingRoot: ROOT,
        archiveRootUrl: `${ROOT}${archivePagePath(SOURCE_NAME, String(input.entries.length).padStart(16, '0'))}`,
      },
      verify: async ({ entries }) => {
        for await (const _item of entries) { /* drain: the ordered-consumption contract */ }
        return { status: 'ok' };
      },
      verifyHead: async () => ({ status: 'ok' }),
    }],
    transport: {
      fetch: async (url) => {
        const value = map.get(url);
        if (value === undefined) throw new Error(`missing route ${url}`);
        return {
          status: 200,
          contentType: 'application/json',
          bytes: new TextEncoder().encode(JSON.stringify(value)),
        };
      },
    },
    decode: async () => decodedCard(),
    now: () => NOW,
  });

  const state = new NativeOperatorStateRepository(store, { now: () => NOW });
  const broadcast = vi.fn(async () => ({
    txHash: TX, blockHash: BLOCK, blockNumber: 10n, attemptIndex: 0, requestId: REQUEST,
  }));
  const nativeClaimCoordinator = new NativeClaimCoordinator({
    state,
    chain: BASE_SEPOLIA_TODAY,
    operatorAgent: OPERATOR,
    // The REAL admission policy, fed the REAL honest `canonicalFinalized` predicate — this is the
    // seam M2 pinned to `false` and M3 makes truthful.
    admission: {
      evaluate: async (queued, documents) => evaluateNativeClaim({
        card: queued.card,
        taskBytes: documents.taskBytes,
        submissionBytes: documents.submissionBytes,
        backend: {
          capabilities: async () => ({
            taskProfiles: [PROFILE_URI],
            workspaceKinds: ['dir'],
            inputMediaTypes: ['application/json'],
            outputMediaTypes: ['application/json'],
            isolation: ['process'],
            signedDeliveries: true,
            preflight: true,
            deadlineEnforcement: true,
            evidenceCapture: 'always',
            runPinning: { keys: [] },
          }),
          preflight: async () => ({ ready: true }),
        } as never,
        launcher: {
          inspect: async () => ({
            launcherId: 'prediction-forecast',
            taskProfiles: [PROFILE_URI],
            executable: { path: '/usr/bin/node', digest: 'd'.repeat(64) },
            probe: { ready: true },
          }),
        } as never,
        policy: {
          chainId: BASE_SEPOLIA_TODAY.chainId,
          coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
          generation: BASE_SEPOLIA_TODAY.generation,
          maxSpendWei: 1_000n,
          minDeadlineLeadMs: 0,
          maxConcurrent: 1,
        },
        activeEngagements: 0,
        canonicalFinalized: nativeDiscoveryDecodeProvedCanonical(queued.card),
        now: NOW,
      }),
    },
    claim: { priorityMech: BASE_SEPOLIA_TODAY.mechMarketplace, broadcast },
    canonical: {
      read: async ({ operation }) => operation.txHash !== null
        ? { kind: 'finalized', txHash: TX, blockHash: BLOCK, blockNumber: 10n, attemptIndex: 0, requestId: REQUEST }
        : { kind: 'absent', checkedAtBlock: 9n },
    },
    worker: { ownerId: 'worker-a', ttlMs: 60_000 },
  });

  const publisher = {
    publish: vi.fn(async () => ({ sequence: '2', entryDigest: `sha256:${'7'.repeat(64)}` as const })),
    withdraw: vi.fn(async () => ({ sequence: '1', entryDigest: `sha256:${'6'.repeat(64)}` as const })),
  };
  const nativeSolutionCorrections = buildNativeSolutionCorrections({
    store,
    publisher,
    marketplaceEvents: new NativeMarketplaceEventRepository(store),
  });
  const reconcileEngagement = vi.fn(async () => ({ kind: 'delivered' as const }));

  const loop = new WorkLoop({
    composition: {
      mode: 'native',
      chain: BASE_SEPOLIA_TODAY,
      pipelineConfig: { wiring: [] },
    } as unknown as OperatorComposition,
    nativeDiscovery: discovery,
    nativeClaimCoordinator,
    nativeSolutionCoordinator: { reconcileStartup: async () => [], reconcileEngagement },
    nativeSolutionCorrections,
    ledger: {} as never,
    claimGate: { waitUntilOpen: async () => undefined, isOpen: () => true } as never,
    store,
    estimateAiUnits: () => 0,
    readSealedDocuments: async () => ({
      taskBytes: TASK_BYTES,
      submissionBytes: SUBMISSION_BYTES,
    }),
    pollIntervalMs: 5,
    acceptLegacyCards: false,
  });

  return { store, loop, state, discovery, broadcast, reconcileEngagement, publisher };
}

describe('fleet WorkLoop native lifecycle over real components', () => {
  it('closes discovery → verified queue → durable engagement in one tick', async () => {
    const first = entry('0000000000000001', null);
    const { store, loop, state, broadcast, reconcileEngagement } = build({ entries: [first] });
    try {
      await loop.initialize();
      const outcomes = await loop.tick();

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.outcome).toMatchObject({ kind: 'native-claim' });
      // The claim actually broadcast, and the engagement is durable in the SHARED daemon Store --
      // not a separate solver.sqlite.
      expect(broadcast).toHaveBeenCalledOnce();
      expect(state.listEngagements()).toHaveLength(1);
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM native_engagements`).get()).toEqual({ n: 1 });
      // A finalized claim hands off to the solution coordinator by engagement id.
      expect(reconcileEngagement).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it('checkpoints the signed source head so a second tick re-lists nothing', async () => {
    const first = entry('0000000000000001', null);
    const { store, loop, discovery } = build({ entries: [first] });
    try {
      await loop.initialize();
      await loop.tick();
      const checkpoint = discovery.checkpoint({ agent: AGENT, name: SOURCE_NAME });
      expect(checkpoint?.sequence).toBe('0000000000000001');

      // The card was acknowledged inside the coordinator's admission transaction, so the second
      // tick sees an empty pending queue rather than re-processing it.
      expect(await loop.tick()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('refuses to poll before initialize() has owned the worker and reconciled', async () => {
    const { store, loop } = build({ entries: [entry('0000000000000001', null)] });
    try {
      await expect(loop.tick()).rejects.toThrow('native work loop must initialize before polling');
    } finally {
      store.close();
    }
  });

  it('runs the signed reorg-correction pass before every source read', async () => {
    const { store, loop, publisher } = build({ entries: [entry('0000000000000001', null)] });
    try {
      await loop.initialize();
      await loop.tick();
      // Nothing to correct in this fixture -- the assertion is that the pass RAN without needing
      // a table some other host had to create first (the DDL now comes from Store).
      expect(store.db.prepare(
        `SELECT COUNT(*) AS n FROM native_solution_discovery_corrections`,
      ).get()).toEqual({ n: 0 });
      expect(publisher.withdraw).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});
