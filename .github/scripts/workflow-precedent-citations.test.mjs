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
// `paths:` filters.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  citedPrecedents,
  findBrokenCitations,
  restoredArtifactNames,
} from './workflow-precedent-citations.mjs';

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

test('a citation pointing at a workflow that restores nothing is reported', () => {
  const citing = [
    '      # Precedent: consolidated-ci.yml.',
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
