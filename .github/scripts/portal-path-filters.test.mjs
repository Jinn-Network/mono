// Gate for #3573: no CI lane may select on a workspace while ignoring a tree
// that workspace builds from source through a `portal:` dependency.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  LANES,
  auditLane,
  auditLanes,
  describeGap,
  erePrefix,
  globPrefix,
  laneSelectedPrefixes,
  overlaps,
  parseShellArray,
  parseWorkflowPaths,
  portalClosure,
  readWorkspaceGraph,
} from './portal-path-filters.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

test('every lane selects on the portal closure of the workspaces it selects on', () => {
  const gaps = auditLanes(repoRoot).filter((audit) => audit.missing.length > 0);
  assert.deepEqual(
    gaps.map(({ id }) => id),
    [],
    gaps.map(describeGap).join('\n\n'),
  );
});

test('every lane in the registry names a real workflow and selects on something', () => {
  for (const lane of LANES) {
    const prefixes = laneSelectedPrefixes(repoRoot, lane);
    assert.ok(prefixes.length > 0, `${lane.workflow} exposes no directory selection to audit`);
  }
});

test('every lane in the registry selects on at least one workspace', () => {
  // A lane whose selection matched no workspace would pass the closure gate
  // vacuously — that is the failure this whole module exists to prevent.
  const graph = readWorkspaceGraph(repoRoot);
  for (const lane of LANES) {
    const { selected } = auditLane({ root: repoRoot, graph, lane });
    assert.ok(selected.length > 0, `${lane.workflow} selects on no workspace`);
  }
});

test('the workspace graph records portal edges from every manifest field', () => {
  const graph = readWorkspaceGraph(repoRoot);
  // `resolutions` carries most of this repository's portal edges; `operator`
  // declares its trust edges there and nowhere else.
  assert.ok(graph.get('operator').includes('packages/trust/core'));
  assert.ok(graph.get('packages/marketplace/binding').includes('packages/trust/core'));
  assert.equal(graph.has(''), false, 'the repository root must never be a workspace');
});

test('portalClosure is transitive and excludes the workspace itself', () => {
  const graph = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', []],
  ]);
  assert.deepEqual([...portalClosure(graph, 'a')].sort(), ['b', 'c']);
  assert.deepEqual([...portalClosure(graph, 'c')], []);
});

test('portalClosure terminates on a cycle', () => {
  const graph = new Map([
    ['a', ['b']],
    ['b', ['a']],
  ]);
  assert.deepEqual([...portalClosure(graph, 'a')].sort(), ['b']);
});

test('overlaps matches a tree in either direction and nothing else', () => {
  assert.equal(overlaps('packages/trust', 'packages/trust/core'), true);
  assert.equal(overlaps('operator/src', 'operator'), true);
  assert.equal(overlaps('operator', 'operator'), true);
  assert.equal(overlaps('operator-console', 'operator'), false);
  assert.equal(overlaps('packages/trust/core', 'packages/trust/resolve'), false);
  assert.equal(overlaps('', 'operator'), false);
});

test('globPrefix keeps the literal head of a glob', () => {
  assert.equal(globPrefix('packages/trust/**'), 'packages/trust');
  assert.equal(globPrefix('.github/workflows/trust-ci.yml'), '.github/workflows/trust-ci.yml');
  assert.equal(globPrefix('packages/*/src/**'), 'packages');
  assert.equal(globPrefix('**'), null);
});

test('erePrefix accepts an anchored directory prefix and rejects a file pattern', () => {
  assert.equal(erePrefix('^operator/'), 'operator');
  assert.equal(erePrefix('^packages/trust/core/'), 'packages/trust/core');
  assert.equal(erePrefix('^\\.github/workflows/'), '.github/workflows');
  // Manifests-only by design in ci.yml; treating it as tree coverage would make
  // every package look selected and silence the gate everywhere.
  assert.equal(erePrefix('^packages/.*/package\\.json$'), null);
  assert.equal(erePrefix('^\\.github/workflows/ci\\.yml$'), null);
});

test('parseWorkflowPaths reads every paths block and tolerates comments', () => {
  const source = [
    'on:',
    '  pull_request:',
    '    paths:',
    '      - "packages/trust/**"',
    '      # a comment does not end the block',
    '      - "packages/evidence/protocol/**"',
    '  push:',
    '    paths:',
    '      - "operator/**"',
    '',
    'jobs:',
    '  build:',
    '    steps: []',
  ].join('\n');
  assert.deepEqual(parseWorkflowPaths(source), [
    'packages/trust/**',
    'packages/evidence/protocol/**',
    'operator/**',
  ]);
});

test('parseWorkflowPaths stops at the end of a block', () => {
  const source = ['    paths:', '      - "a/**"', '    branches: [next]', '      - "b/**"'].join('\n');
  assert.deepEqual(parseWorkflowPaths(source), ['a/**']);
});

test('parseShellArray reads entries up to the closing paren and skips comments', () => {
  const source = [
    '          patterns=(',
    "            '^operator/'",
    "            # a lane's comment must not swallow the next quote",
    "            '^packages/core/'",
    '          )',
    "          other=( '^nope/' )",
  ].join('\n');
  assert.deepEqual(parseShellArray(source, 'patterns'), ['^operator/', '^packages/core/']);
});

test('parseShellArray fails loudly on a missing or unterminated array', () => {
  assert.throws(() => parseShellArray('nothing here', 'patterns'), /missing shell array/u);
  assert.throws(() => parseShellArray("patterns=(\n  '^a/'\n", 'patterns'), /unterminated shell array/u);
});

test('auditLane reports a portal target the lane does not select on', () => {
  const root = mkdtempSync(join(tmpdir(), 'portal-path-filters-'));
  try {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, 'consumer'), { recursive: true });
    mkdirSync(join(root, 'packages/dep'), { recursive: true });
    writeFileSync(
      join(root, 'consumer/package.json'),
      JSON.stringify({ name: 'consumer', resolutions: { dep: 'portal:../packages/dep' } }),
    );
    writeFileSync(join(root, 'packages/dep/package.json'), JSON.stringify({ name: 'dep' }));
    writeFileSync(
      join(root, '.github/workflows/stub.yml'),
      ['on:', '  pull_request:', '    paths:', '      - "consumer/**"', ''].join('\n'),
    );
    const lane = {
      id: 'stub',
      workflow: '.github/workflows/stub.yml',
      dialect: 'workflow-paths',
      required: (workspace) => `"${workspace}/**"`,
    };
    const graph = readWorkspaceGraph(root);
    const audit = auditLane({ root, graph, lane });
    assert.deepEqual(audit.selected, ['consumer']);
    assert.deepEqual(audit.missing, ['packages/dep']);
    assert.match(describeGap({ ...audit, id: LANES[0].id }), /packages\/dep/u);

    // Selecting on the dependency closes the gap; nothing else changes.
    writeFileSync(
      join(root, '.github/workflows/stub.yml'),
      ['on:', '  pull_request:', '    paths:', '      - "consumer/**"', '      - "packages/dep/**"', ''].join('\n'),
    );
    assert.deepEqual(auditLane({ root, graph, lane }).missing, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
