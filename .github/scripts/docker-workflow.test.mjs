import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `.github/workflows/docker.yml` is the stable image lane. #2811 gave it a
// `workflow_dispatch` trigger so a red release run can be retried, and that
// trigger arrived with three security controls — none of which anything
// asserted. All three are invisible to every other gate in the repository: the
// overlays pass `BASE_IMAGE` by digest and CI never dispatches this lane, so
// removing any of them leaves the whole suite green.
//
// Same shape as `layer-publish-workflow.test.mjs` and
// `npm-publish-workflow.test.mjs`: assertions over the workflow *source*, using
// node builtins only.
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(scriptsDir, '..', 'workflows', 'docker.yml');
const workflow = readFileSync(workflowPath, 'utf8');

/**
 * The body of the step whose `name:` matches, up to the next step at the same
 * indentation. Steps are `- name: …` list items, so the terminator is the next
 * line whose indentation is at most the `-`'s.
 */
function step(name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `step "${name}" must exist in docker.yml`);
  const indent = lines[start].match(/^\s*/)[0].length;
  const body = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * Every shell script this workflow runs. A `run:` block is a block scalar
 * (`|`, `|-`, `>`, `>-`) or a one-liner; both forms are collected, because a
 * `${{ }}` interpolation is equally injectable in either.
 */
function runBlocks() {
  const lines = workflow.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(\s*)run:\s*(\|-?|>-?)?\s*(.*)$/.exec(lines[index]);
    if (opener === null) continue;
    const [, indent, blockScalar, inline] = opener;
    if (blockScalar === undefined) {
      if (inline.trim()) blocks.push(inline);
      continue;
    }
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() && line.match(/^\s*/)[0].length <= indent.length) break;
      body.push(line);
      index = cursor;
    }
    blocks.push(body.join('\n'));
  }
  assert.ok(blocks.length > 0, 'docker.yml must contain run blocks to scan');
  return blocks;
}

const meta = step('Resolve release metadata');

test('a manual publish may only run from a release tag', () => {
  // Without this allowlist a dispatch from `next` publishes that branch's HEAD
  // as `:latest` and `:<version>` to a public package DEPLOY.md tells operators
  // to pull unauthenticated: the version-equality check below passes whenever
  // operator/package.json still holds the last released version.
  const dispatchAt = meta.indexOf('if [ "${GITHUB_EVENT_NAME}" = "workflow_dispatch" ]');
  assert.notEqual(dispatchAt, -1, 'the dispatch branch must be selected by event name');

  const guard = /case "\$\{GITHUB_REF\}" in\s*\n\s*refs\/tags\/v\*\|refs\/tags\/client-v\*\)\s*;;\s*\n\s*\*\)\s*\n(?:.*\n)*?\s*exit 1\s*\n\s*;;\s*\n\s*esac/;
  assert.match(meta, guard);
  assert.ok(
    meta.search(guard) > dispatchAt,
    'the release-tag allowlist must sit inside the workflow_dispatch branch',
  );

  // The tag then comes from the ref the allowlist just validated, never from an
  // input.
  assert.match(meta, /RELEASE_TAG="\$\{GITHUB_REF#refs\/tags\/\}"/);
});

test('the semver check covers both tag shapes, before VERSION reaches an output', () => {
  // Hoisted out of the `v*)` arm so `client-v*` is validated too. VERSION lands
  // in `$GITHUB_OUTPUT`, where a newline injects further outputs — including
  // `image_repo`, which selects the registry this job pushes to.
  const tagCaseAt = meta.indexOf('case "${RELEASE_TAG}" in');
  assert.notEqual(tagCaseAt, -1, 'RELEASE_TAG must be split by a case statement');
  const esacAt = meta.indexOf('esac', tagCaseAt);
  assert.notEqual(esacAt, -1, 'the RELEASE_TAG case must be closed');

  const semverAt = meta.search(/if ! \[\[ "\$\{VERSION\}" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/);
  assert.notEqual(semverAt, -1, 'VERSION must be validated as a bare semver');

  const outputAt = meta.indexOf('echo "version=${VERSION}"');
  assert.notEqual(outputAt, -1, 'VERSION must reach $GITHUB_OUTPUT');

  assert.ok(
    esacAt < semverAt,
    'the semver check must sit after the case, so it covers client-v* too',
  );
  assert.ok(semverAt < outputAt, 'VERSION must be validated before it is exported');
});

test('attacker-shaped values reach the shell through env, never interpolation', () => {
  // A git ref name may legally contain `$`, backticks and `;`, and a dispatch
  // input is free text. `${{ }}` pastes either straight into the script this
  // job runs while holding `packages: write`.
  for (const block of runBlocks()) {
    assert.doesNotMatch(
      block,
      /\$\{\{\s*github\.event\./,
      'no run block may interpolate ${{ github.event.* }}',
    );
    assert.doesNotMatch(
      block,
      /\$\{\{\s*inputs\./,
      'no run block may interpolate ${{ inputs.* }}',
    );
  }

  assert.match(meta, /VERSION_INPUT: \$\{\{ inputs\.version \}\}/);
  assert.match(meta, /RELEASE_TAG_INPUT: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(meta, /RELEASE_TAG="\$\{RELEASE_TAG_INPUT\}"/);
  assert.match(meta, /"\$\{VERSION_INPUT#v\}" != "\$\{VERSION\}"/);
});
