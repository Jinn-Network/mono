// SPDX-License-Identifier: Apache-2.0
//
// The shape of a precedent citation: which comment block a marker must sit in
// to be read, and which artifacts a workflow restores by name. Both halves of
// the invariant read the shape from here rather than re-deriving it, so a
// marker deleted, misspelled, or moved out of the attached comment block fails
// the same way everywhere.
//
// This is a plain module, not a test file. The repository-wide gate over
// `.github/workflows` lives in `workflow-precedent-citations.test.mjs`, which
// runs unfiltered under Repository structure; the per-workflow marker guards
// live in `plugin-tree-ci-workflow.test.mjs` and `policy-ci-workflow.test.mjs`,
// each behind its own workflow's `paths:` filter. Importing one test file from
// another would register the repository-wide gate inside those filtered runs,
// which is the misattribution #3127 removed.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
