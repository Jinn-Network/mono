#!/usr/bin/env tsx
/**
 * jinn-triage-check — CLI shim invoked by the implement-issue skill at Step 1.5.
 *
 * Usage: jinn-triage-check <issue-number>
 *
 * Emits one line of JSON describing the reality-check verdict to stdout
 * and exits 0 on success. Exits 1 (with the error message on stderr) on
 * any gather/classify failure — fail-loud, so triage aborts.
 */

import { defaultRunner } from '../src/dispatcher/issue-source.js';
import { runTriageCheck } from '../src/triage/cli.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg == null || arg === '') {
    process.stderr.write('jinn-triage-check: missing <issue-number> argument\n');
    process.exit(2);
  }
  const n = Number.parseInt(arg, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== arg) {
    process.stderr.write(`jinn-triage-check: invalid issue number: ${arg}\n`);
    process.exit(2);
  }
  await runTriageCheck(n, defaultRunner, (s) => process.stdout.write(s));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`jinn-triage-check: ${msg}\n`);
  process.exit(1);
});
