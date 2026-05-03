import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { CLAIM_TICKET_TOPIC0 } from '../../src/earning/contracts.js';
import {
  assertDisputeGameReady,
  claimSnapshotStorageSlot,
  decodeClaimTicketFromReceipt,
  selectCoveringDisputeGame,
  verifyCanonicalClaimCanary,
  type CanonicalGameSelection,
} from '../../src/daemon/jinn-claim-loop-canonical.js';

vi.mock('viem/op-stack', () => ({
  getGames: vi.fn(async () => [
    { index: 9n, l2BlockNumber: 99n, rootClaim: `0x${'09'.repeat(32)}` },
    { index: 11n, l2BlockNumber: 110n, rootClaim: `0x${'11'.repeat(32)}` },
    { index: 12n, l2BlockNumber: 120n, rootClaim: `0x${'12'.repeat(32)}` },
  ]),
}));

const CLAIM_EMITTER = '0x1111111111111111111111111111111111111111' as const;
const MULTISIG = '0x2222222222222222222222222222222222222222' as const;
const CLAIMER = '0x3333333333333333333333333333333333333333' as const;
const PORTAL = '0x4444444444444444444444444444444444444444' as const;
const DGF = '0x5555555555555555555555555555555555555555' as const;
const PROXY = '0x6666666666666666666666666666666666666666' as const;

function topic(value: bigint | string): `0x${string}` {
  const raw = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return `0x${raw.padStart(64, '0')}`;
}

describe('canonical claim proof helpers', () => {
  it('derives the claimSnapshotHashes mapping slot', () => {
    expect(claimSnapshotStorageSlot(101n)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }],
          [101n, 1n],
        ),
      ),
    );
  });

  it('decodes ClaimTicket from a receipt log by emitter/topic/logIndex', () => {
    const log = {
      address: CLAIM_EMITTER,
      logIndex: 7,
      topics: [
        CLAIM_TICKET_TOPIC0,
        topic(101n),
        topic(7n),
        topic(MULTISIG),
      ],
      data: encodeAbiParameters(
        [
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'address' },
        ],
        [3n, 5n, 2n, CLAIMER],
      ),
    };

    const snapshot = decodeClaimTicketFromReceipt([log], CLAIM_EMITTER, 7);
    expect(snapshot).toMatchObject({
      claimId: 101n,
      serviceId: 7n,
      taskCreationWeight: 3n,
      solutionDeliveryWeight: 5n,
      verdictDeliveryWeight: 2n,
      multisig: MULTISIG,
      claimer: CLAIMER,
    });
  });

  it('selects the earliest dispute game that covers the L2 claim block', async () => {
    const l1Client = {
      readContract: vi.fn(async ({ functionName }: any) => {
        if (functionName === 'gameAtIndex') return [621, 0n, PROXY];
        if (functionName === 'gameType') return 621;
        if (functionName === 'rootClaim') return `0x${'11'.repeat(32)}`;
        throw new Error(`unexpected function ${functionName}`);
      }),
    };

    const game = await selectCoveringDisputeGame({
      l1Client: l1Client as any,
      l2Client: {} as any,
      targetChain: {} as any,
      optimismPortal: PORTAL,
      disputeGameFactory: DGF,
      claimEmitter: CLAIM_EMITTER,
    }, 100n);

    expect(game.index).toBe(11n);
    expect(game.l2BlockNumber).toBe(110n);
    expect(game.proxy).toBe(PROXY);
  });

  it('accepts a resolved and portal-respected dispute game', async () => {
    const game: CanonicalGameSelection = {
      index: 11n,
      l2BlockNumber: 110n,
      proxy: PROXY,
      factoryGameType: 621,
      proxyGameType: 621,
      rootClaim: `0x${'11'.repeat(32)}`,
    };
    const l1Client = {
      readContract: vi.fn(async ({ functionName }: any) => {
        if (functionName === 'respectedGameType') return 621;
        if (functionName === 'proofMaturityDelaySeconds') return 0n;
        if (functionName === 'disputeGameFinalityDelaySeconds') return 0n;
        if (functionName === 'status') return 2;
        if (functionName === 'resolvedAt') return 100n;
        if (functionName === 'wasRespectedGameTypeWhenCreated') return true;
        throw new Error(`unexpected function ${functionName}`);
      }),
      getBlock: vi.fn(async () => ({ timestamp: 200n })),
    };

    await expect(assertDisputeGameReady({
      l1Client: l1Client as any,
      l2Client: {} as any,
      targetChain: {} as any,
      optimismPortal: PORTAL,
      disputeGameFactory: DGF,
      claimEmitter: CLAIM_EMITTER,
    }, game)).resolves.toBeUndefined();
  });

  it('rejects unresolved dispute games', async () => {
    const game: CanonicalGameSelection = {
      index: 11n,
      l2BlockNumber: 110n,
      proxy: PROXY,
      factoryGameType: 621,
      proxyGameType: 621,
      rootClaim: `0x${'11'.repeat(32)}`,
    };
    const l1Client = {
      readContract: vi.fn(async ({ functionName }: any) => {
        if (functionName === 'respectedGameType') return 621;
        if (functionName === 'proofMaturityDelaySeconds') return 0n;
        if (functionName === 'disputeGameFinalityDelaySeconds') return 0n;
        if (functionName === 'status') return 0;
        if (functionName === 'resolvedAt') return 0n;
        if (functionName === 'wasRespectedGameTypeWhenCreated') return true;
        throw new Error(`unexpected function ${functionName}`);
      }),
      getBlock: vi.fn(async () => ({ timestamp: 200n })),
    };

    await expect(assertDisputeGameReady({
      l1Client: l1Client as any,
      l2Client: {} as any,
      targetChain: {} as any,
      optimismPortal: PORTAL,
      disputeGameFactory: DGF,
      claimEmitter: CLAIM_EMITTER,
    }, game)).rejects.toThrow('not resolved DEFENDER_WINS');
  });

  it('verifies the canonical canary through messenger eth_call', async () => {
    const l1Client = {
      readContract: vi.fn(async () => [7n, 3n, 5n, 2n, MULTISIG]),
    };

    const result = await verifyCanonicalClaimCanary(
      l1Client as any,
      PROXY,
      '0x1234',
    );

    expect(l1Client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: PROXY,
      functionName: 'verifyClaim',
      args: ['0x1234'],
    }));
    expect(result).toMatchObject({
      serviceId: 7n,
      taskCreationWeight: 3n,
      solutionDeliveryWeight: 5n,
      verdictDeliveryWeight: 2n,
      multisig: MULTISIG,
    });
  });
});
