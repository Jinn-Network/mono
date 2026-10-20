// An `actions/upload-artifact` step drops hidden files and directories unless it sets
// `include-hidden-files: true`. A step that names a dot-directory without the input finds
// nothing to upload: the Architecture Policy Audit failed on every run because
// `path: .architecture-audit` matched no file, and `if-no-files-found: error` turned that
// into a red run that looked the same as a real policy finding (#5020).
//
// The failure is silent until the step runs, and some of these steps only run on a
// schedule, so the rule is checked here against every workflow on every pull request
// (Repository structure carries no path filter).
//
// A path counts as hidden when any segment of it starts with a dot, not only the first.
// `.architecture-control/coverage.json` uploads without the input today, because the
// action tests the name of each item it visits and `coverage.json` is not hidden. The
// workflow sets the input anyway: a rule that needs a per-path exemption for "a file
// inside a hidden directory" would have to guess, from the workflow text, what the path
// resolves to at run time.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { leavesStep } from './workflow-artifact-steps.mjs';

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = join(root, '.github/workflows');

const indentOf = (line) => line.match(/^\s*/u)[0].length;
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/u, '$2');
const withoutComment = (value) => value.replace(/(?:^|\s)#.*$/u, '');

// The lines of the step that holds `lines[usesAt]`, from its `- ` opener to the line before
// the next step or the first dedent out of it. `name:` may come before `uses:`, so the
// opener is searched backwards rather than assumed to be the `uses:` line.
function stepLines(lines, usesAt) {
  let start = usesAt;
  while (start > 0 && !/^\s*- /u.test(lines[start])) start -= 1;
  const opener = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && !leavesStep(lines[end], opener)) end += 1;
  return lines.slice(start, end);
}

// The patterns a step's `path:` input names. A scalar names one; a block scalar names one per
// line, and a pattern that starts with `#` is a comment to the glob, not a path.
function stepPaths(step) {
  const at = step.findIndex((line) => /^\s+path:/u.test(line));
  if (at === -1) return [];
  const inline = withoutComment(step[at].replace(/^\s+path:/u, '')).trim();
  if (!/^[|>][+-]?$/u.test(inline)) return inline === '' ? [] : [unquote(inline)];
  const keyIndent = indentOf(step[at]);
  const paths = [];
  for (const line of step.slice(at + 1)) {
    if (line.trim() === '') continue;
    if (indentOf(line) <= keyIndent) break;
    const pattern = line.trim();
    if (!pattern.startsWith('#')) paths.push(pattern);
  }
  return paths;
}

function includesHiddenFiles(step) {
  const line = step.find((candidate) => /^\s+include-hidden-files:/u.test(candidate));
  if (line === undefined) return false;
  return unquote(withoutComment(line.replace(/^\s+include-hidden-files:/u, ''))) === 'true';
}

// A negated pattern removes files from the upload; it never adds one. `.` and `..` are
// directories, not names that start with a dot.
export function isHiddenPath(pattern) {
  if (pattern.startsWith('!')) return false;
  return pattern.split('/').some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

export function uploadSteps(source) {
  const lines = source.split('\n');
  const steps = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:-\s+)?uses:\s*['"]?actions\/upload-artifact@/u.test(lines[index])) continue;
    const step = stepLines(lines, index);
    steps.push({ line: index + 1, paths: stepPaths(step), includeHidden: includesHiddenFiles(step) });
  }
  return steps;
}

export function hiddenPathUploadsWithoutInput(source) {
  return uploadSteps(source)
    .filter(({ paths, includeHidden }) => !includeHidden && paths.some(isHiddenPath))
    .map(({ line, paths }) => ({ line, paths: paths.filter(isHiddenPath) }));
}

function workflowFiles() {
  return readdirSync(workflowsDir).filter((name) => /\.ya?ml$/u.test(name)).sort();
}

test('every upload step that names a hidden path sets include-hidden-files: true', () => {
  const offenders = [];
  for (const name of workflowFiles()) {
    const source = readFileSync(join(workflowsDir, name), 'utf8');
    for (const { line, paths } of hiddenPathUploadsWithoutInput(source)) {
      offenders.push(`${name}:${line} uploads ${paths.join(', ')} without include-hidden-files: true`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the scan reads the upload steps it exists to guard', () => {
  // An empty result above proves nothing if the walk is blind to the shapes the
  // repository really uses, so pin the ones that matter.
  const steps = (name) => uploadSteps(readFileSync(join(workflowsDir, name), 'utf8'));
  assert.deepEqual(
    steps('architecture-policy-audit.yml').map(({ paths, includeHidden }) => ({ paths, includeHidden })),
    [{ paths: ['.architecture-audit'], includeHidden: true }],
  );
  assert.ok(
    steps('benchmark-product-ci.yml').some(({ paths }) => paths.length > 1 && paths.some((path) => path.startsWith('!'))),
    'a block-scalar path list with negations must be read as separate patterns',
  );
  const total = workflowFiles().reduce(
    (count, name) => count + steps(name).length,
    0,
  );
  assert.ok(total >= 10, `expected the scan to find the repository's upload steps, found ${total}`);
});

function uploadWorkflow(withLines) {
  return [
    'jobs:',
    '  audit:',
    '    steps:',
    '      - uses: actions/upload-artifact@v7',
    '        with:',
    ...withLines.map((line) => `          ${line}`),
    '',
  ].join('\n');
}

for (const [label, withLines] of [
  ['a dot-directory with no input', ['name: x', 'path: .architecture-audit']],
  ['a dot-directory with the input false', ['name: x', 'path: .architecture-audit', 'include-hidden-files: false']],
  ['a dot-directory with an expression for the input', ['name: x', 'path: .architecture-audit', 'include-hidden-files: ${{ inputs.hidden }}']],
  ['a quoted dot-directory', ['name: x', 'path: ".architecture-audit"']],
  ['a hidden file', ['name: x', 'path: .env.generated']],
  ['a file inside a dot-directory', ['name: x', 'path: .architecture-control/coverage.json']],
  ['a hidden segment below a plain directory', ['name: x', 'path: apps/web/.next/standalone']],
  ['a hidden path behind a workspace expression', ['name: x', 'path: ${{ github.workspace }}/.cache']],
  ['a hidden pattern in a block of paths', ['name: x', 'path: |', '  dist', '  .platform-verification']],
  ['a hidden pattern in a folded block', ['name: x', 'path: >-', '  .platform-verification']],
  ['a hidden path with a trailing comment', ['name: x', 'path: .architecture-audit # evidence']],
]) {
  test(`a hidden path is reported for ${label}`, () => {
    assert.equal(hiddenPathUploadsWithoutInput(uploadWorkflow(withLines)).length, 1);
  });
}

for (const [label, withLines] of [
  ['the input true', ['name: x', 'path: .architecture-audit', 'include-hidden-files: true']],
  ['the input quoted true', ['name: x', 'path: .architecture-audit', "include-hidden-files: 'true'"]],
  ['the input before the path', ['name: x', 'include-hidden-files: true', 'path: .architecture-audit']],
  ['the input true and a trailing comment', ['name: x', 'path: .architecture-audit', 'include-hidden-files: true # the audit directory']],
  ['a plain directory', ['name: x', 'path: packages/layer/dist']],
  ['a relative plain directory', ['name: x', 'path: ./out']],
  ['a parent directory', ['name: x', 'path: ../out']],
  ['a runner expression', ['name: x', 'path: ${{ runner.temp }}/env-suite/']],
  ['a block of plain paths and a negated hidden one', ['name: x', 'path: |', '  dist', '  !dist/**/.env*']],
  ['a comment line in a block of paths', ['name: x', 'path: |', '  dist', '  # .platform-verification']],
]) {
  test(`no hidden path is reported for ${label}`, () => {
    assert.deepEqual(hiddenPathUploadsWithoutInput(uploadWorkflow(withLines)), []);
  });
}

test('the input on one upload step does not cover another step', () => {
  const source = [
    'jobs:',
    '  audit:',
    '    steps:',
    '      - name: Upload the first',
    '        uses: actions/upload-artifact@v7',
    '        with:',
    '          name: first',
    '          path: .first',
    '          include-hidden-files: true',
    '      - name: Upload the second',
    '        uses: actions/upload-artifact@v7',
    '        with:',
    '          name: second',
    '          path: .second',
    '',
  ].join('\n');
  assert.deepEqual(
    hiddenPathUploadsWithoutInput(source).map(({ paths }) => paths),
    [['.second']],
  );
});

test('a step that is not an upload is not read', () => {
  const source = [
    'jobs:',
    '  audit:',
    '    steps:',
    '      # uses: actions/upload-artifact@v7 would be wrong here',
    '      - uses: actions/download-artifact@v8',
    '        with:',
    '          name: x',
    '          path: .restored',
    '',
  ].join('\n');
  assert.deepEqual(uploadSteps(source), []);
});
