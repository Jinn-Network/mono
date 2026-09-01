// SPDX-License-Identifier: Apache-2.0
//
// Several workflows restore each distribution by name and carry a comment
// citing a sibling workflow as precedent for that shape. A citation that
// outlives the shape it names is worse than no citation: it reads as settled
// while pointing at a workflow that no longer restores anything. That is
// exactly what happened to `marketplace-ci.yml`, cited by `plugin-tree-ci.yml`
// until #2997 consolidated its jobs and removed every artifact hand-off.
//
// The check used to live inside `policy-ci-workflow.test.mjs` and
// `plugin-tree-ci-workflow.test.mjs`, each gated behind its own workflow's
// `paths:` filter — so the pull request that removed a cited workflow's
// restores never ran the gate, and it fired later against an unrelated author.
// The invariant is repository-wide, so the gate lives here, under Repository
// structure, which runs on every pull request with no path filtering. The
// citation shape itself lives in `workflow-precedent-citations.mjs`, a plain
// module, so the per-workflow marker guards can share the parser without
// importing this file and dragging the repository-wide gate back behind their
// `paths:` filters. The restore-name walk those citations are checked against
// lives in `workflow-artifact-steps.mjs`, the one copy this file's first test
// keeps unique.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { restoredArtifactNames } from './workflow-artifact-steps.mjs';
import { citedPrecedents, findBrokenCitations } from './workflow-precedent-citations.mjs';

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = resolve(root, '.github/workflows');
const scriptsDir = resolve(root, '.github/scripts');

// The acceptance criterion of #3131: one behaviour of the restore-name walk in
// `.github/scripts`. Copies drift — #3127 fixed this file's walk while the two
// per-workflow tests kept the pre-fix one, so a `pattern:` restore at the end of
// a job still read the next job's `name:` there.
test('the restore-name walk is defined once, in the shared module', () => {
  const definers = readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.mjs') && name !== 'workflow-artifact-steps.mjs')
    .filter((name) => /(?:function\s+|const\s+|let\s+)restoredArtifacts?(?:Names)?\s*[=(]/.test(
      readFileSync(join(scriptsDir, name), 'utf8'),
    ));
  assert.deepEqual(
    definers,
    [],
    'import restoredArtifacts / restoredArtifactNames from workflow-artifact-steps.mjs instead of redefining the walk',
  );
});

test('every workflow cited as by-name precedent actually restores by name', () => {
  assert.deepEqual(findBrokenCitations(), []);
});

test('a citation is only read from the comment attached to a restore step', () => {
  const source = [
    '      # Precedent: marketplace-ci.yml.',
    '      - name: Something else',
    '        run: echo hi',
    '      # Precedent: plugin-tree-ci.yml.',
    '      - name: Restore a distribution',
    '        uses: actions/download-artifact@v8',
    '        with:',
    '          name: some-dist',
    '          path: some/dist',
    '',
  ].join('\n');

  assert.deepEqual(citedPrecedents(source, 'self-ci.yml'), ['plugin-tree-ci.yml']);
  assert.deepEqual(restoredArtifactNames(source), ['some-dist']);
});

test('a marker separated from the step opener by a blank line is not read', () => {
  const source = [
    '      # Precedent: marketplace-ci.yml.',
    '',
    '      - name: Restore a distribution',
    '        uses: actions/download-artifact@v8',
    '        with:',
    '          name: some-dist',
    '',
  ].join('\n');

  assert.deepEqual(citedPrecedents(source, 'self-ci.yml'), []);
});

test('a workflow named outside a Precedent line is prose, not a citation', () => {
  const source = [
    '      # Unlike marketplace-ci.yml, we restore by name. See also policy-ci.yml.',
    '      # Precedent: plugin-tree-ci.yml.',
    '      - name: Restore a distribution',
    '        uses: actions/download-artifact@v8',
    '        with:',
    '          name: some-dist',
    '',
  ].join('\n');

  assert.deepEqual(citedPrecedents(source, 'self-ci.yml'), ['plugin-tree-ci.yml']);
});

// A workflows directory holding exactly the given files, so a citation can be
// pointed at a real neighbor without depending on the repository's own
// workflows. The tests below assert on `findBrokenCitations` itself: asserting
// only on the two helpers left both of its report branches free to be deleted
// with every test still green.
function fixtureWorkflows(files) {
  const workflowsRoot = mkdtempSync(join(tmpdir(), 'jinn-precedent-citations-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(workflowsRoot, name), contents);
  }
  return workflowsRoot;
}

const citingConsolidated = [
  '      # Precedent: consolidated-ci.yml.',
  '      - name: Restore a distribution',
  '        uses: actions/download-artifact@v8',
  '        with:',
  '          name: some-dist',
  '',
].join('\n');

test('a citation pointing at a workflow that restores nothing is reported', () => {
  const consolidated = ['jobs:', '  build:', '    steps:', '      - run: yarn build', ''].join('\n');
  const fixtureRoot = fixtureWorkflows({
    'citing-ci.yml': citingConsolidated,
    'consolidated-ci.yml': consolidated,
  });

  try {
    assert.deepEqual(citedPrecedents(citingConsolidated, 'citing-ci.yml'), ['consolidated-ci.yml']);
    assert.equal(restoredArtifactNames(consolidated).length, 0);
    assert.deepEqual(findBrokenCitations(fixtureRoot), [
      'citing-ci.yml cites consolidated-ci.yml as by-name-restore precedent, but it restores no artifact by name',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('a citation pointing at a workflow that does not exist is reported', () => {
  // consolidated-ci.yml is deliberately absent: that absence is the branch under
  // test. Adding it here would fall through to the restores-nothing arm and make
  // this a duplicate of the test above.
  const fixtureRoot = fixtureWorkflows({ 'citing-ci.yml': citingConsolidated });

  try {
    assert.deepEqual(findBrokenCitations(fixtureRoot), [
      'citing-ci.yml cites consolidated-ci.yml, which does not exist',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('a citation pointing at a workflow that does restore by name is not reported', () => {
  const fixtureRoot = fixtureWorkflows({
    'citing-ci.yml': citingConsolidated,
    'consolidated-ci.yml': [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/download-artifact@v8',
      '        with:',
      '          name: some-dist',
      '',
    ].join('\n'),
  });

  try {
    assert.deepEqual(findBrokenCitations(fixtureRoot), []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('a restore step at the end of a job does not read the next job\'s name', () => {
  const source = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - uses: actions/download-artifact@v8',
    '        with:',
    '          pattern: plugin-*-dist',
    '  b:',
    '    name: build',
    '',
  ].join('\n');

  assert.deepEqual(restoredArtifactNames(source), []);
});

// Cites its own file name, and restores by `pattern:` rather than by name — so
// dropping the self-citation guard makes this file report itself.
const citingSelf = [
  '      # Precedent: self-ci.yml.',
  '      - name: Restore a distribution',
  '        uses: actions/download-artifact@v8',
  '        with:',
  '          pattern: some-*-dist',
  '',
].join('\n');

test('a workflow whose comment names itself is not reported as citing itself', () => {
  const fixtureRoot = fixtureWorkflows({ 'self-ci.yml': citingSelf });

  try {
    assert.deepEqual(findBrokenCitations(fixtureRoot), []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('a .yaml workflow is scanned for broken citations', () => {
  const fixtureRoot = fixtureWorkflows({ 'citing-ci.yaml': citingConsolidated });

  try {
    assert.deepEqual(findBrokenCitations(fixtureRoot), [
      'citing-ci.yaml cites consolidated-ci.yml, which does not exist',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('every broken citation is reported, not just the first', () => {
  const citingTwo = [
    '      # Precedent: consolidated-ci.yml and archived-ci.yml.',
    '      - name: Restore a distribution',
    '        uses: actions/download-artifact@v8',
    '        with:',
    '          name: some-dist',
    '',
  ].join('\n');
  const fixtureRoot = fixtureWorkflows({
    'citing-a-ci.yml': citingTwo,
    'citing-b-ci.yml': citingConsolidated,
  });

  try {
    assert.deepEqual(findBrokenCitations(fixtureRoot).sort(), [
      'citing-a-ci.yml cites archived-ci.yml, which does not exist',
      'citing-a-ci.yml cites consolidated-ci.yml, which does not exist',
      'citing-b-ci.yml cites consolidated-ci.yml, which does not exist',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// A `.yaml` neighbor cited as precedent. Every other fixture cites a `.yml`
// target, so without this one the `ya?ml` arm of the citation regex is latent:
// narrowing it to `yml` would read no citation at all and pass silently.
const citingYamlNeighbor = [
  '      # Precedent: consolidated-ci.yaml.',
  '      - name: Restore a distribution',
  '        uses: actions/download-artifact@v8',
  '        with:',
  '          name: some-dist',
  '',
].join('\n');

test('a citation naming a .yaml workflow is read', () => {
  const fixtureRoot = fixtureWorkflows({ 'citing-ci.yml': citingYamlNeighbor });

  try {
    assert.deepEqual(citedPrecedents(citingYamlNeighbor, 'citing-ci.yml'), ['consolidated-ci.yaml']);
    assert.deepEqual(findBrokenCitations(fixtureRoot), [
      'citing-ci.yml cites consolidated-ci.yaml, which does not exist',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('a restore step whose name follows a blank line inside its body is read', () => {
  const source = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - uses: actions/download-artifact@v8',
    '        with:',
    '          path: some/dist',
    '',
    '        name: some-dist',
    '',
  ].join('\n');

  assert.deepEqual(restoredArtifactNames(source), ['some-dist']);
});

// The two cases below pin `stepOpenerIndent`'s fallback for a restore step with
// no `- ` opener above it: the first fails if the fallback is raised (the scan
// leaves the step at once), the second if it is lowered (the scan never leaves).
test('a restore step with no opener above it reads its own name', () => {
  const source = ['uses: actions/download-artifact@v8', '  name: some-dist', ''].join('\n');

  assert.deepEqual(restoredArtifactNames(source), ['some-dist']);
});

test('a restore step with no opener above it stops at the first column-zero line', () => {
  const source = ['uses: actions/download-artifact@v8', 'jobs:', '  name: build', ''].join('\n');

  assert.deepEqual(restoredArtifactNames(source), []);
});

// #3143: the shared module is behind no workflow's `paths:` filter, so editing
// it selects neither lane that tests it. Before the consolidation the walk lived
// inside each lane's own test file, whose name that lane's filter matches — so
// any edit to the walk ran the gates that read it. A filter that does not name
// the module restores the shape this lineage exists to remove: the pull request
// that breaks a gate merges green, and the gate fires later against whoever next
// touches the lane. A lane with no `paths:` at all is always selected and needs
// no entry.
const SHARED_MODULE = '.github/scripts/workflow-artifact-steps.mjs';

export function lanesMissingSharedModule(workflowsRoot = workflowsDir, scriptsRoot = scriptsDir) {
  const importers = readdirSync(scriptsRoot)
    .filter((name) => name.endsWith('.test.mjs'))
    .filter((name) => readFileSync(join(scriptsRoot, name), 'utf8').includes('./workflow-artifact-steps.mjs'));

  const missing = [];
  for (const fileName of readdirSync(workflowsRoot).filter((name) => /\.ya?ml$/.test(name))) {
    const source = readFileSync(join(workflowsRoot, fileName), 'utf8');
    if (!importers.some((test) => source.includes(test))) continue;
    if (!/^\s+paths:\s*$/m.test(source)) continue;
    if (!source.includes(SHARED_MODULE)) {
      missing.push(`${fileName} runs a test importing ${SHARED_MODULE} but its paths: filter does not name it`);
    }
  }
  return missing;
}

test('every path-filtered lane that tests the shared walk names it in paths:', () => {
  assert.deepEqual(lanesMissingSharedModule(), []);
});
