// Rules and corpus contract for `workflow-pipefail-lint.mjs`.
//
// The lint replaces a manual sweep that under-counted its own surface: a step declaring
// `shell: bash` runs `-eo pipefail` with nothing in the script to grep for, so roughly
// half the pipefail-exposed `run:` blocks are invisible to a text search. These tests
// therefore pin the two things a reviewer cannot check by eye — that the shell-scope
// rules classify each shape correctly, and that the live corpus stays clean.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  analyzeWorkflow,
  collectRunBlocks,
  earlyExitConsumer,
  lintWorkflows,
} from './workflow-pipefail-lint.mjs';

const workflowsDir = resolve(import.meta.dirname, '../workflows');

function findings(body, { shell = null, defaults = null } = {}) {
  const step = shell === null ? '' : `        shell: ${shell}\n`;
  const jobDefaults = defaults === null ? '' : `    defaults:\n      run:\n        shell: ${defaults}\n`;
  const indented = body
    .split('\n')
    .map((line) => (line === '' ? '' : `          ${line}`))
    .join('\n');
  return analyzeWorkflow(
    'sample.yml',
    `jobs:\n  sample:\n${jobDefaults}    steps:\n      - name: sample\n${step}        run: |\n${indented}\n`,
  );
}

function severities(...args) {
  return findings(...args).map((finding) => `${finding.severity}:${finding.consumer}`);
}

test('the PR #2821 shape is an error: `shell: bash` runs -eo pipefail with no set line', () => {
  const result = findings(
    ['if printf \'%s\\n\' "${changed}" | grep -qE -f patterns; then', '  echo selected', 'fi'].join('\n'),
    { shell: 'bash' },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, 'error');
  assert.equal(result[0].consumer, 'grep -q/-m');
  assert.match(result[0].detail, /SIGPIPE/u);
});

test('an `if` is not a guard — taking the else branch on 141 is the bug itself', () => {
  assert.deepEqual(severities('if git tag | grep -q v1; then echo hit; fi', { shell: 'bash' }), [
    'error:grep -q/-m',
  ]);
});

test('a trailing `|| true` guards the pipeline, inside a command substitution too', () => {
  assert.deepEqual(severities('git tag | head -1 || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('TAG="$(git tag | head -1 || true)"', { shell: 'bash' }), []);
  assert.deepEqual(severities("TAG=\"$(git tag | head -1 || echo '')\"", { shell: 'bash' }), []);
});

test('a pipe inside a command substitution is still a pipe', () => {
  // The outer double quotes must not hide it: this is `release-notes-scaffold.yml`'s
  // own shape, and reading `$( … )` as literal text would blind the lint to it.
  assert.deepEqual(severities('SHA="$(git rev-list HEAD | head -1)"', { shell: 'bash' }), ['error:head']);
});

test('a consumer that reads its whole input is safe', () => {
  // `canonical-docs-check.yml`'s shape: `grep -E` without `-q` drains the producer.
  assert.deepEqual(severities('echo "$changed" | grep -E "$CANON" > /dev/null', { shell: 'bash' }), []);
  assert.deepEqual(severities('git log | tail -1', { shell: 'bash' }), []);
  assert.deepEqual(severities('git log | wc -l', { shell: 'bash' }), []);
});

test('the early-exit consumer set', () => {
  assert.equal(earlyExitConsumer('grep -q needle'), 'grep -q/-m');
  assert.equal(earlyExitConsumer('grep -qE -f patterns'), 'grep -q/-m');
  assert.equal(earlyExitConsumer('grep --quiet needle'), 'grep -q/-m');
  assert.equal(earlyExitConsumer('grep -m 1 needle'), 'grep -q/-m');
  assert.equal(earlyExitConsumer('grep --max-count=1 needle'), 'grep -q/-m');
  assert.equal(earlyExitConsumer('head -n1'), 'head');
  assert.equal(earlyExitConsumer('/usr/bin/head -c 40'), 'head');
  assert.equal(earlyExitConsumer("sed -n '1p;q'"), 'sed …q');
  assert.equal(earlyExitConsumer('sed 2q'), 'sed …q');

  assert.equal(earlyExitConsumer('grep -E needle'), null);
  assert.equal(earlyExitConsumer('grep -e -q'), null, 'a pattern that looks like a flag is not one');
  assert.equal(earlyExitConsumer("sed 's/q/x/'"), null, 'a q inside a substitution is not the q command');
  assert.equal(earlyExitConsumer('awk "{print \\$1}"'), null);
  assert.equal(earlyExitConsumer('sort -u'), null);
});

test('pipefail scope follows the shell GitHub actually invokes', () => {
  // Default shell is `bash -e {0}`: the pipeline reports the consumer only, so a failed
  // producer is laundered rather than surfaced. Worth reporting, not this gate's red.
  assert.deepEqual(severities('git tag | head -1'), ['warning:head']);
  assert.deepEqual(severities('git tag | head -1', { shell: 'bash' }), ['error:head']);
  assert.deepEqual(severities('git tag | head -1', { shell: 'bash -eo pipefail {0}' }), ['error:head']);
  assert.deepEqual(severities('git tag | head -1', { shell: 'sh' }), ['warning:head']);
  assert.deepEqual(severities('git tag | head -1', { defaults: 'bash' }), ['error:head']);
});

test('a mid-block `set -o pipefail` moves the boundary, and `set +o pipefail` moves it back', () => {
  assert.deepEqual(
    severities(['git tag | head -1', 'set -euo pipefail', 'git tag | head -1'].join('\n')),
    ['warning:head', 'error:head'],
  );
  assert.deepEqual(
    severities(['set -o pipefail', 'git tag | head -1', 'set +o pipefail', 'git tag | head -1'].join('\n')),
    ['error:head', 'warning:head'],
  );
});

test('`shell:` is found on either side of the `run:` key it belongs to', () => {
  const source = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: declared after run',
    '        run: |',
    '          git tag | head -1',
    '        shell: bash',
    '      - shell: bash',
    '        run: |',
    '          git tag | head -1',
    '      - name: none',
    '        run: |',
    '          git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', source).map((finding) => `${finding.severity}:${finding.line}`),
    ['error:6', 'error:10', 'warning:13'],
  );
});

test('a `- run:` step does not inherit the preceding step\'s `shell:`', () => {
  // `- run:` opens its own step, so nothing above the `run:` key belongs to it. A
  // backward search would cross the previous step's `run:` body — every line of which
  // sits at `indent > keyIndent` — and read that step's `shell:` instead.
  const declaresBash = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: patch',
    '        shell: bash',
    '        run: |',
    '          git tag | head -1',
    '      - run: git tag | head -1',
    '',
  ].join('\n');
  // The second block runs under the runner default, not the first step's `bash`.
  assert.deepEqual(
    analyzeWorkflow('sample.yml', declaresBash).map((finding) => `${finding.severity}:${finding.line}`),
    ['error:7', 'warning:8'],
  );

  const declaresPython = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: py',
    '        shell: python',
    '        run: |',
    '          print(1)',
    '      - run: git tag | head -1',
    '',
  ].join('\n');
  // A non-pipeline shell leaking forward would drop the following block from the scan
  // entirely — the invisible-surface failure this lint exists to close.
  assert.deepEqual(
    analyzeWorkflow('sample.yml', declaresPython).map((finding) => `${finding.severity}:${finding.line}`),
    ['warning:8'],
  );

  assert.deepEqual(
    collectRunBlocks(declaresBash).map((block) => block.declared),
    ['bash', null],
  );
});

test('a job-level `defaults:` covers its own job only', () => {
  const source = [
    'defaults:',
    '  run:',
    '    shell: sh',
    'jobs:',
    '  first:',
    '    defaults:',
    '      run:',
    '        shell: bash',
    '    steps:',
    '      - run: |',
    '          git tag | head -1',
    '  second:',
    '    steps:',
    '      - run: |',
    '          git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', source).map((finding) => finding.severity),
    ['error', 'warning'],
    "the second job inherits the workflow's `sh`, not the first job's `bash`",
  );
});

test('a non-shell `shell:` is skipped whole', () => {
  assert.deepEqual(severities("x = 'a | head -1'", { shell: 'python' }), []);
  assert.deepEqual(severities('$x = "a | head -1"', { shell: 'pwsh' }), []);
});

test('heredoc bodies are data, not shell', () => {
  assert.deepEqual(
    severities(["cat > script <<'EOF'", 'producer | head -1', 'EOF', 'echo done'].join('\n'), {
      shell: 'bash',
    }),
    [],
  );
});

test('a pipeline spanning body lines is still one pipeline', () => {
  assert.deepEqual(severities(['git tag --list \\', '  | grep -q v1'].join('\n'), { shell: 'bash' }), [
    'error:grep -q/-m',
  ]);
  assert.deepEqual(severities(['git tag --list |', '  grep -q v1'].join('\n'), { shell: 'bash' }), [
    'error:grep -q/-m',
  ]);
});

test('an allow annotation silences the site, on its own line or above it', () => {
  assert.deepEqual(
    severities(['# pipefail-lint: allow -- one root commit', 'SHA="$(git rev-list --max-parents=0 HEAD | head -1)"'].join('\n'), {
      shell: 'bash',
    }),
    [],
  );
  assert.deepEqual(severities('git tag | head -1 # pipefail-lint: allow -- bounded', { shell: 'bash' }), []);
  // Reasoning may run to as many comment lines as it needs before the statement.
  assert.deepEqual(
    severities(
      ['# pipefail-lint: allow -- the producer emits', '# at most two lines', 'git tag | head -1'].join('\n'),
      { shell: 'bash' },
    ),
    [],
  );
});

test('an allow annotation with no reasoning is itself an error', () => {
  const result = findings(['# pipefail-lint: allow', 'git tag | head -1'].join('\n'), { shell: 'bash' });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, 'error');
  assert.match(result[0].detail, /no reasoning/u);
});

test('the annotation is consumed by one statement, not by the rest of the block', () => {
  assert.deepEqual(
    severities(['# pipefail-lint: allow -- bounded', 'git tag | head -1', 'git log | head -1'].join('\n'), {
      shell: 'bash',
    }),
    ['error:head'],
  );
});

test('every workflow in the repository is free of unguarded early-exit pipes', () => {
  const errors = lintWorkflows().filter((finding) => finding.severity === 'error');
  assert.deepEqual(
    errors.map((finding) => `${finding.file}:${finding.line} ${finding.statement}`),
    [],
  );
});

test('the three sites from the #2857 sweep are safe by rule or annotated with reasoning', () => {
  // `canonical-docs-check.yml` needs no annotation: its `grep -E … > /dev/null` reads
  // the whole input, so no producer is ever cut short.
  const canonical = readFileSync(join(workflowsDir, 'canonical-docs-check.yml'), 'utf8');
  assert.match(canonical, /grep -E "\$CANON" > \/dev\/null/u);
  assert.deepEqual(analyzeWorkflow('canonical-docs-check.yml', canonical), []);

  // The other two carry the hatch, because "this producer emits one line" is a fact
  // about `git rev-list --max-parents=0` and `git ls-remote <one ref>`, not something
  // any syntactic rule can see.
  for (const file of ['release-notes-scaffold.yml', 'stack-npm-publish.yml']) {
    const source = readFileSync(join(workflowsDir, file), 'utf8');
    const match = /#\s*pipefail-lint:\s*allow\b(?<rest>.*)/u.exec(source);
    assert.notEqual(match, null, `${file}: expected a pipefail-lint annotation`);
    assert.ok(
      match.groups.rest.replace(/^\s*--\s*/u, '').trim().length > 10,
      `${file}: the annotation must record why the site is safe`,
    );
  }
});

test('the lint gates an always-on lane', () => {
  const source = readFileSync(join(workflowsDir, 'repository-structure.yml'), 'utf8');
  assert.match(source, /node --test \.github\/scripts\/workflow-pipefail-lint\.test\.mjs/u);
  assert.match(source, /node \.github\/scripts\/workflow-pipefail-lint\.mjs/u);
  // Wired into the required gate, not merely present as an ungated job.
  assert.match(source, /^\s+- workflow-pipefail$/mu);
  assert.match(source, /test "\$\{WORKFLOW_PIPEFAIL_RESULT\}" = "\$\{expected\}"/u);
});

test('every workflow source is reachable by the lint, with its shells resolved to its own steps', () => {
  // A `run:` block the block reader cannot see is a silent hole in the gate, so assert
  // the reader finds at least one block in every workflow that declares one. Reachability
  // is one half; the half that bites is resolution — a block may only claim a
  // step-declared shell when the file declares one for it, so the count of blocks
  // resolving to a declared shell can never exceed the file's `shell:` declarations.
  for (const name of readdirSync(workflowsDir).filter((file) => file.endsWith('.yml'))) {
    const source = readFileSync(join(workflowsDir, name), 'utf8');
    if (!/^\s+(?:-\s+)?run:/mu.test(source)) continue;
    assert.doesNotThrow(() => analyzeWorkflow(name, source), `${name}: analysis threw`);
    const blocks = collectRunBlocks(source);
    assert.ok(blocks.length > 0, `${name}: the reader found no run block`);
    const declarations = source.split('\n').filter((line) => /^\s*(?:-\s+)?shell:\s*\S/u.test(line)).length;
    const resolved = blocks.filter((block) => block.declared !== null).length;
    assert.ok(
      resolved <= declarations,
      `${name}: ${resolved} blocks resolved to a step-declared shell, but only ${declarations} are declared`,
    );
  }
});
