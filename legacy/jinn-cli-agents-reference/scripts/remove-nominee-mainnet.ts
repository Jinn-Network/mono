#!/usr/bin/env ts-node
// @ts-nocheck

/**
 * Remove nominee from VoteWeighting contract on Ethereum Mainnet
 * 
 * NOTE: Only the VoteWeighting contract owner (DAO) can remove nominees.
 * This script will fail if called by anyone other than the owner.
 * 
 * Usage:
 *   yarn tsx scripts/remove-nominee-mainnet.ts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Import operate profile helpers
import { getMasterEOA } from 'jinn-node/env/operate-profile.js';

const VOTE_WEIGHTING = '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1';
const JINN_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';
const BASE_CHAIN_ID = 8453;

async function main() {
  console.log('=== Remove Nominee from VoteWeighting ===\n');

  // Get RPC URL
  const rpcUrl = process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com';
  console.log('Ethereum RPC:', rpcUrl);

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Get wallet
  let wallet: ethers.Wallet;

  if (process.env.NOMINATOR_PRIVATE_KEY) {
    wallet = new ethers.Wallet(process.env.NOMINATOR_PRIVATE_KEY, provider);
  } else {
    console.log('NOMINATOR_PRIVATE_KEY not set, using master EOA from operate profile...\n');
    
    const keystorePath = path.resolve(process.cwd(), 'olas-operate-middleware/.operate/wallets/ethereum.txt');
    if (!fs.existsSync(keystorePath)) {
      throw new Error(`Master wallet keystore not found at: ${keystorePath}`);
    }

    const keystoreJson = fs.readFileSync(keystorePath, 'utf-8');
    const password = process.env.OPERATE_PASSWORD;
    if (!password) {
      throw new Error('OPERATE_PASSWORD environment variable not set');
    }

    console.log('Decrypting master wallet...');
    wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
    wallet = wallet.connect(provider);
  }

  console.log('Nominator address:', wallet.address);
  console.log('');

  // Get contract
  const voteWeighting = new ethers.Contract(
    VOTE_WEIGHTING,
    [
      'function removeNominee(bytes32 account, uint256 chainId) external',
      'function owner() view returns (address)',
    ],
    wallet
  );

  // Check owner
  const owner = await voteWeighting.owner();
  console.log('VoteWeighting owner:', owner);
  console.log('Your address:', wallet.address);

  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log('\n⚠️  WARNING: You are not the contract owner!');
    console.log('Only the owner can remove nominees.');
    console.log('This transaction will likely fail.\n');
  }

  // Convert address to bytes32
  const nomineeBytes32 = ethers.zeroPadValue(JINN_CONTRACT.toLowerCase(), 32);

  console.log('Removing nominee:');
  console.log('  Address (bytes32):', nomineeBytes32);
  console.log('  Chain ID:', BASE_CHAIN_ID);
  console.log('');

  // Remove nominee
  console.log('Sending removeNominee transaction...');
  const tx = await voteWeighting.removeNominee(nomineeBytes32, BASE_CHAIN_ID);
  console.log('Transaction hash:', tx.hash);

  console.log('Waiting for confirmation...');
  const receipt = await tx.wait();
  console.log('Transaction confirmed in block:', receipt.blockNumber);
  console.log('');

  console.log('✅ Nominee removed successfully');
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
