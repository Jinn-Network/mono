import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { validateTransitionManifest } from './transition-manifest.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

function transition(overrides = {}) {
  return {
    id: 'legacy-marketplace-pipeline',
    owner: 'architecture-control',
    entryPoints: ['packages/marketplace/pipeline/src/index.ts'],
    replacement: 'Native tier-4 policy plus marketplace binding and task-execution backend',
    consumers: ['legacy operator work loop'],
    defaultMode: 'legacy',
    noNewUseGuard: {
      path: '.github/scripts/marketplace-source-boundaries.test.mjs',
      assertion: 'Only the frozen legacy client import allowlist may import the package.',
    },
    usageSignal: {
      name: 'marketplace_pipeline_invocations',
      sourceFile: null,
      sourceDescription: 'operator health diagnostics',
      zeroDefinition: 'No production invocation during the approved observation window.',
    },
    migration: {
      description: 'Use native policy and neutral backend capabilities.',
      compatibility: 'Legacy behavior remains frozen until deletion.',
    },
    sunsetCondition: {
      description: 'Native is the proven default and legacy use is zero.',
      evidence: ['exact-head live closure receipt', 'zero-use observation'],
    },
    deletionTest: {
      path: '.github/scripts/marketplace-source-boundaries.test.mjs',
      command: 'node --test .github/scripts/marketplace-source-boundaries.test.mjs',
    },
    targetPullRequest: 'Phase D2',
    status: 'planned',
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    phase: 'phase-d-native-operator',
    defaultPolicy: 'legacy until exact-head closure and measured zero use',
    transitions: [transition()],
    ...overrides,
  };
}

test('transition schema is closed and requires every Phase D deletion input', () => {
  const schema = JSON.parse(readFileSync(
    resolve(repoRoot, 'architecture/transitions/transition-manifest.schema.json'),
    'utf8',
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.transition.additionalProperties, false);
  assert.deepEqual(schema.$defs.transition.required, [
    'id', 'owner', 'entryPoints', 'replacement', 'consumers', 'defaultMode', 'noNewUseGuard',
    'usageSignal', 'migration', 'sunsetCondition', 'deletionTest', 'targetPullRequest', 'status',
  ]);
  assert.deepEqual(validateTransitionManifest(manifest(), { repoRoot }), []);
});

test('validator rejects unknown fields and incomplete transitions', () => {
  const incomplete = transition({ surprise: true });
  delete incomplete.owner;
  const errors = validateTransitionManifest(manifest({ transitions: [incomplete] }), { repoRoot });
  assert.ok(errors.some((error) => error.includes('missing required field owner')));
  assert.ok(errors.some((error) => error.includes('unknown field surprise')));
});

test('validator rejects duplicate ids, invalid modes, and non-repository guard paths', () => {
  const errors = validateTransitionManifest(manifest({
    transitions: [
      transition({ defaultMode: 'automatic' }),
      transition({ noNewUseGuard: { path: '../escape.mjs', assertion: 'bad' } }),
    ],
  }), { repoRoot });
  assert.ok(errors.some((error) => error.includes('defaultMode is invalid')));
  assert.ok(errors.some((error) => error.includes('duplicates legacy-marketplace-pipeline')));
  assert.ok(errors.some((error) => error.includes('normalized repository-relative path')));
});

test('only deleted transitions may have an empty consumer inventory', () => {
  assert.deepEqual(validateTransitionManifest(manifest({ transitions: [transition({
    status: 'deleted',
    consumers: [],
    evidenceCitation: 'log/decisions/2026-08-04-legacy-taskengine-carve-archival.md',
  })] }), { repoRoot }), []);
  const errors = validateTransitionManifest(manifest({ transitions: [transition({
    consumers: [],
  })] }), { repoRoot });
  assert.ok(errors.some((error) => error.includes('must be non-empty until the transition is deleted')));
});

test('a deleted transition must cite Class A evidence (spec §7 human-gate rule)', () => {
  const missing = validateTransitionManifest(manifest({ transitions: [transition({
    status: 'deleted',
    consumers: [],
  })] }), { repoRoot });
  assert.ok(missing.some((error) => error.includes('evidenceCitation must be a non-empty string')));

  const nonExistent = validateTransitionManifest(manifest({ transitions: [transition({
    status: 'deleted',
    consumers: [],
    evidenceCitation: 'log/decisions/does-not-exist.md',
  })] }), { repoRoot });
  assert.ok(nonExistent.some((error) => error.includes('evidenceCitation does not exist')));

  const cited = validateTransitionManifest(manifest({ transitions: [transition({
    status: 'deleted',
    consumers: [],
    evidenceCitation: 'log/decisions/2026-08-04-legacy-taskengine-carve-archival.md',
  })] }), { repoRoot });
  assert.deepEqual(cited, []);
});

test('evidenceCitation is only allowed on a deleted transition', () => {
  const errors = validateTransitionManifest(manifest({ transitions: [transition({
    evidenceCitation: 'log/decisions/2026-08-04-legacy-taskengine-carve-archival.md',
  })] }), { repoRoot });
  assert.ok(errors.some((error) => error.includes("evidenceCitation is only allowed when status is 'deleted'")));
});

test('evidenceCitation must be Class A (a decision record or spec), not merely a path that resolves', () => {
  // Proof by construction: a resolving path outside log/decisions/ or docs/superpowers/specs/ is
  // not Class A evidence — in particular, citing the Class O reader itself (the counters that may
  // have informed the decision) must never pass as the cited basis.
  const errors = validateTransitionManifest(manifest({ transitions: [transition({
    status: 'deleted',
    consumers: [],
    evidenceCitation: 'operator/src/compatibility/phase-d-transition-usage.ts',
  })] }), { repoRoot });
  assert.ok(errors.some((error) => error.includes('evidenceCitation must live under')));

  // A random top-level document that resolves is also not Class A evidence.
  const arbitrary = validateTransitionManifest(manifest({ transitions: [transition({
    status: 'deleted',
    consumers: [],
    evidenceCitation: 'PRINCIPLES.md',
  })] }), { repoRoot });
  assert.ok(arbitrary.some((error) => error.includes('evidenceCitation must live under')));
});

test('evidenceCitation rejects a bare directory (N1)', () => {
  // A directory path that lives under an allowed evidence root and resolves via existsSync would
  // otherwise pass every earlier check while citing nothing in particular — a citation must name
  // one document, not gesture at a directory of them.
  const errors = validateTransitionManifest(manifest({ transitions: [transition({
    status: 'deleted',
    consumers: [],
    evidenceCitation: 'log/decisions/',
  })] }), { repoRoot });
  assert.ok(errors.some((error) => error.includes('must be a file')));
});

test('evidenceCitation must not equal a usageSignal.sourceFile declared anywhere in the manifest', () => {
  // A spec document doubling as some transition's usageSignal.sourceFile is exactly the
  // Class-O-cited-as-Class-A failure mode the rule exists to catch, even though the path itself
  // sits under an allowed evidence root and resolves.
  const sharedPath = 'docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md';
  const errors = validateTransitionManifest(manifest({
    transitions: [
      transition({
        id: 'legacy-marketplace-pipeline',
        usageSignal: {
          name: 'marketplace_pipeline_invocations',
          sourceFile: sharedPath,
          sourceDescription: 'stand-in for test purposes',
          zeroDefinition: 'No production invocation during the approved observation window.',
        },
      }),
      transition({
        id: 'legacy-taskengine-carve',
        status: 'deleted',
        consumers: [],
        evidenceCitation: sharedPath,
      }),
    ],
  }), { repoRoot });
  assert.ok(errors.some((error) => error.includes('must not equal a declared usageSignal.sourceFile')));
});

test('validator rejects a usageSignal file reference that does not exist in the repository', () => {
  const errors = validateTransitionManifest(manifest({
    transitions: [transition({
      usageSignal: {
        name: 'marketplace_pipeline_invocations',
        sourceFile: 'operator/src/daemon/phase-d-transition-usage.ts',
        sourceDescription: 'durable counter exposed by GET /v1/status',
        zeroDefinition: 'No production invocation during the approved observation window.',
      },
    })],
  }), { repoRoot });
  assert.ok(errors.some((error) => error.includes('usageSignal.sourceFile does not exist')));
});

test('the repository Phase D manifest validates as the machine-readable deletion authority', () => {
  const actual = JSON.parse(readFileSync(
    resolve(repoRoot, 'architecture/transitions/phase-d-native-operator.v1.json'),
    'utf8',
  ));
  assert.deepEqual(validateTransitionManifest(actual, { repoRoot }), []);
  assert.equal(actual.transitions.length, 8);
});
