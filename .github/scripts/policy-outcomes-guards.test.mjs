// policy-outcomes's package-specific contract, and only that.
//
// The tree-wide guards own everything a `packages/policy` package shares: the package inventory
// and dependency graph (`policy-package-inventory`), the import boundary and the ambient-network
// and host-locale sweeps (`policy-source-boundaries`), and the packed-consumer canary
// (`policy-packed-types`). policy-outcomes is registered in all three.
//
// What stays here is what only policy-outcomes can assert: that a PROJECTION never becomes a
// record. It has no clock, seals nothing, claims no record kind, mirrors upstream shapes it does
// not import, and never calls an observed pass rate a policy-quality verdict (program §1 C2;
// substrate §6.2 -- "no thresholds in-package").
//
// Mirrors `.github/scripts/task-supply-curation-guards.test.mjs` (C6 precedent) file-for-file in
// discipline, transposed to the policy-outcomes package (program §1 C2 "Template").

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const pkg = join(root, 'packages', 'policy', 'outcomes');

function productionSources() {
  const src = join(pkg, 'src');
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(src);
  return out;
}

test('custody: no ambient authority and no clock in production source', () => {
  const banned = [
    /\bDate\.now\b/, /\bnew Date\s*\(\s*\)/, /\bperformance\.now\b/, /\bMath\.random\b/,
    /\bfetch\s*\(/, /from\s+["']node:(fs|net|http|https|dns|child_process|crypto)/,
    /\brequire\s*\(/, /\bprocess\.env\b/,
  ];
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${file} matches banned pattern ${pattern}`);
    }
  }
});

// Substrate §6.2: projection, never record.
test('no-record: nothing here seals, hashes an on-chain identity, or claims a record kind', () => {
  const banned = [
    /\bsealCandidateManifest\b/, /\bputArtifact\b/, /\bRECORD_KINDS\b/,
    /\brecordKind\b/, /\bpayloadType\b/, /\bdssePreAuthEncoding\b/,
    /https:\/\/jinn\.network\/records\//,
  ];
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${file} matches record-producing pattern ${pattern}`);
    }
  }
});

// Substrate §6.2: "no thresholds in-package" -- an observed pass rate is never a policy verdict.
test('bounded language: an observed pass rate is never a policy-quality verdict', () => {
  const banned = [
    /policy quality/i, /policy is (good|bad|better|worse)/i, /good enough fidelity/i,
    /objectively (better|worse)/i, /this policy (wins|loses)/i,
  ];
  const files = [...productionSources()];
  const readme = join(pkg, 'README.md');
  if (existsSync(readme)) files.push(readme);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${file} uses unbounded language: ${pattern}`);
    }
  }
});

// Finding F-C2-1 / F6.1: `formatToken` is document metadata, never an axis on a row.
test('axes never carry formatToken (design finding F4/F-C2-1)', () => {
  const golden = JSON.parse(readFileSync(join(pkg, 'fixtures', 'projection-golden.json'), 'utf8'));
  for (const row of golden.rows) {
    assert.ok(!Object.hasOwn(row.axes, 'formatToken'), 'a row axes object carries formatToken');
  }
});

// Constraint: the serialized envelope is not a record envelope.
test('serialization: the projection format token is not a record kind', () => {
  const text = readFileSync(join(pkg, 'src', 'serialize.ts'), 'utf8');
  assert.match(text, /POLICY_OUTCOMES_PROJECTION_FORMAT = "network\.jinn\.policy\.outcomes-projection\/1\.0"/);
  const golden = JSON.parse(readFileSync(join(pkg, 'fixtures', 'projection-golden.json'), 'utf8'));
  assert.deepEqual(Object.keys(golden).sort(), ['format', 'rows']);
  assert.ok(!String(golden.format).startsWith('https://jinn.network/records/'));
});

// Substrate §7: each axis's pinning counters sum to the row's verdicts -- checked at the fixture
// level too, so a drift in the golden fixture itself would be caught here independent of the unit
// tests exercising the same invariant on stored-state parsing.
test('pinning invariant: every axis\'s match+mismatch+unverifiable sums to verdicts', () => {
  const golden = JSON.parse(readFileSync(join(pkg, 'fixtures', 'projection-golden.json'), 'utf8'));
  for (const row of golden.rows) {
    for (const axis of ['harness', 'model', 'loadout', 'isolationPolicy']) {
      const counts = row.pinning[axis];
      const sum = counts.match + counts.mismatch + counts.unverifiable;
      assert.equal(sum, row.verdicts, `${axis} pinning counters do not sum to verdicts`);
    }
  }
});
