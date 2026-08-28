// SPDX-License-Identifier: Apache-2.0
//
// The `verify` job restores every distribution the earlier jobs upload. A
// `pattern:` restore nests each artifact under `path/<artifact>/` only while two
// or more artifacts match; download-artifact v5 made a lone match extract
// straight into `path/`, so the pattern form silently changes shape with the
// artifact count. This workflow has exactly two `policy-*-dist` uploaders, the
// smallest count at which the nested layout still holds: consolidating the two
// packages, or gating either upload on a path filter, would have changed the
// restore layout with no gate to catch it. Restoring by name has no such
// dependency on how many artifacts exist.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  artifactValue,
  restoredArtifactNames,
  restoredArtifacts,
} from './workflow-artifact-steps.mjs';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(
  resolve(root, '.github/workflows/policy-ci.yml'),
  'utf8',
);

function uploadedArtifactNames(source) {
  const names = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('uses: actions/upload-artifact')) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const name = artifactValue(lines[cursor], 'name');
      if (name) {
        names.push(name);
        break;
      }
      if (/^\s+- /.test(lines[cursor])) break;
    }
  }
  return names;
}

test('every uploaded distribution is restored by name, never by pattern', () => {
  const uploaded = uploadedArtifactNames(workflow);
  assert.ok(uploaded.length > 0, 'the workflow must upload at least one distribution');

  // An expression-derived name cannot be matched against a literal restore, so
  // it would silently pass the loop below. Fail on it instead: an unparseable
  // uploader is the shape that hid a count change from this gate.
  for (const artifact of uploaded) {
    assert.equal(
      artifact.includes('${{'),
      false,
      `${artifact} names its artifact with an expression; this gate can only ` +
        'match literal names, so keep the artifact name literal',
    );
  }

  const restored = restoredArtifactNames(workflow);
  for (const artifact of uploaded) {
    assert.ok(
      restored.includes(artifact),
      `${artifact} is uploaded but never restored by name in the verify job`,
    );
  }

  const patternRestore = workflow
    .split('\n')
    .some((line) => /^\s+pattern: policy-/.test(line));
  assert.equal(
    patternRestore,
    false,
    'restore each policy distribution by name; a pattern restore changes layout with the artifact count',
  );
});

test('each package distribution is restored straight into its package', () => {
  const restored = restoredArtifacts(workflow);
  for (const pkg of ['identity', 'outcomes']) {
    const step = restored.find((entry) => entry.name === `policy-${pkg}-dist`);
    assert.ok(step, `policy-${pkg}-dist must be restored by a download step`);
    assert.equal(
      step.path,
      `packages/policy/${pkg}/dist`,
      `policy-${pkg}-dist must land directly in packages/policy/${pkg}/dist, not ${step.path}`,
    );
  }
  assert.equal(
    workflow.includes('.policy-dist'),
    false,
    'the staging directory and its placement copy are gone; restore in place',
  );
});

// The restore step's comment is where the by-name shape is explained and its
// precedent cited. The repository-wide gate in
// `workflow-precedent-citations.test.mjs` checks that every cited workflow
// still restores by name; this keeps the citation itself from simply
// disappearing from this workflow.
test('the restore step carries a comment citing a precedent workflow', () => {
  const lines = workflow.split('\n');
  const restoreStep = lines.findIndex((line) => line.includes('- name: Restore Policy Identity distribution'));
  assert.ok(restoreStep > 0, 'the identity restore step must exist');

  const comment = [];
  for (let cursor = restoreStep - 1; cursor >= 0; cursor -= 1) {
    if (!/^\s*#/.test(lines[cursor])) break;
    comment.unshift(lines[cursor]);
  }
  assert.ok(comment.length > 0, 'the restore step must carry its explanatory comment');

  const cited = [...new Set(comment.join('\n').match(/[\w-]+\.ya?ml/g) ?? [])].filter(
    (name) => name !== 'policy-ci.yml',
  );
  assert.ok(cited.length > 0, 'the comment must cite at least one precedent workflow');
});
