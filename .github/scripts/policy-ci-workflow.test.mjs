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
      const name = lines[cursor].match(/^\s+name: (\S+)$/);
      if (name) {
        names.push(name[1]);
        break;
      }
      if (/^\s+- /.test(lines[cursor])) break;
    }
  }
  return names;
}

// Returns one `{ name, path }` per download step. Reading both from inside the
// step is what makes the placement assertion below mean anything: a bare
// `name: x` / `path: y` search over the whole file also matches the *upload*
// steps, so it would pass while the restores land somewhere else entirely.
function restoredArtifacts(source) {
  const restored = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('uses: actions/download-artifact')) continue;
    const step = { name: undefined, path: undefined };
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s+- /.test(lines[cursor])) break;
      const name = lines[cursor].match(/^\s+name: (\S+)$/);
      if (name) step.name = name[1];
      const path = lines[cursor].match(/^\s+path: (\S+)$/);
      if (path) step.path = path[1];
    }
    if (step.name) restored.push(step);
  }
  return restored;
}

function restoredArtifactNames(source) {
  return restoredArtifacts(source).map((step) => step.name);
}

test('every uploaded distribution is restored by name, never by pattern', () => {
  const uploaded = uploadedArtifactNames(workflow);
  assert.ok(uploaded.length > 0, 'the workflow must upload at least one distribution');

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
