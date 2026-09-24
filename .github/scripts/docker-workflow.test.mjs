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
 *
 * The optional `- ` in the opener is load-bearing: a step written without a
 * `name:` puts `run:` on the list-item line itself (`- run: |`), which is the
 * dominant step form in this repository — `ci.yml` alone uses it 35 times. An
 * opener anchored to `run:` as the first non-whitespace token skips those
 * steps' scripts silently, so the injection assertions below would advertise
 * coverage they do not have.
 */
function runBlocks(source = workflow) {
  const lines = source.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(\s*)(?:-\s+)?run:\s*(\|-?|>-?)?\s*(.*)$/.exec(lines[index]);
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

// Contexts whose value a caller controls. Each entry matches as a prefix, so a
// trailing `.` covers a whole family (`github.event.*`), and `github.actor`
// also catches `github.actor_id` — an over-match, which is the safe direction.
// `github.triggering_actor` is caller-controlled on a re-run (#4587).
const attackerContexts = [
  'github.event.',
  'inputs.',
  'github.ref_name',
  'github.head_ref',
  'github.actor',
  'github.triggering_actor',
];

/**
 * The attacker contexts interpolated anywhere in `block`, one entry per hit.
 *
 * A context counts wherever it appears inside a `${{ }}` expression, not only
 * as its first token, and bracket notation with a quoted key is normalized to
 * dot notation first (#4587): anchoring on `${{\s*<context>` let
 * `${{ github['event'].x }}` and `${{ format('{0}', github.ref_name) }}`
 * through. A context is only a hit when no `[\w.]` precedes it, so
 * `steps.x.github.actor` is a property path, not `github.actor`.
 *
 * Accepted residual: a dynamically computed index such as
 * `github[format('{0}', 'event')]` is not normalized, and so not seen.
 */
function attackerInterpolations(block) {
  const found = [];
  for (const [, expression] of block.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)) {
    const normalized = expression.replace(/\[\s*(['"])([^'"]*)\1\s*\]/gu, '.$2');
    for (const context of attackerContexts) {
      // A family entry (`github.event.`) also matches the whole object
      // (`toJSON(github.event)`), but not a sibling name (`github.event_name`).
      const escaped = context.endsWith('.')
        ? `${context.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?!\\w)`
        : context.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (new RegExp(String.raw`(?<![\w.])${escaped}`, 'u').test(normalized)) {
        found.push(context);
      }
    }
  }
  return found;
}

test('a manual publish may only run from a release tag', () => {
  // Without this allowlist a dispatch from `next` publishes that branch's HEAD
  // as `:latest` and `:<version>` to a public package DEPLOY.md tells operators
  // to pull unauthenticated: the version-equality check below passes whenever
  // operator/package.json still holds the last released version.
  const dispatchAt = meta.indexOf('if [ "${GITHUB_EVENT_NAME}" = "workflow_dispatch" ]');
  assert.notEqual(dispatchAt, -1, 'the dispatch branch must be selected by event name');

  const guard = /case "\$\{GITHUB_REF\}" in\s*\n\s*refs\/tags\/v\*\|refs\/tags\/client-v\*\)\s*;;\s*\n\s*\*\)\s*\n(?:.*\n)*?\s*exit 1\s*\n\s*;;\s*\n\s*esac/;
  assert.match(meta, guard);
  // Both bounds, because ordering alone is not containment: the whole
  // `case`/`esac` can be moved out of the branch, and a start-bound-only
  // assertion stays green while the allowlist no longer guards the dispatch.
  // `RELEASE_TAG="${RELEASE_TAG_INPUT}"` is the `else` arm, and therefore the
  // end of the dispatch branch.
  //
  // This proves where the allowlist sits, not that it runs. Leaving the
  // `case`/`esac` in place and wrapping it in `if false; then … fi` keeps this
  // test green while the allowlist is dead. Source-text assertions cannot see
  // that shape without a regex stack brittle to unrelated edits, so it is left
  // as a stated residual rather than guarded.
  const elseArmAt = meta.indexOf('RELEASE_TAG="${RELEASE_TAG_INPUT}"');
  assert.notEqual(elseArmAt, -1, 'the non-dispatch branch must read the tag from the environment');
  const guardAt = meta.search(guard);
  assert.ok(
    guardAt > dispatchAt && guardAt < elseArmAt,
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
  // job runs while holding `packages: write`. `github.ref_name` carries the
  // same ref-name value class, and `github.head_ref` and `github.actor` are
  // equally caller-controlled.
  //
  // A denylist, not a ban on `${{ }}` in a run block: `github.sha`,
  // `github.repository_owner` and `steps.meta.outputs.*` are interpolated today
  // and are constrained values (`steps.meta.outputs.version` is pinned as bare
  // semver by the test above).
  for (const block of runBlocks()) {
    assert.deepEqual(
      attackerInterpolations(block),
      [],
      'no run block may interpolate a caller-controlled context',
    );
  }

  assert.match(meta, /VERSION_INPUT: \$\{\{ inputs\.version \}\}/);
  assert.match(meta, /RELEASE_TAG_INPUT: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(meta, /RELEASE_TAG="\$\{RELEASE_TAG_INPUT\}"/);
  assert.match(meta, /"\$\{VERSION_INPUT#v\}" != "\$\{VERSION\}"/);
});

test('runBlocks collects a step written without a name', () => {
  // Regression probe for the opener's `- ` alternative. Without it this fixture
  // yields no blocks at all, and the interpolation assertions above pass over
  // every nameless `- run:` step in the workflow without reading one line of
  // its script.
  const fixture = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - run: |',
    '          echo "publishing ${{ github.event.release.tag_name }}"',
    '      - name: Named step',
    '        run: echo ${{ inputs.version }}',
    '      - run: echo "one-liner ${{ inputs.version }}"',
  ].join('\n');

  const blocks = runBlocks(fixture);
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /github\.event\.release\.tag_name/);
  assert.match(blocks[1], /inputs\.version/);
  assert.match(blocks[2], /one-liner/);
});

test('attackerInterpolations sees through bracket notation and function calls', () => {
  // #4587: the matcher used to anchor each context directly after `${{`, so
  // property-bracket notation and a function-call wrap both slipped past it.
  assert.deepEqual(attackerInterpolations("echo ${{ github['event'].release.tag_name }}"), ['github.event.']);
  assert.deepEqual(attackerInterpolations('echo ${{ github[ "event" ][\'inputs\'].x }}'), ['github.event.']);
  assert.deepEqual(attackerInterpolations("echo ${{ format('{0}', github.ref_name) }}"), ['github.ref_name']);
  assert.deepEqual(attackerInterpolations('echo ${{ (github.head_ref) }}'), ['github.head_ref']);
  assert.deepEqual(attackerInterpolations('echo ${{ github.triggering_actor }}'), ['github.triggering_actor']);
  assert.deepEqual(attackerInterpolations('echo ${{ github.actor_id }}'), ['github.actor']);
  assert.deepEqual(attackerInterpolations('echo ${{ toJSON(github.event) }}'), ['github.event.']);
  assert.deepEqual(attackerInterpolations("echo ${{ toJSON(github['event']) }}"), ['github.event.']);
  assert.deepEqual(attackerInterpolations('echo ${{ toJSON(inputs) }}'), ['inputs.']);
  assert.deepEqual(attackerInterpolations('echo ${{ github.event_name }}'), []);

  // Constrained values stay allowed, and a context name that only appears as
  // the tail of another property path is not the context itself.
  assert.deepEqual(attackerInterpolations('echo ${{ github.sha }}'), []);
  assert.deepEqual(attackerInterpolations('echo ${{ steps.meta.outputs.version }}'), []);
  assert.deepEqual(attackerInterpolations('echo ${{ steps.x.github.actor }}'), []);
  assert.deepEqual(attackerInterpolations('echo github.actor is plain text'), []);
});
