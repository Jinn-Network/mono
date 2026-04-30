import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  zeroAddress,
} from 'viem';
import { getProof } from 'viem/actions';
import { baseSepolia, sepolia } from 'viem/chains';
import { getGames } from 'viem/op-stack';
import {
  DISPUTE_GAME_FACTORY_ABI,
  OPTIMISM_PORTAL_ABI,
} from '../../src/daemon/jinn-claim-loop-canonical.js';
import { redactRpcUrls } from '../../src/util/redact-rpc-urls.js';

const describeLive = process.env['JINN_LIVE_RPC_TESTS'] === '1'
  ? describe
  : describe.skip;

// Live test still asserts on a few selectors that aren't in the daemon's
// hot-path ABI (proofCount, l2SequenceNumber) — those probe Azul-specific shape.
const gameLiveProbeAbi = parseAbi([
  'function gameType() view returns (uint32)',
  'function rootClaim() view returns (bytes32)',
  'function wasRespectedGameTypeWhenCreated() view returns (bool)',
  'function l2SequenceNumber() view returns (uint256)',
  'function proofCount() view returns (uint8)',
]);

function snapshotMappingSlot(claimId: bigint): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [claimId, 1n],
    ),
  );
}

describeLive('live Azul storage proof surface', () => {
  it('exposes Base Sepolia gameType 621 games and historical eth_getProof', async () => {
    try {
      const l1Rpc =
        process.env['JINN_L1_RPC_URL'] ??
        process.env['SEPOLIA_RPC_URL'] ??
        'https://ethereum-sepolia.publicnode.com';
      const l2Rpc =
        process.env['JINN_L2_PROOF_RPC_URL'] ??
        process.env['JINN_L2_RPC_URL'] ??
        process.env['BASE_SEPOLIA_RPC_URL'] ??
        'https://sepolia.base.org';

      const l1 = createPublicClient({ chain: sepolia, transport: http(l1Rpc) });
      const l2 = createPublicClient({ chain: baseSepolia, transport: http(l2Rpc) });
      const portal = baseSepolia.contracts.portal[sepolia.id].address;
      const disputeGameFactory = baseSepolia.contracts.disputeGameFactory[sepolia.id].address;

      const [respectedGameType, proofMaturityDelaySeconds, disputeGameFinalityDelaySeconds] =
        await Promise.all([
          l1.readContract({ address: portal, abi: OPTIMISM_PORTAL_ABI, functionName: 'respectedGameType' }),
          l1.readContract({ address: portal, abi: OPTIMISM_PORTAL_ABI, functionName: 'proofMaturityDelaySeconds' }),
          l1.readContract({ address: portal, abi: OPTIMISM_PORTAL_ABI, functionName: 'disputeGameFinalityDelaySeconds' }),
        ]);

      expect(respectedGameType).toBe(621);
      expect(proofMaturityDelaySeconds).toBeGreaterThanOrEqual(0n);
      expect(disputeGameFinalityDelaySeconds).toBeGreaterThanOrEqual(0n);

      const [latestGame] = await getGames(l1, {
        chain: null,
        targetChain: baseSepolia,
        limit: 1,
      });
      expect(latestGame).toBeDefined();

      const [factoryGameType, , proxy] = await l1.readContract({
        address: disputeGameFactory,
        abi: DISPUTE_GAME_FACTORY_ABI,
        functionName: 'gameAtIndex',
        args: [latestGame.index],
      });
      const [proxyGameType, rootClaim, wasRespected, l2SequenceNumber, proofCount] =
        await Promise.all([
          l1.readContract({ address: proxy, abi: gameLiveProbeAbi, functionName: 'gameType' }),
          l1.readContract({ address: proxy, abi: gameLiveProbeAbi, functionName: 'rootClaim' }),
          l1.readContract({ address: proxy, abi: gameLiveProbeAbi, functionName: 'wasRespectedGameTypeWhenCreated' }),
          l1.readContract({ address: proxy, abi: gameLiveProbeAbi, functionName: 'l2SequenceNumber' }),
          l1.readContract({ address: proxy, abi: gameLiveProbeAbi, functionName: 'proofCount' }),
        ]);

      expect(factoryGameType).toBe(621);
      expect(proxyGameType).toBe(621);
      expect(rootClaim).toBe(latestGame.rootClaim);
      expect(wasRespected).toBe(true);
      expect(l2SequenceNumber).toBe(latestGame.l2BlockNumber);
      expect(proofCount).toBeGreaterThanOrEqual(1);

      const proof = await getProof(l2, {
        address: zeroAddress,
        storageKeys: [snapshotMappingSlot(1n)],
        blockNumber: latestGame.l2BlockNumber,
      });

      expect(proof.accountProof.length).toBeGreaterThan(0);
      expect(proof.storageProof[0]?.proof.length).toBeGreaterThan(0);
    } catch (error) {
      throw new Error(redactRpcUrls(error));
    }
  }, 60_000);
});
