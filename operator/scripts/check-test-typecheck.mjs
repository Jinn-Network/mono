#!/usr/bin/env node
// Typecheck the test tree (issue #2665).
//
// `yarn typecheck` compiles tsconfig.json, which excludes `test/` and `scripts/`. Nothing
// type-checked them, and two defects survived a green required gate because of it: an `as never`
// cast papering over a broken port contract, and calls passing 6 positional arguments to
// 7-to-9-required-argument functions (`claimTask`, `callDeliverToMarketplace`, `claimDelivery`),
// which silently shifted every argument one place left.
//
// tsconfig.test.json does not compile clean today, so this is a RATCHET rather than a
// zero-error gate: `test-typecheck-baseline.json` records the known error count per file, and
// the check fails when any file gains errors or a previously clean file starts producing them.
// It also fails when a count DROPS -- an unrecorded improvement rots the baseline, so the fix is
// to re-record it. Regenerate with `yarn typecheck:test --update`.
//
// The goal is not a clean tree; it is that the defect class above can never be introduced again
// without turning a required check red.
//
// The `typecheck:test` script builds `@jinn-network/jinn-layer` before invoking this file.
// `yarn typecheck` builds sdk/stack/plugin/core but not layer, so without that step the recorded
// counts would depend on whether some earlier command happened to have built it -- 12 errors
// appear and disappear with it. A ratchet whose baseline moves with the environment is worse
// than no ratchet, so the build is part of the check.
//
// The converse — running this alone on a tree where `yarn typecheck` has NOT built the other four
// portals — is caught up front by `findUnbuiltPortalPackages` (issue #3734) rather than reported
// as several hundred spurious regressions.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnbuiltPortalPackages, formatUnbuiltPortalsMessage } from './lib/unbuilt-portals.mjs';

const operatorDir = dirname(dirname(fileURLToPath(import.meta.url)));
const baselinePath = join(operatorDir, 'test-typecheck-baseline.json');
const update = process.argv.includes('--update');

// Before `--update` too: recording a baseline from an unbuilt tree is exactly the rot this
// ratchet's drop-detection exists to catch, and it would land in the repository.
const unbuilt = findUnbuiltPortalPackages(operatorDir);
if (unbuilt.length > 0) {
  console.error(formatUnbuiltPortalsMessage(unbuilt));
  process.exit(1);
}

const tsc = spawnSync(
  process.execPath,
  [join(operatorDir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.test.json'],
  { cwd: operatorDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

if (tsc.error) {
  console.error(`typecheck:test could not run tsc: ${tsc.error.message}`);
  process.exit(1);
}

// Diagnostic lines look like `path/to/file.ts(12,34): error TS2345: ...`. Continuation lines of a
// multi-line diagnostic are indented, so anchoring at column 0 counts each diagnostic once.
const DIAGNOSTIC = /^(\S[^(]*)\(\d+,\d+\): error TS\d+:/u;
const counts = {};
for (const line of `${tsc.stdout ?? ''}\n${tsc.stderr ?? ''}`.split('\n')) {
  const match = DIAGNOSTIC.exec(line);
  if (match === null) continue;
  const file = match[1].replaceAll('\\', '/');
  counts[file] = (counts[file] ?? 0) + 1;
}

const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
const total = Object.values(sorted).reduce((sum, n) => sum + n, 0);

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  console.log(`typecheck:test baseline updated — ${total} error(s) across ${Object.keys(sorted).length} file(s).`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (error) {
  console.error(`typecheck:test cannot read ${baselinePath}: ${error.message}`);
  process.exit(1);
}

const regressions = [];
const improvements = [];
for (const file of new Set([...Object.keys(baseline), ...Object.keys(sorted)])) {
  const was = baseline[file] ?? 0;
  const now = sorted[file] ?? 0;
  if (now > was) regressions.push(`  ${file}: ${was} → ${now}`);
  else if (now < was) improvements.push(`  ${file}: ${was} → ${now}`);
}

if (regressions.length > 0) {
  console.error('typecheck:test FAILED — new type errors in the test tree:\n');
  console.error(regressions.join('\n'));
  console.error('\nFull tsc output:\n');
  console.error(tsc.stdout ?? '');
  process.exit(1);
}

if (improvements.length > 0) {
  console.error('typecheck:test FAILED — the baseline is stale (errors were fixed but not re-recorded):\n');
  console.error(improvements.join('\n'));
  console.error('\nRun `yarn typecheck:test --update` and commit test-typecheck-baseline.json.');
  process.exit(1);
}

console.log(`typecheck:test OK — ${total} known error(s) across ${Object.keys(sorted).length} file(s), no regression.`);
