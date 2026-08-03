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
      source: 'operator health diagnostics',
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
  })] }), { repoRoot }), []);
  const errors = validateTransitionManifest(manifest({ transitions: [transition({
    consumers: [],
  })] }), { repoRoot });
  assert.ok(errors.some((error) => error.includes('must be non-empty until the transition is deleted')));
});

test('the repository Phase D manifest validates as the machine-readable deletion authority', () => {
  const actual = JSON.parse(readFileSync(
    resolve(repoRoot, 'architecture/transitions/phase-d-native-operator.v1.json'),
    'utf8',
  ));
  assert.deepEqual(validateTransitionManifest(actual, { repoRoot }), []);
  assert.equal(actual.transitions.length, 7);
});
