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

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = resolve(root, '.github/workflows');

// True at the first line that cannot belong to the step opened at `stepIndent`:
// the next step, or any dedent out of the step's block. Without the dedent arm a
// `pattern:` restore that is the last step of its job keeps scanning into the
// next job and matches that job's `name:`, scoring a workflow that restores
// nothing by name as compliant.
function leavesStep(line, stepIndent) {
  if (line.trim() === '') return false;
  const indent = line.match(/^\s*/)[0].length;
  return indent <= stepIndent;
}

// Reads the `name:` of every `actions/download-artifact` step. A bare search
// for `name:` over the whole file also matches the upload steps, so the walk
// stays inside the step it started in.
export function restoredArtifactNames(source) {
  const names = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('uses: actions/download-artifact')) continue;
    const stepIndent = stepOpenerIndent(lines, index);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (leavesStep(lines[cursor], stepIndent)) break;
      const name = lines[cursor].match(/^\s+name: (\S+)$/);
      if (name) {
        names.push(name[1]);
        break;
      }
    }
  }
  return names;
}

// The indentation of the `- ` line that opens the step containing `index`.
function stepOpenerIndent(lines, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const opener = lines[cursor].match(/^(\s*)- /);
    if (opener) return opener[1].length;
  }
  return 0;
}

// Returns every workflow file name cited as precedent in a comment attached to
// a download-artifact step, self-citations excluded. A citation is a line of
// the form `# Precedent: <workflow>.yml` — only names on such a line count, so
// a workflow named anywhere else in the block (a contrast, an aside, a pointer
// to a workflow that deliberately does something else) is prose, not a claim
// this gate will enforce. The comment block is the run of `#` lines immediately
// above the step's `- ` opener; a marker written inside the step body, or
// separated from the opener by a blank line, is not read. Keep precedent
// markers in the attached block so this gate sees them.
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

    for (const line of comment) {
      const marker = line.match(/^\s*#\s*Precedent:\s*(.*)$/);
      if (!marker) continue;
      for (const match of marker[1].match(/[\w-]+\.ya?ml/g) ?? []) {
        if (match !== selfName) cited.add(match);
      }
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
