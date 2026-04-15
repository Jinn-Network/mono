#!/usr/bin/env tsx
/**
 * Claim staking rewards for a service via its owner Safe
 *
 * Calls claim(serviceId) on the Jinn staking contract through the Master Safe.
 * The Safe is the service owner, so the claim must be executed as a Safe tx.
 *
 * Usage:
 *   yarn staking:claim-rewards              # Claim pending rewards for service 165
 *   yarn staking:claim-rewards --dry-run    # Preview without sending tx
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { getMasterPrivateKey } from '../../src/env/operate-profile.js';
import { getServiceSafeAddress } from '../../src/env/operate-profile.js';
import { createRpcProvider } from '../../src/config/index.js';

const JINN_STAKING = process.env.STAKING_CONTRACT || '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';
const SERVICE_ID = parseInt(process.env.SERVICE_ID || '165');
const RPC_URL = process.env.RPC_URL || 'https://base-rpc.publicnode.com';

const STAKING_ABI = [
  'function claim(uint256 serviceId) external returns (uint256)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)',
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const provider = createRpcProvider(RPC_URL);

  const staking = new ethers.Contract(JINN_STAKING, STAKING_ABI, provider);
  const serviceInfo = await staking.getServiceInfo(SERVICE_ID);

  console.log(`Service ${SERVICE_ID} on Jinn staking (${JINN_STAKING})`);
  console.log(`  Owner (Safe):    ${serviceInfo.owner}`);
  console.log(`  Multisig:        ${serviceInfo.multisig}`);
  console.log(`  Reward pending:  ${ethers.formatEther(serviceInfo.reward)} OLAS`);
  console.log();

  if (serviceInfo.reward === 0n) {
    console.log('No rewards to claim. Checkpoint allocates rewards after each epoch ends.');
    return;
  }

  const masterSafe = serviceInfo.owner;

  const pk = getMasterPrivateKey();
  if (!pk) {
    console.error('No master key available. Set OPERATE_PASSWORD.');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(pk, provider);
  const safe = new ethers.Contract(masterSafe, SAFE_ABI, provider);

  const [owners, threshold, nonce, signerBalance] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
    safe.nonce(),
    provider.getBalance(wallet.address),
  ]);

  const isOwner = owners.some((o: string) => o.toLowerCase() === wallet.address.toLowerCase());
  console.log(`Signer:            ${wallet.address}`);
  console.log(`Is Safe owner:     ${isOwner}`);
  console.log(`Safe threshold:    ${threshold}`);
  console.log(`Base ETH balance:  ${ethers.formatEther(signerBalance)}`);
  console.log();

  if (!isOwner) {
    console.error('Signer is not a Safe owner.');
    process.exit(1);
  }

  if (Number(threshold) > 1) {
    console.error(`Safe threshold is ${threshold} — this script only supports 1-of-N Safes.`);
    process.exit(1);
  }

  if (signerBalance < ethers.parseEther('0.0001')) {
    console.error('Insufficient Base ETH for gas.');
    process.exit(1);
  }

  if (dryRun) {
    console.log(`--dry-run: would claim ${ethers.formatEther(serviceInfo.reward)} OLAS. Exiting.`);
    return;
  }

  const claimData = staking.interface.encodeFunctionData('claim', [SERVICE_ID]);

  const txHash = await safe.getTransactionHash(
    JINN_STAKING, 0, claimData, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, nonce
  );

  const sig = await wallet.signMessage(ethers.getBytes(txHash));
  const sigBytes = ethers.getBytes(sig);
  const adjustedSig = ethers.concat([
    sigBytes.slice(0, 32),
    sigBytes.slice(32, 64),
    new Uint8Array([sigBytes[64] + 4]) // v + 4 for eth_sign
  ]);

  console.log('Executing claim via Safe...');
  const safeSigned = safe.connect(wallet) as ethers.Contract;
  const tx = await safeSigned.execTransaction(
    JINN_STAKING, 0, claimData, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig
  );

  console.log(`TX sent: ${tx.hash}`);
  console.log('Waiting for confirmation...');

  const receipt = await tx.wait(1);
  if (receipt?.status === 1) {
    console.log(`Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed})`);

    const updated = await staking.getServiceInfo(SERVICE_ID);
    console.log();
    console.log(`Claimed:           ~${ethers.formatEther(serviceInfo.reward)} OLAS`);
    console.log(`Remaining reward:  ${ethers.formatEther(updated.reward)} OLAS`);
    console.log(`Sent to multisig:  ${serviceInfo.multisig}`);
  } else {
    console.error('TX reverted:', tx.hash);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
