#!/usr/bin/env node
// Apply DR-2026-04-29 OLAS-disposition split to the V2.1 staking proxy.
// Reconfigures the proxy registration on the JINN-deployed stOLAS clone:
//   (0x0, 2000, 0, 8000, 1) → (0x0, 1, 7499, 2500, 1)
// stOLAS hardcodes `collectorRewardFactor != 0` (ExternalStakingDistributor.sol:872),
// so collector=1 (0.01%) is the minimum representable share. Practical effect:
//   ~0.01% collector (operator EOA-level dust)
//   74.99% protocol  (accumulates in Collector.protocolBalance for periodic 0xdead drain)
//   25%    curating  (stOLAS depositor yield)
// Run once before restarting the daemon. The Collector accumulates the protocol
// share into protocolBalance; periodic Collector.fundExternal(0xdead, ...) drain is
// a separate follow-up admin call.

import { config as dotenvConfig } from 'dotenv';
import {
  createPublicClient, createWalletClient, http, parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

dotenvConfig({ path: '/Users/adrianobradley/harbor/jinn-mono/.tasks/jinn-mono-zwj/contracts/.env' });
const RAW = process.env.DEPLOYER_PRIVATE_KEY;
if (!RAW) {
  console.error('DEPLOYER_PRIVATE_KEY not set');
  process.exit(1);
}

const RPC = 'https://base-sepolia.gateway.tenderly.co/75tyLMQuD8EHpXxMwINIKu';
const STOLAS = '0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81';
const V21_PROXY = '0x24e34E5037956a5Feca1AAAfaA30297084C228B8';

const account = privateKeyToAccount(RAW.startsWith('0x') ? RAW : `0x${RAW}`);
const c = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const w = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });

const abi = parseAbi([
  'function owner() view returns (address)',
  'function mapStakingProxyConfigs(address) view returns (uint256)',
  'function wrapStakingConfig(address, uint256, uint256, uint256, uint8) pure returns (uint256)',
  'function unwrapStakingConfig(uint256) pure returns (address, uint256, uint256, uint256, uint8)',
  'function setStakingProxyConfigs(address[] stakingProxies, uint256[] configs)',
]);

const owner = await c.readContract({ address: STOLAS, abi, functionName: 'owner' });
console.log(`stOLAS owner: ${owner}`);
console.log(`caller:       ${account.address}`);
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.error('Caller is not stOLAS owner. Cannot proceed.');
  process.exit(1);
}

const before = await c.readContract({
  address: STOLAS, abi, functionName: 'mapStakingProxyConfigs', args: [V21_PROXY],
});
const beforeUnwrapped = await c.readContract({
  address: STOLAS, abi, functionName: 'unwrapStakingConfig', args: [before],
});
console.log(`\nBefore — encoded: ${before}`);
console.log(`         (guard=${beforeUnwrapped[0]}, collector=${beforeUnwrapped[1]}, protocol=${beforeUnwrapped[2]}, curating=${beforeUnwrapped[3]}, type=${beforeUnwrapped[4]})`);

const newConfig = await c.readContract({
  address: STOLAS, abi, functionName: 'wrapStakingConfig',
  args: ['0x0000000000000000000000000000000000000000', 1n, 7499n, 2500n, 1],
});
console.log(`\nAfter  — encoded: ${newConfig}`);
console.log(`         (guard=0x0, collector=1 [stOLAS minimum], protocol=7499, curating=2500, type=1)`);

if (before === newConfig) {
  console.log('\nConfig already matches DR-2026-04-29 standard-mode split. Nothing to do.');
  process.exit(0);
}

console.log('\nSubmitting setStakingProxyConfigs([V21_PROXY], [newConfig])...');
const { request } = await c.simulateContract({
  address: STOLAS, abi, functionName: 'setStakingProxyConfigs',
  args: [[V21_PROXY], [newConfig]], account,
});
const hash = await w.writeContract(request);
console.log(`tx: ${hash}`);
const r = await c.waitForTransactionReceipt({ hash });
console.log(`status: ${r.status}, block: ${r.blockNumber}`);

const after = await c.readContract({
  address: STOLAS, abi, functionName: 'mapStakingProxyConfigs', args: [V21_PROXY],
});
const afterUnwrapped = await c.readContract({
  address: STOLAS, abi, functionName: 'unwrapStakingConfig', args: [after],
});
console.log(`\nVerified — encoded: ${after}`);
console.log(`         (guard=${afterUnwrapped[0]}, collector=${afterUnwrapped[1]}, protocol=${afterUnwrapped[2]}, curating=${afterUnwrapped[3]}, type=${afterUnwrapped[4]})`);

if (after !== newConfig) {
  console.error('\nMismatch — config did not apply correctly.');
  process.exit(1);
}
console.log('\nDR-2026-04-29 split applied. Operator collector-share = 0; protocol-share (75%) accumulates in Collector for burn drain.');
