#!/usr/bin/env node
/**
 * stub-hermes.mjs — simulates a Hermes harness run for acceptance-tier tests.
 *
 * Usage:
 *   node stub-hermes.mjs '<JSON args>'
 *
 * The JSON args object shape:
 *   {
 *     taskBody:     object   — the SWE-rebench v2 task payload
 *     hermesConfig: object   — { mcp_servers, skills, plugins: [{name, version, cid, sha256}] }
 *     workingDir:   string   — absolute path to the task working directory
 *   }
 *
 * Behaviour:
 *   1. Parse the args from argv[2].
 *   2. Print JSON { plugins: hermesConfig.plugins } to stdout (so the test can
 *      capture which plug-ins were "loaded").
 *   3. Write a canned solution-payload.json to <workingDir>/.execute/ that
 *      the daemon's envelope assembler can read.
 *   4. Exit 0.
 *
 * The stub does NOT compute envelope bytes — the daemon's envelope assembler
 * does that with the plug-in attribution already on disk in the plugin registry.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rawArgs = process.argv[2];
if (!rawArgs) {
  console.error('stub-hermes: missing JSON args as argv[2]');
  process.exit(1);
}

let args;
try {
  args = JSON.parse(rawArgs);
} catch (err) {
  console.error(`stub-hermes: invalid JSON args: ${err.message}`);
  process.exit(1);
}

const { taskBody, hermesConfig, workingDir } = args;

if (typeof workingDir !== 'string' || workingDir.length === 0) {
  console.error('stub-hermes: workingDir must be a non-empty string');
  process.exit(1);
}

const plugins = (hermesConfig?.plugins ?? []);

// 1. Print the plug-in list to stdout so the test can assert on it.
process.stdout.write(JSON.stringify({ plugins }) + '\n');

// 2. Write a canned solution-payload.json to the .execute/ directory.
const executeDir = join(workingDir, '.execute');
mkdirSync(executeDir, { recursive: true });

const solutionPayload = {
  schemaVersion: 'swe-rebench-v2-solution.v1',
  patch: [
    '--- a/src/foo.c',
    '+++ b/src/foo.c',
    '@@ -1 +1 @@',
    '-broken',
    '+fixed',
  ].join('\n') + '\n',
  cost: { totalUsd: 0.01 },
  // Echo back the task instance_id for traceability.
  instance_id: taskBody?.instance_id ?? 'unknown',
};

writeFileSync(
  join(executeDir, 'solution-payload.json'),
  JSON.stringify(solutionPayload, null, 2),
  'utf8',
);

// Exit 0 — success (stub always "passes").
process.exit(0);
