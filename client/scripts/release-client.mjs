#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { runRelease, renderHelp } from './lib/release-client.mjs';

function fail(message) {
  console.error(`release-client: ${message}`);
  process.exit(1);
}

async function main() {
  const parsed = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      prepare: { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      resume: { type: 'string' },
      'skip-acceptance': { type: 'boolean', default: false },
      'workflow-timeout-ms': { type: 'string' },
      'workflow-poll-ms': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    console.log(renderHelp('node scripts/release-client.mjs'));
    return;
  }
  if (parsed.values.prepare && parsed.values.publish) {
    fail('choose only one of --prepare or --publish');
  }

  const mode = parsed.values.publish ? 'publish' : 'prepare';
  if (mode === 'publish' && parsed.values['skip-acceptance']) {
    fail('--skip-acceptance is only allowed with --prepare; publish releases must include Docker testnet acceptance');
  }
  const workflowTimeoutMs = parsed.values['workflow-timeout-ms']
    ? Number.parseInt(parsed.values['workflow-timeout-ms'], 10)
    : undefined;
  const workflowPollMs = parsed.values['workflow-poll-ms']
    ? Number.parseInt(parsed.values['workflow-poll-ms'], 10)
    : undefined;

  const report = await runRelease({
    mode,
    resumeDir: parsed.values.resume,
    skipAcceptance: parsed.values['skip-acceptance'],
    workflowTimeoutMs,
    workflowPollMs,
  });

  console.log(`release-client: ${mode} completed`);
  console.log(`  report: ${report.reportPath}`);
  if (report.acceptanceEvidenceDir) console.log(`  acceptance: ${report.acceptanceEvidenceDir}`);
  if (report.githubReleaseUrl) console.log(`  release: ${report.githubReleaseUrl}`);
}

main().catch((err) => {
  fail(err?.message ?? String(err));
});
