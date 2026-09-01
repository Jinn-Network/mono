// SPDX-License-Identifier: Apache-2.0
//
// The shape of a precedent citation: which comment block a marker must sit in
// to be read. Every gate reads that shape from here rather than re-deriving it,
// so a marker deleted, misspelled, or moved out of the attached comment block
// fails the same way everywhere. The other half of the invariant — which
// artifacts a workflow restores by name — is read through
// `workflow-artifact-steps.mjs`, the one copy of that walk in `.github/scripts`;
// defining a second one here is the drift #3131 removed.
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

import { restoredArtifactNames } from './workflow-artifact-steps.mjs';

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = resolve(root, '.github/workflows');

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

    // No `if (start < 0) continue` guard: when the scan runs off the top of
    // the file `start` is -1, the comment walk below starts at -2 and does not
    // execute, and the empty comment cites nothing. The guard was unkillable
    // because it was redundant (#3168 D).
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
