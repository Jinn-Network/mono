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
// structure, which runs on every pull request with no path filtering.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { restoredArtifactNames } from './workflow-artifact-steps.mjs';

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = resolve(root, '.github/workflows');
const scriptsDir = resolve(root, '.github/scripts');

export { restoredArtifactNames };

// Returns every workflow file name cited in a comment attached to a
// download-artifact step, self-citations excluded. The comment block is the run
// of `#` lines immediately above the step's `- ` opener; a citation written
// inside the step body, or separated from the opener by a blank line, is not
// read. Keep precedent citations in the attached block so this gate sees them.
export function citedPrecedents(source, selfName) {
  const lines = source.split('\n');
  const cited = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('uses: actions/download-artifact')) continue;

    let start = index;
    while (start >= 0 && !/^\s*- /.test(lines[start])) start -= 1;
    if (start < 0) continue;

    const comment = [];
    for (let cursor = start - 1; cursor >= 0; cursor -= 1) {
      if (!/^\s*#/.test(lines[cursor])) break;
      comment.unshift(lines[cursor]);
    }

    for (const match of comment.join('\n').match(/[\w-]+\.ya?ml/g) ?? []) {
      if (match !== selfName) cited.add(match);
    }
  }
  return [...cited];
}

export function findBrokenCitations(workflowsRoot = workflowsDir) {
  const broken = [];
  for (const fileName of readdirSync(workflowsRoot).filter((name) => /\.ya?ml$/.test(name))) {
    const source = readFileSync(join(workflowsRoot, fileName), 'utf8');
    for (const cited of citedPrecedents(source, fileName)) {
      const citedPath = join(workflowsRoot, cited);
      if (!existsSync(citedPath)) {
        broken.push(`${fileName} cites ${cited}, which does not exist`);
        continue;
      }
      if (restoredArtifactNames(readFileSync(citedPath, 'utf8')).length === 0) {
        broken.push(`${fileName} cites ${cited} as by-name-restore precedent, but it restores no artifact by name`);
      }
    }
  }
  return broken;
}

// The acceptance criterion of #3131: one behaviour of the restore-name walk in
// `.github/scripts`. Copies drift — #3127 fixed this file's walk while the two
// per-workflow tests kept the pre-fix one, so a `pattern:` restore at the end of
// a job still read the next job's `name:` there.
test('the restore-name walk is defined once, in the shared module', () => {
  const definers = readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.mjs') && name !== 'workflow-artifact-steps.mjs')
    .filter((name) => /function\s+restoredArtifacts?(Names)?\s*\(/.test(
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
    '      # Unrelated prose mentioning marketplace-ci.yml.',
    '      - name: Something else',
    '        run: echo hi',
    '      # Same shape as plugin-tree-ci.yml.',
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

test('a citation pointing at a workflow that restores nothing is reported', () => {
  const citing = [
    '      # Same shape as consolidated-ci.yml.',
    '      - name: Restore a distribution',
    '        uses: actions/download-artifact@v8',
    '        with:',
    '          name: some-dist',
    '',
  ].join('\n');
  const consolidated = ['jobs:', '  build:', '    steps:', '      - run: yarn build', ''].join('\n');

  assert.deepEqual(citedPrecedents(citing, 'citing-ci.yml'), ['consolidated-ci.yml']);
  assert.equal(restoredArtifactNames(consolidated).length, 0);
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
