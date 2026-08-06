import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryMarketplaceObserveStore,
  createInMemoryPostingIntentStore,
  type MarketplaceObservePort,
  type PostingOutcome,
} from '@jinn-network/marketplace-binding';
import { sealDelivery, documentDigest } from '@jinn-network/task-execution-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { NativeRequesterRoles } from '../../src/native-requester/requester.js';
import {
  buildFleetRequesterWrite,
  FLEET_REQUESTER_POSTING_TERMS,
  fleetRequesterRunId,
} from '../../src/daemon/native-fleet-requester-write.js';
import { createFileAdoptionReceiptStore } from '../../src/daemon/native-adoption-receipt-store.js';

const CREATOR = '0x1111111111111111111111111111111111111111' as const;
const AUTHORITY_TIME = {
  chainId: 84532 as const,
  blockNumber: '100',
  blockHash: `0x${'cd'.repeat(32)}` as const,
  timestamp: '2026-08-02T11:59:00.000Z',
  finalized: true as const,
};

/** Three-role in-memory identity port (requester-submission, admission, requester-discovery). */
function roles(): NativeRequesterRoles {
  const byRole = new Map<string, { keyId: string; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']; sign: (p: Uint8Array) => Uint8Array }>();
  for (const role of ['requester-submission', 'admission', 'requester-discovery'] as const) {
    const pair = generateKeyPairSync('ed25519');
    byRole.set(role, {
      keyId: `did:key:${role}`,
      publicKey: pair.publicKey,
      sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, pair.privateKey)),
    });
  }
  return {
    get(role) {
      const identity = byRole.get(role);
      if (identity === undefined) throw new Error(`missing test role ${role}`);
      return identity;
    },
  };
}

function build(input: {
  readonly stateDir: string;
  readonly broadcast: (args: { safeAddress: `0x${string}`; to: `0x${string}`; value: bigint; data: `0x${string}` }) => Promise<PostingOutcome>;
  readonly pinned: Uint8Array[];
  readonly observe?: MarketplaceObservePort;
  readonly logger?: { info(message: string): void; warn(message: string): void };
}) {
  const intents = createInMemoryPostingIntentStore();
  const observe = input.observe ?? createInMemoryMarketplaceObserveStore(BASE_SEPOLIA_TODAY, { intents });
  const adoptionReceipts = createFileAdoptionReceiptStore({ dir: join(input.stateDir, 'adoptions') });
  const write = buildFleetRequesterWrite({
    requesterAgent: 'urn:jinn:requester:test',
    admissionAgent: 'urn:jinn:admission:test',
    publicBaseUrl: 'https://requester.test',
    requesterStateDir: input.stateDir,
    creatorSafe: CREATOR,
    roles: roles(),
    safeBroadcast: { broadcastCreateTask: input.broadcast },
    intents,
    observe,
    ipfsPin: { pin: async (bytes) => { input.pinned.push(bytes); } },
    authorityTime: async () => AUTHORITY_TIME,
    canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
    adoptionReceipts,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    now: () => new Date('2026-08-02T12:00:00.000Z'),
  });
  return { write, observe, adoptionReceipts };
}

/** The one durable association `postTarget` wrote — read back off disk to drive a delivery. */
async function readPostedAssociation(stateDir: string): Promise<{
  submissionUri: `urn:uuid:${string}`;
  taskDigest: `sha256:${string}`;
  taskId: string;
}> {
  const dir = join(stateDir, 'associations');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  const stored = JSON.parse(await readFile(join(dir, files[0]!), 'utf8'));
  return { submissionUri: stored.submissionUri, taskDigest: stored.taskDigest, taskId: stored.taskId };
}

describe('fleetRequesterRunId — deterministic, grammar-legal run identity', () => {
  it('prefixes and folds disallowed characters so any work kind yields a legal id', () => {
    expect(fleetRequesterRunId({ postingKey: 'bafyRepoWork' })).toBe('fleet-bafyRepoWork');
    // A colon/slash-bearing key is folded to `-`, still starting with an identifier character.
    expect(fleetRequesterRunId({ postingKey: 'urn:profile/repo@1' })).toBe('fleet-urn-profile-repo-1');
  });

  it('is deterministic for the same target', () => {
    expect(fleetRequesterRunId({ postingKey: 'repo' })).toBe(fleetRequesterRunId({ postingKey: 'repo' }));
  });
});

describe('buildFleetRequesterWrite — the config -> task doc -> pin -> broadcast -> taskId wiring', () => {
  it('posts through the ONE injected broadcaster with today-mode createTask args and returns the task id', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-fleet-requester-write-'));
    const pinned: Uint8Array[] = [];
    const broadcast = vi.fn(async () => ({ taskId: 4242n, txHash: `0x${'ab'.repeat(32)}` as const }));
    try {
      const { write } = build({ stateDir, broadcast, pinned });
      const result = await write.postTarget({
        postingKey: 'repo',
        workKind: 'repo',
        profileUri: 'urn:m:repo',
        live: true,
        generatorEnabled: true,
      });

      // The real on-chain post is M7's e2e rig; here the fake broadcaster proves the wiring.
      expect(result).toEqual({ taskId: '4242' });
      // The Task document and the Submission were pinned before the broadcast (two uploads).
      expect(pinned).toHaveLength(2);
      // The ONE broadcaster was called exactly once, with the today-mode createTask escrow args.
      const escrow = FLEET_REQUESTER_POSTING_TERMS.solutionMaxDeliveryRateWei
        + FLEET_REQUESTER_POSTING_TERMS.verdictMaxDeliveryRateWei;
      expect(broadcast).toHaveBeenCalledTimes(1);
      const call = broadcast.mock.calls[0]![0];
      expect(call.safeAddress).toBe(CREATOR);
      expect(call.to).toBe(BASE_SEPOLIA_TODAY.jinnRouter);
      expect(call.value).toBe(escrow);
      // Real createTask calldata (not empty), anchoring the task digest.
      expect(call.data.startsWith('0x')).toBe(true);
      expect(call.data.length).toBeGreaterThan(2);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('is idempotent per target: a repeat returns the same task id without a second broadcast', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-fleet-requester-write-idem-'));
    const pinned: Uint8Array[] = [];
    const broadcast = vi.fn(async () => ({ taskId: 7n, txHash: `0x${'cd'.repeat(32)}` as const }));
    try {
      const { write } = build({ stateDir, broadcast, pinned });
      const target = {
        postingKey: 'repo',
        workKind: 'repo',
        profileUri: 'urn:m:repo',
        live: true,
        generatorEnabled: true,
      };
      const first = await write.postTarget(target);
      const second = await write.postTarget(target);
      expect(first).toEqual({ taskId: '7' });
      expect(second).toEqual(first);
      // The deterministic runId means the second tick reuses the durable association: no re-spend.
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('buildFleetRequesterWrite.adopt — the G-loop adopt leg (M5f)', () => {
  const TARGET = {
    postingKey: 'repo',
    workKind: 'repo',
    profileUri: 'urn:m:repo',
    live: true,
    generatorEnabled: true,
  } as const;

  /** Post one task, then simulate the second operator's delivery on the shared observe store. */
  async function postThenDeliver(input: {
    stateDir: string;
    pinned: Uint8Array[];
    logger?: { info(message: string): void; warn(message: string): void };
    /** Mutate the sealed delivery bytes before recording (tamper is unreachable on the real store). */
    outcome?: 'fulfilled' | 'partial';
  }) {
    const broadcast = vi.fn(async () => ({ taskId: 4242n, txHash: `0x${'ab'.repeat(32)}` as const }));
    const built = build({ stateDir: input.stateDir, broadcast, pinned: input.pinned, ...(input.logger ? { logger: input.logger } : {}) });
    await built.write.postTarget(TARGET);
    const association = await readPostedAssociation(input.stateDir);
    const snapshot = await built.observe.observe(association.submissionUri);
    const attempt = snapshot.descriptor.attempt;
    const delivery = {
      protocol: 'https://spec.jinn.network/task-execution/v1',
      attempt,
      task: association.taskDigest,
      outputs: [],
      outcome: input.outcome ?? ('fulfilled' as const),
      createdAt: '2026-08-02T12:30:00.000Z',
    };
    const deliveryBytes = sealDelivery(delivery);
    await built.observe.recordDelivery(attempt, deliveryBytes);
    return { ...built, attempt, association, deliveryDigest: documentDigest(deliveryBytes) };
  }

  it('adopts a delivered task, records a durable receipt, and is idempotent (adopt-once)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-fleet-adopt-'));
    const pinned: Uint8Array[] = [];
    try {
      const { write, adoptionReceipts, association, deliveryDigest } = await postThenDeliver({ stateDir, pinned });

      const decisions = await write.adopt();
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        taskId: association.taskId,
        disposition: 'accepted',
        deliveryDigest,
      });
      // Durable receipt written; the evidence handle is the delivery digest.
      expect(await adoptionReceipts.has(association.taskId)).toBe(true);
      expect((await adoptionReceipts.read(association.taskId))?.deliveryDigest).toBe(deliveryDigest);

      // Adopt-once: a second pass sees the receipt and records nothing new.
      expect(await write.adopt()).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('returns [] and records nothing when the posted task has no delivery yet', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-fleet-adopt-none-'));
    const pinned: Uint8Array[] = [];
    const broadcast = vi.fn(async () => ({ taskId: 9n, txHash: `0x${'cd'.repeat(32)}` as const }));
    try {
      const { write, adoptionReceipts } = build({ stateDir, broadcast, pinned });
      await write.postTarget(TARGET);
      // No delivery recorded — the Attempt is engaged but empty (or not engaged at all).
      expect(await write.adopt()).toEqual([]);
      expect(await adoptionReceipts.all()).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('reconcile runs the adopt leg after posting-draft recovery', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-fleet-adopt-reconcile-'));
    const pinned: Uint8Array[] = [];
    try {
      const { write, adoptionReceipts, association } = await postThenDeliver({ stateDir, pinned });
      // The posting loop drives adoption through reconcile (the loop's first tick step).
      await write.reconcile();
      expect(await adoptionReceipts.has(association.taskId)).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('with no posted tasks, adopt is a quiet no-op (boot-inertness)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jinn-fleet-adopt-empty-'));
    const pinned: Uint8Array[] = [];
    const broadcast = vi.fn(async () => ({ taskId: 1n, txHash: `0x${'ef'.repeat(32)}` as const }));
    const warn = vi.fn();
    try {
      const { write, adoptionReceipts } = build({ stateDir, broadcast, pinned, logger: { info: () => {}, warn } });
      // Never posted anything: postedAssociations() is empty, adopt() records nothing and never warns.
      expect(await write.adopt()).toEqual([]);
      expect(await adoptionReceipts.all()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
