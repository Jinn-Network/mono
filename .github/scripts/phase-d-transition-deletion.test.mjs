import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import { loadAndValidateTransitionManifest } from './transition-manifest.mjs';

const root = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(root, 'architecture/transitions/phase-d-native-operator.v1.json');
const manifest = loadAndValidateTransitionManifest(manifestPath, { repoRoot: root });

const EXPECTED_TRANSITIONS = [
  'direct-public-posttask-composition',
  'legacy-evaluator-delivery-watcher',
  'legacy-operator-composition',
  'legacy-task-submission-synthesis',
  'legacy-taskengine-carve',
  'legacy-wiring-config',
  'marketplace-pipeline',
];

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      return sourceFiles(path);
    }
    return ['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extname(entry.name)) ? [path] : [];
  });
}

function transition(id) {
  const value = manifest.transitions.find((candidate) => candidate.id === id);
  assert.ok(value, `missing transition ${id}`);
  return value;
}

function deleted(id) {
  return transition(id).status === 'deleted';
}

function containing(files, needle) {
  return files
    .filter((path) => readFileSync(path, 'utf8').includes(needle))
    .map((path) => relative(root, path))
    .sort();
}

test('the Phase D manifest is complete, path-valid, and keeps the Phase C default legacy', () => {
  assert.equal(manifest.defaultPolicy.includes('remains legacy'), true);
  assert.deepEqual(manifest.transitions.map(({ id }) => id).sort(), EXPECTED_TRANSITIONS);
  for (const transition of manifest.transitions) {
    assert.equal(statSync(resolve(root, transition.noNewUseGuard.path)).isFile(), true);
    assert.equal(statSync(resolve(root, transition.deletionTest.path)).isFile(), true);
    assert.equal(transition.deletionTest.command, 'node --test .github/scripts/phase-d-transition-deletion.test.mjs');
  }
});

test('operator mode stays explicit and absent configuration still resolves to legacy', () => {
  const mode = readFileSync(resolve(root, 'client/src/daemon/native-vertical-mode.ts'), 'utf8');
  const daemon = readFileSync(resolve(root, 'client/src/daemon/daemon.ts'), 'utf8');
  if (deleted('legacy-operator-composition')) {
    assert.doesNotMatch(mode, /requestedMode === undefined[\s\S]*effectiveMode: 'legacy'/u);
    assert.doesNotMatch(daemon, /config\.verticalMode \?\? 'legacy'/u);
  } else {
    assert.match(mode, /requestedMode === undefined[\s\S]*effectiveMode: 'legacy'/u);
    assert.match(mode, /requestedMode === 'legacy'[\s\S]*effectiveMode: 'legacy'/u);
    assert.match(daemon, /config\.verticalMode \?\? 'legacy'/u);
    assert.match(daemon, /native-v1 daemon refuses legacy restoration engine or compatibility composition/u);
  }
});

test('marketplace-pipeline remains confined to the frozen legacy client inventory', () => {
  const consumers = containing(
    sourceFiles(resolve(root, 'client/src')),
    '@jinn-network/marketplace-pipeline',
  );
  if (deleted('marketplace-pipeline')) {
    assert.deepEqual(consumers, []);
    assert.equal(existsSync(resolve(root, 'packages/marketplace/pipeline')), false);
  } else {
    assert.deepEqual(consumers, [
      'client/src/config/shape-v2.ts',
      'client/src/daemon/composition-root.ts',
      'client/src/daemon/engagement-ledger.ts',
      'client/src/daemon/work-loop.ts',
    ]);
  }
});

test('legacy synthesis stays visibly legacy and confined to its declared bridge files', () => {
  const paths = transition('legacy-task-submission-synthesis').entryPoints
    .map((path) => resolve(root, path));
  if (deleted('legacy-task-submission-synthesis')) {
    assert.equal(paths.some(existsSync), false);
  } else {
    const bridge = readFileSync(paths[0], 'utf8');
    const projector = readFileSync(paths[1], 'utf8');
    assert.match(bridge, /derivationKind: 'legacy'/u);
    assert.match(projector, /synthesizeLegacyTaskProjection/u);
  }
});

test('legacy evaluator watcher and wiring diagnostics match their transition status', () => {
  const watcher = resolve(root, 'client/src/daemon/delivery-watcher.ts');
  if (deleted('legacy-evaluator-delivery-watcher')) assert.equal(existsSync(watcher), false);
  else assert.equal(existsSync(watcher), true);

  const config = readFileSync(resolve(root, 'client/src/config.ts'), 'utf8');
  if (deleted('legacy-wiring-config')) {
    assert.doesNotMatch(config, /legacy-wiring-config-field/u);
  } else {
    assert.match(config, /recordPhaseDTransitionUse\('legacy-wiring-config-field'\)/u);
    assert.match(config, /parsed\.executionWiring/u);
  }
});

test('TaskEngine carve is present only while its transition remains active', () => {
  const pipelineRoot = resolve(root, 'packages/marketplace/pipeline');
  const references = containing(sourceFiles(pipelineRoot), 'TASK_ENGINE_CARVE');
  if (deleted('legacy-taskengine-carve')) assert.deepEqual(references, []);
  else assert.ok(references.length > 0);
});

test('marketplace-binding is the only capability package that composes its low-level postTask primitive', () => {
  const capabilityFiles = [
    ...sourceFiles(resolve(root, 'packages/task-supply/posting/src')),
    ...sourceFiles(resolve(root, 'packages/benchmarking/marketplace/src')),
    ...sourceFiles(resolve(root, 'client/src/native-requester')),
    ...sourceFiles(resolve(root, 'client/src/daemon')),
  ];
  const imports = capabilityFiles.flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    return source.includes('@jinn-network/marketplace-binding') && /\bpostTask\b/u.test(source)
      ? [relative(root, path)]
      : [];
  });
  assert.deepEqual(imports, [], 'products must use MarketplaceRequesterBackend.post or TaskExecutionBackend.submit');
  assert.deepEqual(transition('direct-public-posttask-composition').consumers, []);
  assert.equal(transition('direct-public-posttask-composition').status, 'deleted');
});
