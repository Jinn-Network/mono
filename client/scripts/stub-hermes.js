#!/usr/bin/env node
// Stub binary used in hermes-agent e2e tests. Parses argv for -w <workingDir>,
// writes a valid SWE-rebench v2 solution payload to
// <workingDir>/.execute/solution-payload.json, exits 0.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

// Pre-flight commands like `hermes --version` / `--help` must NOT write a
// solution payload — otherwise the e2e's "binary exists and works" probe
// drops a sentinel file into cwd before the actual run.
if (args.includes('--version') || args.includes('--help')) {
  process.stdout.write('stub-hermes 0.0.0\n');
  process.exit(0);
}

const wIdx = args.indexOf('-w');
const workingDir = wIdx >= 0 ? args[wIdx + 1] : process.cwd();
mkdirSync(join(workingDir, '.execute'), { recursive: true });
writeFileSync(
  join(workingDir, '.execute/solution-payload.json'),
  JSON.stringify({ schemaVersion: 'swe-rebench-v2-solution.v1', patch: '--- a/file\n+++ b/file\n' }),
);
process.exit(0);
