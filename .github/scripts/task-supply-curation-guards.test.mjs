// Curation's package-specific contract, and only that.
//
// The tree-wide guards own everything a task-supply package shares: the package inventory and
// dependency graph (`task-supply-package-inventory`), the import boundary and the ambient-network
// and host-locale sweeps (`task-supply-source-boundaries`), and the packed-consumer canary
// (`task-supply-packed-types`). Curation is registered in all three; the duplicate inventory and
// boundary assertions that lived here while C6 was a branch off integration were removed when the
// branches merged.
//
// What stays here is what only curation can assert: that a PROJECTION never becomes a record. It
// has no clock, seals nothing, claims no record kind, mirrors upstream shapes it does not import,
// and never calls an observed pass rate a difficulty score.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const pkg = join(root, 'packages', 'task-supply', 'curation');

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

// Constraint 14: projection, never record.
test('no-record: nothing here seals, hashes, or claims a record kind', () => {
  const banned = [
    /\bseal[A-Z]/, /\bputArtifact\b/, /\bRECORD_KINDS\b/, /@noble\/hashes/,
    /\brecordKind\b/, /\bpayloadType\b/, /\bdssePreAuthEncoding\b/,
    // DR-2026-08-04: the re-seal moved every record kind to spec.jinn.network, but a
    // legacy-origin record kind is still a record kind -- the constraint is about the layer's
    // behavior (projection, never record), not about which origin spells the URI. Forbid a
    // record-kind path under either host so this guard still constrains something post-re-seal.
    /https:\/\/(?:spec\.)?jinn\.network\/records\//,
  ];
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${file} matches record-producing pattern ${pattern}`);
    }
  }
});

// Program §5 contract 5 + 12.
test('bounded language: an observed pass rate is never a difficulty score', () => {
  const banned = [
    /difficulty score/i, /task difficulty/i, /intrinsic difficulty/i,
    /how hard the task is/i, /objectively hard/i,
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

// Findings FC6-1/FC6-4: this package mirrors two upstream shapes it does not import.
test('drift: the mirrored upstream shapes still carry the fields this package assumes', () => {
  const item = readFileSync(join(root, 'packages/discovery/protocol/src/item.ts'), 'utf8');
  for (const field of ['announcementId', 'entry', 'source', 'agent', 'name', 'digest', 'kind']) {
    assert.ok(item.includes(field), `discovery AnnouncedItem/SourceIdentity lost "${field}"`);
  }
  const profile = JSON.parse(readFileSync(
    join(root, 'packages/discovery/facts/task-execution/profiles/delivery.v1.json'), 'utf8'));
  const names = profile.fields.map((f) => f.name);
  for (const field of ['taskDigest', 'attemptUri', 'benchrun']) {
    assert.ok(names.includes(field), `delivery facts profile lost "${field}"`);
  }
});

// Constraint 14, at the wire: the serialized envelope is not a record envelope.
test('serialization: the projection format token is not a record kind', () => {
  const text = readFileSync(join(pkg, 'src', 'serialize.ts'), 'utf8');
  assert.match(text, /CURATION_PROJECTION_FORMAT = "network\.jinn\.task-supply\.curation-projection\/1\.0"/);
  const golden = JSON.parse(readFileSync(join(pkg, 'fixtures', 'projection-golden.json'), 'utf8'));
  assert.deepEqual(Object.keys(golden).sort(), ['format', 'rows']);
  assert.ok(!String(golden.format).startsWith('https://jinn.network/records/'));
});

// Plan Finding FC6-8: at the C3+C6 merge these assertions fold into
// .github/scripts/task-supply-{package-inventory,source-boundaries,packed-types}.test.mjs and
// this workflow folds into task-supply-ci.yml as one more job. Until then this file is the
// curation package's only guard.
