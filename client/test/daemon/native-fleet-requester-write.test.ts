import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryMarketplaceObserveStore,
  createInMemoryPostingIntentStore,
  type PostingOutcome,
} from '@jinn-network/marketplace-binding';
import { describe, expect, it, vi } from 'vitest';
import type { NativeRequesterRoles } from '../../src/native-requester/requester.js';
import {
  buildFleetRequesterWrite,
  FLEET_REQUESTER_POSTING_TERMS,
  fleetRequesterRunId,
} from '../../src/daemon/native-fleet-requester-write.js';

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
}) {
  const intents = createInMemoryPostingIntentStore();
  return buildFleetRequesterWrite({
    requesterAgent: 'urn:jinn:requester:test',
    admissionAgent: 'urn:jinn:admission:test',
    publicBaseUrl: 'https://requester.test',
    requesterStateDir: input.stateDir,
    creatorSafe: CREATOR,
    roles: roles(),
    safeBroadcast: { broadcastCreateTask: input.broadcast },
    intents,
    observe: createInMemoryMarketplaceObserveStore(BASE_SEPOLIA_TODAY, { intents }),
    ipfsPin: { pin: async (bytes) => { input.pinned.push(bytes); } },
    authorityTime: async () => AUTHORITY_TIME,
    canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
    now: () => new Date('2026-08-02T12:00:00.000Z'),
  });
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
      const write = build({ stateDir, broadcast, pinned });
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
      const write = build({ stateDir, broadcast, pinned });
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
