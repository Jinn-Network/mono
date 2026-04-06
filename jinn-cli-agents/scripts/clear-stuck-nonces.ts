#!/usr/bin/env tsx
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

const RPC_URL = process.env.RPC_URL!;
const provider = new ethers.JsonRpcProvider(RPC_URL);

async function getWallet(): Promise<ethers.Wallet> {
  if (process.env.JINN_SERVICE_PRIVATE_KEY) {
    return new ethers.Wallet(process.env.JINN_SERVICE_PRIVATE_KEY, provider);
  }
  // Decrypt from .operate profile
  const profileDir = process.env.OPERATE_PROFILE_DIR;
  const password = process.env.OPERATE_PASSWORD;
  if (!profileDir || !password) throw new Error('Set JINN_SERVICE_PRIVATE_KEY or OPERATE_PROFILE_DIR + OPERATE_PASSWORD');
  const keyPath = path.join(profileDir, 'keys', '0xE0f75Fb9e33c3aa8aB127929d16403B10BC54148');
  const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  const pk = keyData.private_key;
  const ksJson = typeof pk === 'string' && pk.startsWith('0x') ? pk.slice(2) : pk;
  const ksObj = typeof ksJson === 'string' ? JSON.parse(ksJson) : ksJson;
  const w = await ethers.Wallet.fromEncryptedJson(JSON.stringify(ksObj), password);
  return w.connect(provider);
}

const wallet = await getWallet();

async function main() {
  console.log('Agent:', wallet.address);
  const pending = await provider.getTransactionCount(wallet.address, 'pending');
  const confirmed = await provider.getTransactionCount(wallet.address, 'latest');
  console.log(`Confirmed nonce: ${confirmed}, Pending nonce: ${pending}`);

  if (pending <= confirmed) {
    console.log('No stuck txs — all clear');
    return;
  }

  const stuck = pending - confirmed;
  console.log(`${stuck} stuck tx(s) — sending replacements with high gas...`);

  for (let n = confirmed; n < pending; n++) {
    const tx = await wallet.sendTransaction({
      to: wallet.address,
      value: 0,
      nonce: n,
      maxFeePerGas: ethers.parseUnits('1', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
    });
    const receipt = await tx.wait();
    console.log(`Cleared nonce ${n} — tx: ${receipt!.hash}`);
  }
  console.log('Done');
}

main().catch(e => { console.error(e.message); process.exit(1); });
