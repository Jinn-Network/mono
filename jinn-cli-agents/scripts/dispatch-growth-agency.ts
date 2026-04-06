#!/usr/bin/env tsx
/**
 * Dispatch Growth Agency job with updated template system
 */
import { dispatchExistingJob } from '../jinn-node/src/agent/mcp/tools/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function dispatch() {
  // Read the updated growth-agency blueprint
  const blueprintPath = path.resolve(__dirname, '../blueprints/growth-agency.json');
  const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf-8'));

  console.log('📋 Dispatching Growth Agency with updated template system...\n');

  const result = await dispatchExistingJob({
    jobName: 'Growth Agency – TC2',
    workstreamId: '0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac',
    blueprint: JSON.stringify(blueprint),
    message: 'Growth Agency re-dispatch with refocused blueprint. IMPORTANT: Growth = product growth (usage, revenue, marketing, distribution). Create templates that product teams would use to grow their products/platforms/protocols. NOT generic business consulting, market research, or traditional agency work. Quality filter: would a product like Jinn use this template to grow itself? If not, skip it.',
  });

  const response = JSON.parse(result.content[0].text);

  if (response.meta.ok) {
    console.log('✅ Job dispatched successfully!\n');

    const requestId = response.data?.request?.id || response.data?.requestId;
    const workstreamId = response.data?.request?.workstreamId || response.data?.workstreamId;

    if (requestId) {
      console.log('Request ID:', requestId);
      if (workstreamId) {
        console.log('Workstream ID:', workstreamId);
      }
      console.log('\n📊 View in Explorer:');
      console.log(`https://explorer.jinn.network/requests/${requestId}`);
    } else {
      console.log('Response:', JSON.stringify(response.data, null, 2));
    }
  } else {
    console.error('❌ Dispatch failed:', response.meta.message);
    process.exit(1);
  }
}

dispatch();
