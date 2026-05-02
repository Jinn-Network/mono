#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { runRelease, renderHelp } from './lib/release-sdk.mjs';

function fail(message) {
  console.error(`release-sdk: ${message}`);
  process.exit(1);
}

async function main() {
  const parsed = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      prepare: { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      resume: { type: 'string' },
      'workflow-timeout-ms': { type: 'string' },
      'workflow-poll-ms': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    console.log(renderHelp('node scripts/release-sdk.mjs'));
    return;
  }
  if (parsed.values.prepare && parsed.values.publish) {
    fail('choose only one of --prepare or --publish');
  }

  const workflowTimeoutMs = parsed.values['workflow-timeout-ms']
    ? Number.parseInt(parsed.values['workflow-timeout-ms'], 10)
    : undefined;
  const workflowPollMs = parsed.values['workflow-poll-ms']
    ? Number.parseInt(parsed.values['workflow-poll-ms'], 10)
    : undefined;

  const mode = parsed.values.publish ? 'publish' : 'prepare';
  const report = await runRelease({
    mode,
    resumeDir: parsed.values.resume,
    workflowTimeoutMs,
    workflowPollMs,
  });

  console.log(`release-sdk: ${mode} completed`);
  console.log(`  report: ${report.reportPath}`);
  if (report.githubReleaseUrl) console.log(`  release: ${report.githubReleaseUrl}`);
}

main().catch((err) => {
  fail(err?.message ?? String(err));
});
