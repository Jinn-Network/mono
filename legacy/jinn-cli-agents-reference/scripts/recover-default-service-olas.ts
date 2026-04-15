#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Recovery Script: Transfer OLAS from default-service Safe to Master Safe
 * Using direct agent key signing (not Safe execTransaction which has signature issues)
 */

import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';

// default-service configuration
const SERVICE_SAFE = '0xa70Ea55b009fB50AFae9136049bB1EB52880691e';
const AGENT_KEY_PRIVATE_KEY = '0xbfd3377803271f33b8c079b29cd99b42c1ebc7b0b319f38b1e5b20c05fa54d1a';
const AGENT_KEY_ADDRESS = '0x879f73A2F355BD1d1bB299D21d9B621Ce6C4c285';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

async function main() {
  console.log('🔄 OLAS Recovery from default-service Safe\n');
  console.log(`Service Safe: ${SERVICE_SAFE}`);
  console.log(`Master Safe: ${MASTER_SAFE}`);
  console.log(`Agent Key: ${AGENT_KEY_ADDRESS}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const agentWallet = new ethers.Wallet(AGENT_KEY_PRIVATE_KEY, provider);
  
  const olasToken = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
  const olasWithSigner = olasToken.connect(agentWallet);

  // Check balance in SERVICE SAFE
  const safeBalance = await olasToken.balanceOf(SERVICE_SAFE);
  const decimals = await olasToken.decimals();
  const symbol = await olasToken.symbol();
  const safeFormatted = ethers.formatUnits(safeBalance, decimals);

  console.log(`📊 Service Safe Balance: ${safeFormatted} ${symbol}\n`);

  if (safeBalance === 0n) {
    console.log('✅ Nothing to recover!');
    return;
  }

  // Wait - the OLAS is IN the Safe, not in the agent EOA
  // We need to use the Safe's execTransaction, but with proper signature
  // OR use Safe SDK
  
  // Actually, let me check if agent has any OLAS
  const agentBalance = await olasToken.balanceOf(AGENT_KEY_ADDRESS);
  const agentFormatted = ethers.formatUnits(agentBalance, decimals);
  
  console.log(`Agent Key Balance: ${agentFormatted} ${symbol}`);
  
  if (agentBalance > 0n) {
    console.log(`\n📤 Recovering OLAS from agent key...`);
    const tx = await olasWithSigner.transfer(MASTER_SAFE, agentBalance);
    console.log(`   Tx: ${tx.hash}`);
    await tx.wait();
    console.log(`   ✅ Recovered ${agentFormatted} ${symbol} from agent key\n`);
  }
  
  // For Safe recovery, we need Safe SDK or manual UI
  if (safeBalance > 0n) {
    console.log(`⚠️  ${safeFormatted} ${symbol} is locked in the Safe.`);
    console.log(`   The Safe requires proper EIP-712 signature format.`);
    console.log(`\n   Use Safe UI to recover:`);
    console.log(`   1. Import key: ${AGENT_KEY_PRIVATE_KEY}`);
    console.log(`   2. Go to: https://app.safe.global/home?safe=base:${SERVICE_SAFE}`);
    console.log(`   3. Send ${safeFormatted} ${symbol} to ${MASTER_SAFE}`);
  }
}

main().catch(console.error);

