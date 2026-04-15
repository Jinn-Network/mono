#!/usr/bin/env tsx
/**
 * Export Keys - Export wallet mnemonic/seed phrase
 *
 * Usage: yarn wallet:export-keys
 *
 * Uses OlasOperateWrapper for middleware daemon management.
 *
 * SECURITY WARNING: The mnemonic provides full access to your wallet.
 * Store it securely offline. Never share it with anyone.
 */

import 'dotenv/config';
import * as readline from 'readline';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';

async function promptPassword(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    // Note: This doesn't hide the password. For production, use a proper password input library
    rl.question('Enter OPERATE_PASSWORD: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log('');
  console.log('⚠️  WARNING: You are about to export your wallet recovery phrase.');
  console.log('⚠️  Anyone with this phrase can access ALL your funds.');
  console.log('⚠️  Never share it. Store it securely offline.');
  console.log('');

  // Get password from env or prompt
  let password = process.env.OPERATE_PASSWORD;

  if (!password) {
    password = await promptPassword();
  }

  if (!password) {
    console.error('Error: Password is required');
    process.exit(1);
  }

  console.log('\nStarting middleware daemon...');

  // Create wrapper and start daemon
  const wrapper = await OlasOperateWrapper.create({
    rpcUrl: process.env.RPC_URL || undefined,
  });

  try {
    await wrapper.startServer();
    await wrapper.login(password);

    // Export mnemonic via wrapper method
    const result = await wrapper.exportMnemonic('ethereum');

    if (!result.success || !result.mnemonic) {
      console.error('\n❌ Failed to export mnemonic:', result.error);
      console.error('   Make sure the password is correct.');
      process.exit(1);
    }

    const mnemonic = result.mnemonic;

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    RECOVERY SEED PHRASE                        ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Display mnemonic words in a numbered format
    for (let i = 0; i < mnemonic.length; i++) {
      const num = String(i + 1).padStart(2, ' ');
      console.log(`  ${num}. ${mnemonic[i]}`);
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('✅ Write these words down on paper and store securely.');
    console.log('❌ Do NOT store digitally (no photos, no cloud, no email).');
    console.log('❌ Do NOT share with anyone.');
    console.log('');
    console.log('With this phrase you can recover your wallet on any device.');
    console.log('═══════════════════════════════════════════════════════════════');

  } finally {
    await wrapper.stopServer();
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
