#!/usr/bin/env tsx
/**
 * Blast heartbeat requests to meet staking liveness quota.
 *
 * Usage:
 *   OPERATE_PASSWORD=12345678 OPERATE_PROFILE_DIR=/Users/gcd/Repositories/main/jinn-node/.operate \
 *     RPC_URL=https://base.gateway.tenderly.co/6g74EyOoSgvpbSiU9h4mzl \
 *     tsx scripts/blast-heartbeats.ts [--dry-run]
 *
 * Reads service config from the .operate profile (venture-test-worker / service 359).
 */

import { ethers } from 'ethers';
import { pushMetadataToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';

// --- Config (venture-test-worker / service 359) ---
const MECH_ADDRESS = '0x44C53e3764188586Ddb1B1389A00F675867E3a9d';
const SERVICE_SAFE = '0xD2C24F6d9e7520e57FAEbf5d1C44100C4502710B';
const MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';
const SERVICE_ID = 359;
const TARGET = 60;
const PRIVATE_KEY = process.env.JINN_SERVICE_PRIVATE_KEY;

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error('RPC_URL required');

const DRY_RUN = process.argv.includes('--dry-run');

// --- ABIs ---
const STAKING_ABI = [
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];
const MARKETPLACE_ABI = [
  'function mapRequestCounts(address) view returns (uint256)',
  'function request(bytes memory requestData, uint256 maxDeliveryRate, bytes32 paymentType, address priorityMech, uint256 responseTimeout, bytes memory paymentData) external payable returns (bytes32 requestId)',
  'function minResponseTimeout() view returns (uint256)',
  'function maxResponseTimeout() view returns (uint256)',
];
const MECH_ABI = [
  'function paymentType() view returns (bytes32)',
  'function maxDeliveryRate() view returns (uint256)',
];
const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
];

async function getPrivateKey(): Promise<string> {
  if (PRIVATE_KEY) return PRIVATE_KEY;

  // Try loading from .operate profile
  const profileDir = process.env.OPERATE_PROFILE_DIR;
  const password = process.env.OPERATE_PASSWORD;
  if (profileDir && password) {
    const fs = await import('fs');
    const path = await import('path');
    const keystorePath = path.join(profileDir, 'wallets', 'ethereum.txt');
    if (fs.existsSync(keystorePath)) {
      const ks = JSON.parse(fs.readFileSync(keystorePath, 'utf-8'));
      const wallet = await ethers.Wallet.fromEncryptedJson(JSON.stringify(ks), password);
      console.log(`Decrypted master EOA: ${wallet.address}`);

      // Find service 359's agent key
      // Look for the specific agent key file
      const keysDir = path.join(profileDir, 'keys');
      const AGENT_ADDRESS = '0xE0f75Fb9e33c3aa8aB127929d16403B10BC54148';
      const keyPath = path.join(keysDir, AGENT_ADDRESS);
      if (fs.existsSync(keyPath)) {
        const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
        if (keyData.private_key) {
          const pk = keyData.private_key;
          if (typeof pk === 'string' && pk.startsWith('0x') && pk.length === 66) {
            return pk;
          }
          // Encrypted keystore prefixed with 0x
          const ksJson = typeof pk === 'string' && pk.startsWith('0x') ? pk.slice(2) : pk;
          const ksObj = typeof ksJson === 'string' ? JSON.parse(ksJson) : ksJson;
          const agentWallet = await ethers.Wallet.fromEncryptedJson(JSON.stringify(ksObj), password);
          console.log(`Decrypted agent key: ${agentWallet.address}`);
          return agentWallet.privateKey;
        }
      }
      console.log(`Agent key file not found at ${keyPath}, falling back to master EOA`);
      return wallet.privateKey;
    }
  }
  throw new Error('No private key found. Set JINN_SERVICE_PRIVATE_KEY or OPERATE_PROFILE_DIR + OPERATE_PASSWORD');
}

async function main() {
  const privateKey = await getPrivateKey();
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`Agent wallet: ${wallet.address}`);

  // Check deficit
  const staking = new ethers.Contract(STAKING_CONTRACT, STAKING_ABI, provider);
  const marketplace = new ethers.Contract(MARKETPLACE, MARKETPLACE_ABI, provider);
  const mech = new ethers.Contract(MECH_ADDRESS, MECH_ABI, provider);

  const [nextCheckpoint, serviceInfo, currentCount, paymentType, maxDeliveryRate, maxTimeout] = await Promise.all([
    staking.getNextRewardCheckpointTimestamp().then(Number),
    staking.getServiceInfo(SERVICE_ID),
    marketplace.mapRequestCounts(SERVICE_SAFE).then(Number),
    mech.paymentType(),
    mech.maxDeliveryRate(),
    marketplace.maxResponseTimeout(),
  ]);

  const baseline = Number(serviceInfo.nonces[1]);
  const requestsThisEpoch = currentCount - baseline;
  const deficit = Math.max(0, TARGET - requestsThisEpoch);
  const now = Math.floor(Date.now() / 1000);
  const epochSecondsRemaining = Math.max(0, nextCheckpoint - now);

  console.log(`\n--- Epoch Status ---`);
  console.log(`Baseline (nonces[1]): ${baseline}`);
  console.log(`Current requests:     ${currentCount}`);
  console.log(`Requests this epoch:  ${requestsThisEpoch}`);
  console.log(`Target:               ${TARGET}`);
  console.log(`Deficit:              ${deficit}`);
  console.log(`Epoch resets in:      ${Math.floor(epochSecondsRemaining / 60)}m ${epochSecondsRemaining % 60}s`);
  console.log(`Max delivery rate:    ${ethers.formatEther(maxDeliveryRate)} ETH`);
  console.log(`Payment type:         ${paymentType}`);

  if (deficit <= 0) {
    console.log(`\nTarget already met — nothing to do.`);
    return;
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would submit ${deficit} heartbeat requests. Exiting.`);
    return;
  }

  // Re-check current deficit (may have changed since dry-run)
  const freshCount = await marketplace.mapRequestCounts(SERVICE_SAFE).then(Number);
  const freshDeficit = Math.max(0, TARGET - (freshCount - baseline));
  console.log(`\nSubmitting ${freshDeficit} heartbeat requests (current: ${freshCount})...\n`);

  const safe = new ethers.Contract(SERVICE_SAFE, SAFE_ABI, wallet);
  let submitted = 0;
  let consecutiveFailures = 0;

  // Pre-upload all IPFS digests in parallel to avoid per-iteration latency
  console.log(`Uploading ${freshDeficit} heartbeat payloads to IPFS...`);
  const digests: string[] = [];
  for (let i = 0; i < freshDeficit; i++) {
    const prompt = JSON.stringify({
      heartbeat: true,
      ts: Date.now(),
      service: SERVICE_ID,
      blast: i + 1,
      of: freshDeficit,
    });
    const [digestHex] = await pushMetadataToIpfs(prompt, 'openai-gpt-4', {
      heartbeat: true,
      jobName: '__heartbeat__',
    });
    digests.push(digestHex);
  }
  console.log(`IPFS uploads done. Submitting on-chain...\n`);

  // Clear any stuck pending txs first
  async function clearStuckNonces() {
    const pending = await provider.getTransactionCount(wallet.address, 'pending');
    const confirmed = await provider.getTransactionCount(wallet.address, 'latest');
    if (pending > confirmed) {
      console.log(`Clearing ${pending - confirmed} stuck pending tx(s)...`);
      for (let n = confirmed; n < pending; n++) {
        try {
          const tx = await wallet.sendTransaction({
            to: wallet.address, value: 0, nonce: n,
            maxFeePerGas: ethers.parseUnits('2', 'gwei'),
            maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
          });
          await tx.wait();
          console.log(`  Cleared nonce ${n}`);
        } catch (e: any) {
          console.log(`  Nonce ${n}: ${e.message?.slice(0, 60)}`);
        }
      }
    }
  }

  await clearStuckNonces();

  for (let i = 0; i < freshDeficit; i++) {
    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Clear any leftover pending txs
        await clearStuckNonces();

        const callData = marketplace.interface.encodeFunctionData('request', [
          digests[i],
          maxDeliveryRate,
          paymentType,
          MECH_ADDRESS,
          maxTimeout,
          '0x',
        ]);

        const safeNonce = await safe.nonce();
        const txHash = await safe.getTransactionHash(
          MARKETPLACE, 0n, callData, 0, 0, 0, 0,
          ethers.ZeroAddress, ethers.ZeroAddress, safeNonce,
        );

        const signature = await wallet.signMessage(ethers.getBytes(txHash));
        const sigBytes = ethers.getBytes(signature);
        const r = ethers.hexlify(sigBytes.slice(0, 32));
        const s = ethers.hexlify(sigBytes.slice(32, 64));
        const v = sigBytes[64] + 4;
        const adjustedSig = ethers.concat([r, s, new Uint8Array([v])]);

        // Explicitly get confirmed EOA nonce for the tx
        const eoaNonce = await provider.getTransactionCount(wallet.address, 'latest');

        const tx = await safe.execTransaction(
          MARKETPLACE, 0n, callData, 0, 0, 0, 0,
          ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig,
          {
            gasLimit: 500_000,
            nonce: eoaNonce,
            maxFeePerGas: ethers.parseUnits('0.15', 'gwei'),
            maxPriorityFeePerGas: ethers.parseUnits('0.05', 'gwei'),
          },
        );
        const receipt = await tx.wait(1);

        if (receipt!.status === 1) {
          submitted++;
          consecutiveFailures = 0;
          console.log(`[${i + 1}/${freshDeficit}] OK tx=${receipt!.hash} gas=${receipt!.gasUsed}`);
          success = true;
          // Wait 2s for node to update Safe nonce
          await new Promise(r => setTimeout(r, 2000));
          break;
        } else {
          consecutiveFailures++;
          console.log(`[${i + 1}/${freshDeficit}] INNER REVERT (attempt ${attempt + 1}/3) — waiting 5s`);
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (err: any) {
        consecutiveFailures++;
        const msg = err.message?.slice(0, 150) || String(err);
        console.error(`[${i + 1}/${freshDeficit}] FAILED (attempt ${attempt + 1}/3): ${msg}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (!success) {
      console.log(`[${i + 1}/${freshDeficit}] Exhausted retries — moving to next`);
      consecutiveFailures = 0; // reset per-request
    }

    if (consecutiveFailures >= 10) {
      console.error(`\n10 consecutive failures — aborting. Submitted ${submitted} so far.`);
      break;
    }
  }

  // Verify
  const finalCount = await marketplace.mapRequestCounts(SERVICE_SAFE).then(Number);
  console.log(`\n--- Final ---`);
  console.log(`Requests now: ${finalCount} (was ${currentCount})`);
  console.log(`This epoch:   ${finalCount - baseline} / ${TARGET}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
