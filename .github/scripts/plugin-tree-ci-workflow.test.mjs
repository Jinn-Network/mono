// SPDX-License-Identifier: Apache-2.0
//
// The `verify` job restores every distribution the earlier jobs upload. A
// `pattern:` restore nests each artifact under `path/<artifact>/` only while two
// or more artifacts match; download-artifact v5 made a lone match extract
// straight into `path/`, so the pattern form silently changes shape with the
// artifact count. This workflow had exactly one uploader, and the placement copy
// that read the nested path broke when the action was upgraded. Restoring by
// name has no such dependency on how many artifacts exist.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(
  resolve(root, '.github/workflows/plugin-tree-ci.yml'),
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

function restoredArtifactNames(source) {
  const names = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('uses: actions/download-artifact')) continue;
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
    .some((line) => /^\s+pattern: plugin-/.test(line));
  assert.equal(
    patternRestore,
    false,
    'restore each plugin distribution by name; a pattern restore changes layout with the artifact count',
  );
});

test('the runtime distribution is restored straight into its package', () => {
  assert.match(
    workflow,
    /name: plugin-runtime-dist\n\s+path: plugin\/runtime\/dist\n/,
    'plugin-runtime-dist must land directly in plugin/runtime/dist',
  );
  assert.equal(
    workflow.includes('.plugin-tree-dist'),
    false,
    'the staging directory and its placement copy are gone; restore in place',
  );
});
