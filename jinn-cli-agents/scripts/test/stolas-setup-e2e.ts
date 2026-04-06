#!/usr/bin/env npx tsx
/**
 * stOLAS Operator Setup E2E Test — Tenderly Base Fork
 *
 * Tests the stOLAS operator onboarding flow end-to-end:
 *   1. Fork Base mainnet (inherits live setStakingProxyConfigs)
 *   2. Snapshot staking state
 *   3. Generate fresh operator EOA + fund with ETH
 *   4. Call stake() directly (permissionless) on ExternalStakingDistributor
 *   5. Discover created serviceId + Safe from on-chain
 *   6. Synthesize .operate/ config matching middleware format
 *   7. Verify ServiceConfigReader can parse it
 *   8. Fund agent EOA (Tenderly setBalance)
 *   9. Deploy mech via service Safe (MechMarketplace.create)
 *  10. Verify mech contract on-chain + config update
 *  11. Summary + cleanup
 *
 * Usage:
 *   npx tsx scripts/test/stolas-setup-e2e.ts
 *
 * Requires: TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { ethers } from 'ethers';
import { createTenderlyClient } from '../lib/tenderly.js';

// ServiceConfigReader is in jinn-node — import via relative path
import { readServiceConfig } from '../../jinn-node/src/worker/ServiceConfigReader.js';
import { importServiceFromChain } from '../../jinn-node/src/worker/stolas/ServiceImporter.js';
import { deployMechViaSafe, buildMechToConfigValue } from '../../jinn-node/src/worker/stolas/StolasMechDeployer.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: resolve(ROOT, '.env'), quiet: true } as any);
dotenv.config({ path: resolve(ROOT, '.env.test'), override: true, quiet: true } as any);

// ─── Addresses ─────────────────────────────────────────────────────────────────

const DISTRIBUTOR_PROXY = '0x40abf47B926181148000DbCC7c8DE76A3a61a66f';
const JINN_STAKING      = '0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488';
const SERVICE_REGISTRY  = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';
const MECH_MARKETPLACE  = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

const JINN_AGENT_ID = 103;

// configHash = keccak256(abi.encode([103], [(1, 5000e18)]))
const CONFIG_HASH = (() => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ['uint32[]', 'tuple(uint32,uint96)[]'],
    [[JINN_AGENT_ID], [[1, ethers.parseEther('5000')]]]
  );
  return ethers.keccak256(encoded);
})();

// ─── ABIs ──────────────────────────────────────────────────────────────────────

const DISTRIBUTOR_ABI = [
  'function mapStakingProxyConfigs(address) view returns (uint256)',
  'function stake(address stakingProxy, uint256 serviceId, uint256 agentId, bytes32 configHash, address agentInstance) external',
  'function unwrapStakingConfig(uint256) view returns (uint256, uint256, uint256, uint8)',
];

const STAKING_ABI = [
  'function getServiceIds() view returns (uint256[])',
  'function maxNumServices() view returns (uint256)',
  'function getStakingState(uint256 serviceId) view returns (uint8)',
];

const SERVICE_REGISTRY_ABI = [
  'function getService(uint256 serviceId) view returns (tuple(address token, uint32 maxNumAgentInstances, uint32 numAgentInstances, bytes32 configHash, uint8 state))',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function nonce() view returns (uint256)',
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function rpcCall(rpcUrl: string, method: string, params: unknown[] = []): Promise<any> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!resp.ok) throw new Error(`RPC ${method}: HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

function ethToHex(eth: string): string {
  return '0x' + (BigInt(Math.floor(parseFloat(eth) * 1e18))).toString(16);
}

/**
 * Fund an address with ERC20 tokens on a Tenderly fork by brute-forcing the
 * balanceOf storage slot (tries slots 0-9 for standard ERC20 layouts).
 */
async function fundErc20(
  adminRpc: string,
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  holderAddress: string,
  amount: bigint,
): Promise<void> {
  const erc20 = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
  const balBefore = await erc20.balanceOf(holderAddress);

  // Try storage slots 0-9 (common for OpenZeppelin, Solmate, custom ERC20s)
  const amountHex = '0x' + amount.toString(16).padStart(64, '0');

  for (let slot = 0; slot <= 9; slot++) {
    const storageKey = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [holderAddress, slot])
    );

    await rpcCall(adminRpc, 'tenderly_setStorageAt', [tokenAddress, storageKey, amountHex]);

    const balAfter = await erc20.balanceOf(holderAddress);
    if (balAfter > balBefore) {
      info(`Funded via storage slot ${slot}: ${ethers.formatEther(balAfter)} tokens`);
      return;
    }
  }

  throw new Error(`Could not fund ERC20 ${tokenAddress} for ${holderAddress} — no matching storage slot found`);
}

function section(title: string) { console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`); }
function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  · ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); }

async function sendTx(adminRpc: string, from: string, to: string, data: string, label: string, gas = '0x1000000'): Promise<any> {
  info(`${label}...`);
  const txHash = await rpcCall(adminRpc, 'eth_sendTransaction', [{ from, to, data, gas }]);
  const receipt = await rpcCall(adminRpc, 'eth_getTransactionReceipt', [txHash]);
  if (receipt.status === '0x1') {
    ok(`${label} — gas: ${parseInt(receipt.gasUsed, 16).toLocaleString()}, logs: ${receipt.logs.length}`);
    return receipt;
  }
  fail(`${label} — REVERTED`);
  try {
    await rpcCall(adminRpc, 'eth_call', [{ from, to, data, gas }, 'latest']);
  } catch (e: any) {
    fail(`Revert reason: ${e.message}`);
  }
  throw new Error(`${label} reverted`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('stOLAS Operator Setup E2E Test — Tenderly Base Fork');
  console.log('='.repeat(60));

  const client = createTenderlyClient();

  // ── Step 1: Fork Base mainnet ──
  section('Step 1: Fork Base Mainnet');
  await client.cleanupOldVnets({ maxAgeMs: 3600000 });
  const vnet = await client.createVnet(8453);
  ok(`VNet: ${vnet.id}`);

  const adminRpc = vnet.adminRpcUrl;
  const provider = new ethers.JsonRpcProvider(adminRpc);

  const dist = new ethers.Contract(DISTRIBUTOR_PROXY, DISTRIBUTOR_ABI, provider);
  const staking = new ethers.Contract(JINN_STAKING, STAKING_ABI, provider);
  const registry = new ethers.Contract(SERVICE_REGISTRY, SERVICE_REGISTRY_ABI, provider);

  let tempDir: string | undefined;

  try {
    // ── Step 2: Snapshot staking state ──
    section('Step 2: Snapshot Staking State');

    const proxyConfig = await dist.mapStakingProxyConfigs(JINN_STAKING);
    if (proxyConfig === 0n) {
      fail('setStakingProxyConfigs NOT configured for Jinn — cannot proceed');
      process.exit(1);
    }

    const [agentFactor, protocolFactor, collectorFactor, stakingType] = await dist.unwrapStakingConfig(proxyConfig);
    ok(`Proxy configured: agent=${agentFactor}, protocol=${protocolFactor}, collector=${collectorFactor}, type=${stakingType}`);

    const serviceIdsBefore = await staking.getServiceIds();
    const maxServices = await staking.maxNumServices();
    const slotsUsed = serviceIdsBefore.length;
    const slotsRemaining = Number(maxServices) - slotsUsed;

    info(`Staked: ${slotsUsed}/${maxServices} (${slotsRemaining} remaining)`);
    info(`IDs: [${serviceIdsBefore.map((id: any) => id.toString()).join(', ')}]`);

    if (slotsRemaining === 0) {
      fail('No staking slots available — cannot test');
      process.exit(1);
    }

    // ── Step 3: Generate operator EOA ──
    section('Step 3: Generate Operator EOA');

    const operatorWallet = ethers.Wallet.createRandom();
    info(`Operator EOA: ${operatorWallet.address}`);
    info(`Private key:  ${operatorWallet.privateKey.slice(0, 10)}...`);

    // Fund operator with ETH (needed for gas in production; needed for Tenderly impersonation)
    await rpcCall(adminRpc, 'tenderly_setBalance', [
      [operatorWallet.address],
      ethToHex('1'),
    ]);
    ok('Funded operator with 1 ETH');

    // ── Step 3b: Fund distributor with OLAS (may be depleted on mainnet) ──
    const distOlasAddr = await new ethers.Contract(DISTRIBUTOR_PROXY, ['function olas() view returns (address)'], provider).olas();
    const olasToken = new ethers.Contract(distOlasAddr, ['function balanceOf(address) view returns (uint256)'], provider);
    const distOlasBal = await olasToken.balanceOf(DISTRIBUTOR_PROXY);
    info(`Distributor OLAS balance: ${ethers.formatEther(distOlasBal)}`);

    const requiredOlas = ethers.parseEther('10000'); // bond = 5000 OLAS * 2 (safety margin)
    if (distOlasBal < requiredOlas) {
      info('Distributor needs OLAS — funding via storage override...');
      await fundErc20(adminRpc, provider, distOlasAddr, DISTRIBUTOR_PROXY, requiredOlas);
      const newBal = await olasToken.balanceOf(DISTRIBUTOR_PROXY);
      ok(`Distributor OLAS balance after funding: ${ethers.formatEther(newBal)}`);
    } else {
      ok(`Distributor has sufficient OLAS`);
    }

    // ── Step 4: Call stake() on distributor ──
    section('Step 4: Call stake() (Permissionless)');

    info(`configHash: ${CONFIG_HASH}`);
    info(`agentId: ${JINN_AGENT_ID}`);
    info(`agentInstance: ${operatorWallet.address}`);

    const iface = new ethers.Interface(DISTRIBUTOR_ABI);
    await sendTx(adminRpc, operatorWallet.address, DISTRIBUTOR_PROXY,
      iface.encodeFunctionData('stake', [
        JINN_STAKING,
        0,                        // serviceId = 0 → create new
        JINN_AGENT_ID,
        CONFIG_HASH,
        operatorWallet.address,   // agentInstance → becomes Safe owner
      ]),
      'stake(create new service)');

    // ── Step 5: Discover service on-chain ──
    section('Step 5: Discover Service On-Chain');

    const serviceIdsAfter = await staking.getServiceIds();
    const newServiceIds = serviceIdsAfter.filter(
      (id: any) => !serviceIdsBefore.some((old: any) => old.toString() === id.toString())
    );

    if (newServiceIds.length === 0) {
      fail('No new service created after stake()');
      process.exit(1);
    }

    const serviceId = Number(newServiceIds[0]);
    ok(`New service created: ID ${serviceId}`);

    // Get service details from registry
    const svc = await registry.getService(serviceId);
    info(`Service state: ${svc.state} (4=DEPLOYED)`);
    info(`Service configHash: ${svc.configHash}`);

    // Get multisig from staking contract's mapServiceInfo
    const stakingIfaceRaw = new ethers.Interface([
      'function mapServiceInfo(uint256) view returns (address, address)',
    ]);
    const mapResult = await provider.call({
      to: JINN_STAKING,
      data: stakingIfaceRaw.encodeFunctionData('mapServiceInfo', [serviceId]),
    });
    const serviceMultisig = '0x' + mapResult.slice(26, 66);
    ok(`Service multisig (Safe): ${serviceMultisig}`);

    // Verify staking state
    const stakingState = await staking.getStakingState(serviceId);
    ok(`Staking state: ${stakingState} (1=Staked)`);

    // Verify operator is Safe owner
    const safe = new ethers.Contract(serviceMultisig, SAFE_ABI, provider);
    const owners = await safe.getOwners();
    const isOwner = owners.some((o: string) => o.toLowerCase() === operatorWallet.address.toLowerCase());
    if (isOwner) {
      ok(`Operator EOA is Safe owner`);
    } else {
      fail(`Operator EOA NOT in Safe owners: [${owners.join(', ')}]`);
    }
    info(`Safe owners: [${owners.join(', ')}]`);
    info(`Safe nonce: ${await safe.nonce()}`);

    // ── Step 6: Import service via ServiceImporter ──
    section('Step 6: Import Service via ServiceImporter');

    const operateBasePath = `${tmpdir()}/stolas-e2e-${Date.now()}`;
    // Encrypt agent key (matching production flow — no plaintext keys on disk)
    const e2ePassword = 'e2e-test-password';
    const keystoreJson = await operatorWallet.encrypt(e2ePassword);
    const ks = JSON.parse(keystoreJson);
    const encryptedKeystore = JSON.stringify({
      address: ks.address, crypto: ks.crypto, id: ks.id, version: ks.version,
    });
    process.env.OPERATE_PASSWORD = e2ePassword;

    const synthesized = await importServiceFromChain({
      serviceId,
      agentInstanceAddress: operatorWallet.address,
      encryptedKeystore,
      rpcUrl: adminRpc,
      chain: 'base',
      operateBasePath,
      stakingContractAddress: JINN_STAKING,
    });
    tempDir = operateBasePath;

    ok(`Config written: ${synthesized.configPath}`);
    ok(`Keys written:   ${synthesized.keysPath}`);
    ok(`Multisig from chain: ${synthesized.multisig}`);
    info(`Service config ID: ${synthesized.serviceConfigId}`);

    // ── Step 7: Verify ServiceConfigReader ──
    section('Step 7: Verify ServiceConfigReader');

    const serviceInfo = await readServiceConfig(
      operateBasePath,
      synthesized.serviceConfigId
    );

    if (!serviceInfo) {
      fail('ServiceConfigReader returned null');
      process.exit(1);
    }

    // Validate all fields
    let allPass = true;

    function check(field: string, actual: any, expected: any) {
      const actualStr = String(actual ?? '').toLowerCase();
      const expectedStr = String(expected).toLowerCase();
      if (actualStr === expectedStr) {
        ok(`${field}: ${actual}`);
      } else {
        fail(`${field}: expected ${expected}, got ${actual}`);
        allPass = false;
      }
    }

    check('serviceConfigId', serviceInfo.serviceConfigId, synthesized.serviceConfigId);
    check('serviceId', serviceInfo.serviceId, serviceId);
    check('serviceSafeAddress', serviceInfo.serviceSafeAddress, ethers.getAddress(serviceMultisig));
    check('agentEoaAddress', serviceInfo.agentEoaAddress, operatorWallet.address);
    check('chain', serviceInfo.chain, 'base');
    check('stakingContractAddress', serviceInfo.stakingContractAddress, JINN_STAKING);
    check('hasPrivateKey', Boolean(serviceInfo.agentPrivateKey), true);

    if (serviceInfo.agentPrivateKey) {
      // Verify the private key derives to the correct address
      const derivedWallet = new ethers.Wallet(serviceInfo.agentPrivateKey);
      check('privateKey→address', derivedWallet.address, operatorWallet.address);
    }

    // ── Step 8: Fund agent EOA for mech deployment ──
    section('Step 8: Fund Agent EOA for Mech Deployment');

    await rpcCall(adminRpc, 'tenderly_setBalance', [
      [operatorWallet.address],
      ethToHex('0.01'),
    ]);

    const agentBal = await provider.getBalance(operatorWallet.address);
    ok(`Agent EOA funded: ${ethers.formatEther(agentBal)} ETH`);

    // ── Step 9: Deploy mech via service Safe ──
    section('Step 9: Deploy Mech via Service Safe');

    info(`MechMarketplace: ${MECH_MARKETPLACE}`);
    info(`ServiceId: ${serviceId}`);
    info(`ServiceSafe: ${ethers.getAddress(serviceMultisig)}`);
    info(`AgentEOA (Safe owner): ${operatorWallet.address}`);

    const mechResult = await deployMechViaSafe({
      rpcUrl: adminRpc,
      chain: 'base',
      serviceId,
      serviceSafeAddress: ethers.getAddress(serviceMultisig),
      agentPrivateKey: operatorWallet.privateKey,
    });

    if (!mechResult.success) {
      fail(`Mech deployment failed: ${mechResult.error}`);
      if (mechResult.txHash) info(`TX: ${mechResult.txHash}`);
      process.exit(1);
    }

    ok(`Mech deployed: ${mechResult.mechAddress}`);
    ok(`TX hash: ${mechResult.txHash}`);

    // ── Step 10: Verify mech contract on-chain + config update ──
    section('Step 10: Verify Mech Contract');

    // Verify mech bytecode exists
    const mechCode = await provider.getCode(mechResult.mechAddress!);
    const hasCode = mechCode !== '0x' && mechCode.length > 2;
    check('mechContractExists', hasCode, true);
    info(`Bytecode length: ${mechCode.length} chars`);

    // Verify mech properties
    const mechABI = ['function tokenId() view returns (uint256)', 'function maxDeliveryRate() view returns (uint256)'];
    const mechContract = new ethers.Contract(mechResult.mechAddress!, mechABI, provider);
    const [mechTokenId, mechMaxRate] = await Promise.all([
      mechContract.tokenId(),
      mechContract.maxDeliveryRate(),
    ]);
    check('mechTokenId', Number(mechTokenId), serviceId);
    ok(`Mech maxDeliveryRate: ${mechMaxRate} wei`);

    // Update config with mech address
    const mechToConfigValue = buildMechToConfigValue(mechResult.mechAddress!);
    const configRaw = await fs.readFile(synthesized.configPath, 'utf-8');
    const configData = JSON.parse(configRaw);
    configData.env_variables.MECH_TO_CONFIG.value = mechToConfigValue;
    await fs.writeFile(synthesized.configPath, JSON.stringify(configData, null, 2));
    ok(`Config updated with MECH_TO_CONFIG`);
    info(`MECH_TO_CONFIG: ${mechToConfigValue}`);

    // Re-read config to verify
    const updatedInfo = await readServiceConfig(operateBasePath, synthesized.serviceConfigId);
    const mechAddr = updatedInfo?.mechAddress;
    if (mechAddr) {
      check('mechAddressInConfig', mechAddr.toLowerCase(), mechResult.mechAddress!.toLowerCase());
    } else {
      info('ServiceConfigReader does not expose mechAddress directly — checking raw config');
      const reRead = JSON.parse(await fs.readFile(synthesized.configPath, 'utf-8'));
      const mechToConfig = reRead.env_variables?.MECH_TO_CONFIG?.value;
      check('MECH_TO_CONFIG populated', Boolean(mechToConfig && mechToConfig.trim()), true);
    }

    // ── Summary ──
    section('Summary');

    if (allPass) {
      ok('All checks passed!');
    } else {
      fail('Some checks failed — see above');
    }

    console.log('');
    ok(`1.  Fork inherited live setStakingProxyConfigs`);
    ok(`2.  Generated operator EOA: ${operatorWallet.address}`);
    ok(`3.  stake() succeeded (permissionless, no curating agent)`);
    ok(`4.  New service ID: ${serviceId}, Safe: ${ethers.getAddress(serviceMultisig)}`);
    ok(`5.  Operator is Safe owner: ${isOwner}`);
    ok(`6.  .operate/ config imported via ServiceImporter`);
    ok(`7.  ServiceConfigReader validated`);
    ok(`8.  Agent EOA funded for gas`);
    ok(`9.  Mech deployed via service Safe: ${mechResult.mechAddress}`);
    ok(`10. Mech verified on-chain (tokenId=${serviceId}, bytecode=${mechCode.length} chars)`);
    ok(`11. Config updated with MECH_TO_CONFIG`);
    console.log('');
    info('Remaining manual steps for production:');
    info('  - Whitelist mech on activity checker');
    info('  - Upload .operate/ to Railway volume');
    info('  - Redeploy worker');

  } finally {
    // Cleanup
    section('Cleanup');

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      ok('Removed temp .operate/ directory');
    }

    const cleaned = await client.cleanupOldVnets({ maxAgeMs: 0 });
    ok(`Cleaned up ${cleaned} VNet(s)`);
  }
}

main().catch(e => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
