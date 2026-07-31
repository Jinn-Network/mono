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

test('inventory: standalone leaf with zero Jinn dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@jinn-network/task-curation');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.packageManager, 'yarn@4.13.0');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['zod']);
  assert.equal(manifest.resolutions, undefined, 'a portal resolution means a Jinn dependency crept in');
  for (const bag of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[bag] ?? {})) {
      assert.ok(!name.startsWith('@jinn-network/'), `${bag} must not name ${name}`);
    }
  }
  assert.ok(existsSync(join(pkg, 'yarn.lock')), 'standalone yarn project needs its own lockfile');
  assert.equal(readFileSync(join(pkg, '.yarnrc.yml'), 'utf8').trim(), 'nodeLinker: node-modules');
});

// Constraints 4 + 15: pure projector. `Date.parse` is the one allowlisted time primitive.
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
    /https:\/\/jinn\.network\/records\//,
  ];
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${file} matches record-producing pattern ${pattern}`);
    }
  }
});

// Program §5 contract 5 + 12.
test('boundaries: no legacy or product-tier imports', () => {
  const banned = [
    /@jinn-network\/core\b/, /@jinn-network\/plugin\b/, /@jinn-network\/jinn-layer\b/,
    /from\s+["'][^"']*\/client\/src\//,
  ];
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${file} matches banned import ${pattern}`);
    }
  }
});

// Constraint 18: bounded language.
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
    join(root, 'packages/discovery/facts/task-execution/profiles/delivery.1.0.json'), 'utf8'));
  const names = profile.fields.map((f) => f.name);
  for (const field of ['taskDigest', 'attemptUri', 'benchrun']) {
    assert.ok(names.includes(field), `delivery facts profile lost "${field}"`);
  }
});
