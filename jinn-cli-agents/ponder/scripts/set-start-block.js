#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const envPath = resolve(repoRoot, '.env');

async function setStartBlock() {
  // Read RPC_URL and PONDER_START_BLOCK from root .env file
  let rpcUrl = process.env.RPC_URL;
  let existingStartBlock = process.env.PONDER_START_BLOCK;

  const forcedAutoStart = process.env.VITEST === 'true';

  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf8');

    if (!rpcUrl) {
      const rpcMatch = envContent.match(/^RPC_URL=(.+)$/m);
      if (rpcMatch) {
        rpcUrl = rpcMatch[1].trim();
      }
    }

    if (!existingStartBlock) {
      const startBlockMatch = envContent.match(/^PONDER_START_BLOCK=(.+)$/m);
      if (startBlockMatch) {
        existingStartBlock = startBlockMatch[1].trim();
      }
    }
  }

  if (forcedAutoStart) {
    if (existingStartBlock) {
      console.log(`[ponder] VITEST detected - overriding PONDER_START_BLOCK ${existingStartBlock}`);
    } else {
      console.log('[ponder] VITEST detected - calculating fresh PONDER_START_BLOCK');
    }
    existingStartBlock = undefined;
  }

  if (!rpcUrl) {
    console.log('[ponder] No RPC_URL found, skipping auto start block');
    return;
  }

  // Skip if PONDER_START_BLOCK is already explicitly set
  if (existingStartBlock) {
    console.log(`[ponder] PONDER_START_BLOCK already set to ${existingStartBlock}`);
    return;
  }

  try {
    // Fetch current block
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1
      })
    });

    const data = await response.json();
    const currentBlock = parseInt(data.result, 16);
    const startBlock = Math.max(0, currentBlock - 100);

    console.log(`[ponder] Current block: ${currentBlock}`);
    console.log(`[ponder] Setting PONDER_START_BLOCK to ${startBlock} (current - 100)`);

    // Set env var for this process
    process.env.PONDER_START_BLOCK = String(startBlock);

    // Update .env file if it exists and we are not forcing auto mode (avoid dirtying repo during tests)
    if (!forcedAutoStart && existsSync(envPath)) {
      let envContent = readFileSync(envPath, 'utf8');

      // Remove existing PONDER_START_BLOCK
      envContent = envContent.replace(/^PONDER_START_BLOCK=.*$/gm, '');

      // Add new PONDER_START_BLOCK
      envContent = envContent.trim() + `\nPONDER_START_BLOCK=${startBlock}\n`;

      writeFileSync(envPath, envContent);
      console.log('[ponder] Updated .env with new PONDER_START_BLOCK');
    }
  } catch (error) {
    console.error('[ponder] Failed to fetch current block:', error.message);
    console.log('[ponder] Continuing without auto start block...');
  }
}

await setStartBlock();
