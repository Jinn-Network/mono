// `@jinn-network/policy-identity`'s package-specific contract, and only that.
//
// The tree-wide guards own what every policy package shares: the inventory and dependency graph
// (`policy-package-inventory`), the import boundary and the ambient-network and host-locale sweeps
// (`policy-source-boundaries`), and the packed-consumer canary (`policy-packed-types`).
//
// What stays here is what only this package can assert: that it is PURE, that its documents are
// formats rather than record kinds, that its two implementations are both still wired, and that
// the requirements-merge semantics it reproduces have not drifted from the protocol package that
// owns them.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const pkg = join(root, 'packages', 'policy', 'identity');

// The published runtime surface, as `tsconfig.build.json` defines it. `src/fixtures.ts` (the
// fixture loader — the one place this package touches a filesystem) and `src/conformance.ts` (the
// kit's swap point) are test-time entries and are excluded there; they are excluded here for the
// same reason, and the list is re-derived from the build config so an exclusion cannot be widened
// without this guard seeing it.
const BUILD_EXCLUSIONS = ['src/**/*.test.ts', 'src/conformance.ts', 'src/fixtures.ts'];

function buildConfig() {
  // tsconfig.build.json carries comments, so it is read as JSONC.
  const text = readFileSync(join(pkg, 'tsconfig.build.json'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(text);
}

function productionSources() {
  const src = join(pkg, 'src');
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const rel = relative(pkg, full).split('\\').join('/');
      if (rel === 'src/conformance.ts' || rel === 'src/fixtures.ts') continue;
      out.push(full);
    }
  };
  walk(src);
  return out;
}

test('the build config still excludes exactly the two test-time entries this guard skips', () => {
  assert.deepEqual(buildConfig().exclude, BUILD_EXCLUSIONS,
    'the published runtime surface changed; re-derive the purity sweep before widening it');
});

test('custody: no clock, no network, no filesystem, and no randomness in production source', () => {
  const banned = [
    /\bDate\.now\b/, /\bnew Date\s*\(/, /\bperformance\.now\b/, /\bMath\.random\b/,
    /\bcrypto\.getRandomValues\b/, /\bfetch\s*\(/, /from\s+["']node:/,
    /\brequire\s*\(/, /\bprocess\.env\b/, /\bprocess\.argv\b/,
  ];
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${relative(root, file)} matches banned pattern ${pattern}`);
    }
  }
});

test('formats, never record kinds: the two tokens claim no tier-2 status', () => {
  const tokens = readFileSync(join(pkg, 'src', 'tokens.ts'), 'utf8');
  assert.match(tokens, /EXECUTION_TUPLE_FORMAT_TOKEN = "network\.jinn\.policy\.execution-tuple\/1\.0"/);
  assert.match(tokens, /CANDIDATE_MANIFEST_FORMAT_TOKEN = "network\.jinn\.policy\.candidate\/1\.0"/);
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /https:\/\/jinn\.network\/records\//,
      `${relative(root, file)} claims a record kind; substrate §2 says nothing here is one`);
  }
});

test('both conformance targets stay wired, and the reference is not deleted', () => {
  const implementation = readFileSync(join(pkg, 'src', 'conformance.ts'), 'utf8');
  assert.match(implementation, /from "\.\/index\.js"/,
    'the suite must gate the shipped implementation');
  assert.match(implementation, /CONFORMANCE_TARGET: "reference" \| "implementation" = "implementation"/);

  // Substrate §8 requires the derivation-equivalence fixture to be satisfied by two structurally
  // different implementations. The reference stays in the tree forever: deleting it would leave
  // the kit provable by only the code it gates, which proves nothing.
  const reference = readFileSync(join(pkg, 'fixtures', 'reference', 'conformance.ts'), 'utf8');
  assert.match(reference, /CONFORMANCE_TARGET: "reference" \| "implementation" = "reference"/);
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['test:conformance:reference'],
    'JINN_POLICY_CONFORMANCE=reference vitest run');
  assert.match(readFileSync(join(pkg, 'vitest.config.ts'), 'utf8'), /JINN_POLICY_CONFORMANCE/);
});

// FINDING F2 (package README): the core-axis comparison-class map was unpinned and the two shipped
// venues declare different maps. This package pins one; `src/merge.ts` reproduces protocol's merge
// rather than importing it, so both halves of that arrangement need a tripwire.
test('drift: the pinned class map still matches the marketplace map it cites', () => {
  const marketplace = readFileSync(
    join(root, 'packages', 'marketplace', 'binding', 'src', 'capabilities.ts'), 'utf8');
  const merge = readFileSync(join(pkg, 'src', 'merge.ts'), 'utf8');
  for (const [key, comparisonClass] of Object.entries({
    harness: 'constraint', model: 'constraint', loadout: 'addable', isolationPolicy: 'constraint',
  })) {
    assert.match(marketplace, new RegExp(`${key}:\\s*"${comparisonClass}"`),
      `the marketplace map no longer declares ${key} as ${comparisonClass}`);
    assert.match(merge, new RegExp(`${key}:\\s*"${comparisonClass}"`),
      `CORE_KEY_CLASSES no longer pins ${key} as ${comparisonClass}`);
  }
});

test("drift: protocol still registers a constraint-membership test for `model` and nothing else", () => {
  // F2's tripwire at the tree level. Today the two venues' maps disagree on three keys whose
  // class has no behavioral consequence, because `constraint` falls through to byte-equality for
  // every key with no registered membership test. The day another core key gains one, the maps
  // genuinely fork — and this fails on that day rather than after the populations have split.
  const membershipKeys = (source, where) => {
    const registry = /const CONSTRAINT_MEMBERSHIP\b[\s\S]*?=\s*\{([\s\S]*?)\}\s*;/.exec(source);
    assert.ok(registry, `${where} no longer declares CONSTRAINT_MEMBERSHIP as an object literal`);
    return [...registry[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((match) => match[1]);
  };
  assert.deepEqual(
    membershipKeys(
      readFileSync(join(root, 'packages', 'task-execution', 'protocol', 'src', 'requirements.ts'), 'utf8'),
      'protocol',
    ),
    ['model'],
  );
  assert.deepEqual(
    membershipKeys(readFileSync(join(pkg, 'src', 'merge.ts'), 'utf8'), 'policy-identity'),
    ['model'],
    'the reproduced membership registry drifted from protocol\'s',
  );
});

test("drift: the model-id provider prefix table matches protocol's, entry for entry", () => {
  // The one lookup table in the merge whose contents decide which Submissions have a tuple at all.
  // `merge-parity.test.ts` proves the three implementations agree on the cases it lists; this
  // proves the tables ARE the same table, so a seventh prefix added upstream is caught here rather
  // than by whichever fixture first happens to use that model family.
  const table = (source, where) => {
    const literal = /const MODEL_ID_PROVIDER_PREFIXES[^=]*=\s*(?:Object\.freeze\()?\{([\s\S]*?)\}\s*\)?\s*;/
      .exec(source);
    assert.ok(literal, `${where} no longer declares MODEL_ID_PROVIDER_PREFIXES as an object literal`);
    return [...literal[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)]
      .map((match) => `${match[1]} -> ${match[2]}`).sort();
  };
  const protocolTable = table(
    readFileSync(join(root, 'packages', 'task-execution', 'protocol', 'src', 'requirements.ts'), 'utf8'),
    'protocol',
  );
  assert.ok(protocolTable.length > 0, 'protocol declares an empty prefix table');
  assert.deepEqual(
    table(readFileSync(join(pkg, 'src', 'merge.ts'), 'utf8'), 'policy-identity'),
    protocolTable,
    "the reproduced prefix table drifted from protocol's",
  );
  assert.deepEqual(
    table(readFileSync(join(pkg, 'fixtures', 'reference', 'merge.ts'), 'utf8'), 'the kit reference'),
    protocolTable,
    "the kit reference's prefix table drifted from protocol's",
  );
});

test('drift: the effort ordinals this package reproduces still match protocol', () => {
  const common = readFileSync(
    join(root, 'packages', 'task-execution', 'protocol', 'src', 'schemas', 'common.ts'), 'utf8');
  const tiers = /EFFORT_TIERS = \[([^\]]*)\]/.exec(common);
  assert.ok(tiers, 'protocol no longer declares EFFORT_TIERS as an array literal');
  const merge = /EFFORT_TIERS = \[([^\]]*)\]/.exec(readFileSync(join(pkg, 'src', 'merge.ts'), 'utf8'));
  assert.ok(merge, 'policy-identity no longer declares EFFORT_TIERS as an array literal');
  const normalize = (text) => text.split(',').map((entry) => entry.trim()).filter(Boolean);
  assert.deepEqual(normalize(merge[1]), normalize(tiers[1]));
});

test('bounded language: nothing here claims to verify what actually ran', () => {
  // Substrate §4.1: a tuple digest names the REQUESTED treatment. This package verifies nothing
  // about execution, and its prose may not imply otherwise — the weakest-axis rule is the
  // consumer's to apply, and it can only be applied if the disclosure stays honest.
  const banned = [
    /verified execution/i, /proves what ran/i, /guarantees the (?:harness|model|loadout)/i,
    /tamper-proof/i, /trustless/i,
  ];
  const files = [...productionSources(), join(pkg, 'README.md')];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${relative(root, file)} overclaims: ${pattern}`);
    }
  }
});
