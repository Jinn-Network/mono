import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicClient, getAddress, http, parseAbi, zeroAddress } from 'viem';
import { baseSepolia } from 'viem/chains';
import { redactRpcUrls } from '../../src/util/redact-rpc-urls.js';

const describeLive = process.env['JINN_LIVE_RPC_TESTS'] === '1'
  ? describe
  : describe.skip;

const taskActivityCheckerAbi = parseAbi([
  'function taskCreationWeight(address multisig) view returns (uint256)',
  'function solutionDeliveryWeight(address multisig) view returns (uint256)',
  'function verdictDeliveryWeight(address multisig) view returns (uint256)',
]);

describeLive('live R-3 router surface', () => {
  it('Base Sepolia V3 activity checker exposes Task-native weight getters', async () => {
    try {
      const artifact = JSON.parse(readFileSync(
        resolve(process.cwd(), '../contracts/deployment-task-coordinator-router-v3-baseSepolia-fast.json'),
        'utf8',
      )) as {
        contracts: {
          activityChecker: string;
        };
      };
      const rpcUrl = process.env['BASE_SEPOLIA_RPC_URL'] ?? 'https://sepolia.base.org';
      const activityChecker = getAddress(
        process.env['JINN_R3_ACTIVITY_CHECKER'] ?? artifact.contracts.activityChecker,
      );
      const sampleMultisig = process.env['JINN_R3_MULTISIG']
        ? getAddress(process.env['JINN_R3_MULTISIG'])
        : zeroAddress;

      const client = createPublicClient({
        chain: baseSepolia,
        transport: http(rpcUrl),
      });

      const [checkerCode, taskCreation, solutionDelivery, verdictDelivery] =
        await Promise.all([
          client.getBytecode({ address: activityChecker }),
          client.readContract({
            address: activityChecker,
            abi: taskActivityCheckerAbi,
            functionName: 'taskCreationWeight',
            args: [sampleMultisig],
          }),
          client.readContract({
            address: activityChecker,
            abi: taskActivityCheckerAbi,
            functionName: 'solutionDeliveryWeight',
            args: [sampleMultisig],
          }),
          client.readContract({
            address: activityChecker,
            abi: taskActivityCheckerAbi,
            functionName: 'verdictDeliveryWeight',
            args: [sampleMultisig],
          }),
        ]);

      expect(checkerCode).toBeDefined();
      expect(checkerCode).not.toBe('0x');
      expect(typeof taskCreation).toBe('bigint');
      expect(typeof solutionDelivery).toBe('bigint');
      expect(typeof verdictDelivery).toBe('bigint');
    } catch (error) {
      throw new Error(redactRpcUrls(error));
    }
  }, 30_000);
});
