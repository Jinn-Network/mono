#!/usr/bin/env tsx

import { chromium } from 'playwright';

const requestId = '0x59acee61f4404a50a7afb0dfb5005e4f1d4fa5f96d1bcd0524d334cc1c36a330';
const explorerUrl = `https://indexer.jinn.network/requests/${requestId}`;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(explorerUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Similar Situations', { timeout: 15_000 });
    await page.waitForSelector('text=Memory system observability is available via the CLI and MCP tools.', { timeout: 15_000 });
    await page.waitForSelector('text=inspect-situation.ts', { timeout: 15_000 });

    console.log('✅ Memory visualization guidance is visible on the explorer page.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Memory visualization verification failed:', error);
  process.exit(1);
});
