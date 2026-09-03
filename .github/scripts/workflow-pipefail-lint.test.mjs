// Rules and corpus contract for `workflow-pipefail-lint.mjs`.
//
// The lint replaces a manual sweep that under-counted its own surface: a step declaring
// `shell: bash` runs `-eo pipefail` with nothing in the script to grep for, so roughly
// half the pipefail-exposed `run:` blocks are invisible to a text search. These tests
// therefore pin the two things a reviewer cannot check by eye — that the shell-scope
// rules classify each shape correctly, and that the live corpus stays clean.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  analyzeWorkflow,
  collectRunBlocks,
  earlyExitConsumer,
  findActionFiles,
  isWorkflowSource,
  lintCompositeActions,
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
  assert.equal(result[0].consumer, 'grep -q');
  assert.match(result[0].detail, /SIGPIPE/u);
});

test('an `if` is not a guard — taking the else branch on 141 is the bug itself', () => {
  assert.deepEqual(severities('if git tag | grep -q v1; then echo hit; fi', { shell: 'bash' }), [
    'error:grep -q',
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
  assert.equal(earlyExitConsumer('grep -q needle'), 'grep -q');
  assert.equal(earlyExitConsumer('grep -qE -f patterns'), 'grep -q');
  assert.equal(earlyExitConsumer('grep --quiet needle'), 'grep --quiet');
  assert.equal(earlyExitConsumer('grep -m 1 needle'), 'grep -m');
  assert.equal(earlyExitConsumer('grep --max-count=1 needle'), 'grep --max-count');
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

test('a heredoc terminator closes its statement: the next line stands on its own', () => {
  // The finding must land on the offending line, not on the heredoc opener that
  // preceded it — for a lint whose whole output is "the site is here", the line is the
  // product.
  const result = findings(
    ["node <<'NODE'", "console.log('hi')", 'NODE', 'SHA="$(git tag | head -1)"'].join('\n'),
    { shell: 'bash' },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, 'error');
  assert.equal(result[0].statement, 'SHA="$(git tag | head -1)"');
  // Body lines start at file line 7 in the `findings` scaffold, so the heredoc opens on
  // 7 and the offending statement is on 10.
  assert.equal(result[0].line, 10);
});

test('an allow annotation after a heredoc reaches the statement it is written above', () => {
  // Comment-above is the documented placement, so it must survive a preceding heredoc:
  // otherwise the escape hatch fails closed on a required gate.
  assert.deepEqual(
    severities(
      [
        "node <<'NODE'",
        "console.log('hi')",
        'NODE',
        '# pipefail-lint: allow -- ls-remote asks for one exact ref',
        'SHA="$(git ls-remote origin refs/tags/v1 | head -1)"',
      ].join('\n'),
      { shell: 'bash' },
    ),
    [],
  );
});

test('a heredoc opener ending on a pipe still spans its body as one pipeline', () => {
  assert.deepEqual(
    severities(['cat <<EOF |', 'one', 'two', 'EOF', 'head -1'].join('\n'), { shell: 'bash' }),
    ['error:head'],
  );
});

test('a pipeline spanning body lines is still one pipeline', () => {
  assert.deepEqual(severities(['git tag --list \\', '  | grep -q v1'].join('\n'), { shell: 'bash' }), [
    'error:grep -q',
  ]);
  assert.deepEqual(severities(['git tag --list |', '  grep -q v1'].join('\n'), { shell: 'bash' }), [
    'error:grep -q',
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
  for (const name of readdirSync(workflowsDir).filter((file) => isWorkflowSource(file))) {
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

// ---------------------------------------------------------------------------
// Sweep #3825: the five review follow-ups filed against this lint's own PR.
// ---------------------------------------------------------------------------

test('a consumer wrapped in a group or subshell is the same early exit (#3767)', () => {
  assert.deepEqual(severities('producer | { head -1; }', { shell: 'bash' }), ['error:head']);
  assert.deepEqual(severities('producer | ( head -1 )', { shell: 'bash' }), ['error:head']);
  assert.equal(earlyExitConsumer('{ head -1; }'), 'head');
  assert.equal(earlyExitConsumer('( grep -q needle )'), 'grep -q');
  // A guard inside the group is still a guard.
  assert.equal(earlyExitConsumer('{ head -1 || true; }'), null);
  assert.equal(earlyExitConsumer('{ cat; }'), null);
});

test('`grep -l`/`-L` stop at the first match, so they are early-exit consumers (#3767)', () => {
  assert.equal(earlyExitConsumer('grep -l needle'), 'grep -l');
  assert.equal(earlyExitConsumer('grep -L needle'), 'grep -L');
  assert.equal(earlyExitConsumer('grep -il needle'), 'grep -l', 'a clustered -l counts');
  assert.equal(earlyExitConsumer('grep --files-with-matches needle'), 'grep --files-with-matches');
  assert.equal(earlyExitConsumer('grep --files-without-match needle'), 'grep --files-without-match');
  assert.deepEqual(severities('producer | grep -l needle', { shell: 'bash' }), ['error:grep -l']);
  // `-l` as the argument of an option that takes one is not a flag.
  assert.equal(earlyExitConsumer('grep -e -l'), null);
});

test('`awk` with an `exit` action stops reading (#3767)', () => {
  assert.equal(earlyExitConsumer("awk 'NR==1{print;exit}'"), 'awk …exit');
  assert.equal(earlyExitConsumer("awk 'NR==1 {print; exit}'"), 'awk …exit');
  assert.equal(earlyExitConsumer("awk '{print $1}'"), null);
  assert.equal(earlyExitConsumer('awk "{print \\$1}"'), null);
  assert.equal(earlyExitConsumer('awk -f prog.awk'), null, 'a program the lint cannot read is not a guess');
  assert.deepEqual(severities("producer | awk 'NR==1{print;exit}'", { shell: 'bash' }), ['error:awk …exit']);
});

test('a `q` inside a sed substitution is not the q command (#3806)', () => {
  assert.equal(earlyExitConsumer("sed 's/ q / /'"), null);
  assert.equal(earlyExitConsumer("sed 's|a|q|'"), null, 'any delimiter, not just /');
  assert.equal(earlyExitConsumer("sed 'y/abq/xyz/'"), null);
  assert.equal(earlyExitConsumer("sed -n '/foo/q'"), 'sed …q', 'a q after an address is still the q command');
  assert.equal(earlyExitConsumer("sed -n '1p;q'"), 'sed …q');
});

test('a `||` guard outside a compound guards everything inside it (#3806)', () => {
  assert.deepEqual(severities('{ producer | head -1; } || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('for f in a b; do producer | head -1; done || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('if producer | head -1; then echo y; fi || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('( producer | head -1 ) || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('while producer | head -1; do echo y; done || true', { shell: 'bash' }), []);
});

test('an unguarded compound still reports, and names the statement inside it (#3806)', () => {
  const compound = findings('{ producer | head -1; }', { shell: 'bash' });
  assert.deepEqual(
    compound.map((finding) => `${finding.severity}:${finding.statement}`),
    ['error:producer | head -1'],
  );
  assert.deepEqual(severities('for f in a b; do producer | head -1; done', { shell: 'bash' }), ['error:head']);
  assert.deepEqual(severities('if producer | head -1; then echo y; fi', { shell: 'bash' }), ['error:head']);
});

test('a guard on a later statement does not reach an earlier one (#3806)', () => {
  assert.deepEqual(severities('producer | head -1; other || true', { shell: 'bash' }), ['error:head']);
  assert.deepEqual(severities('producer | head -1 && other || true', { shell: 'bash' }), ['error:head']);
});

test('`jobs:` with a trailing comment still opens the job scope (#3806)', () => {
  const source = [
    'jobs: # all lanes',
    '  sample:',
    '    defaults:',
    '      run:',
    '        shell: bash',
    '    steps:',
    '      - run: |',
    '          git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', source).map((finding) => finding.severity),
    ['error'],
  );
});

test('a flow-style `defaults:` mapping is read (#3806)', () => {
  const inline = [
    'jobs:',
    '  sample:',
    '    defaults: { run: { shell: bash } }',
    '    steps:',
    '      - run: |',
    '          git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', inline).map((finding) => finding.severity),
    ['error'],
  );

  const nested = [
    'jobs:',
    '  sample:',
    '    defaults:',
    '      run: { shell: bash }',
    '    steps:',
    '      - run: |',
    '          git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', nested).map((finding) => finding.severity),
    ['error'],
  );
});

test('a step opening with extra spaces after the dash still resolves its `shell:` (#3806)', () => {
  const source = [
    'jobs:',
    '  sample:',
    '    steps:',
    '      -   shell: bash',
    '          run: |',
    '            git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', source).map((finding) => finding.severity),
    ['error'],
  );
});

test('the warning names the shell GitHub actually invokes (#3806)', () => {
  assert.match(findings('git tag | head -1', { shell: 'sh' })[0].detail, /`sh -e`/u);
  assert.match(findings('git tag | head -1')[0].detail, /default shell \(`bash -e`\)/u);
});

test('a workflow written through a heredoc does not perturb a neighbouring step (#3807)', () => {
  const source = [
    'jobs:',
    '  sample:',
    '    steps:',
    '      - name: write a workflow fixture',
    '        run: |',
    "          cat > wf.yml <<'YAML'",
    '          defaults:',
    '            run:',
    '              shell: bash',
    '          YAML',
    '      - name: real step, no shell declared',
    '        run: |',
    '          producer | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', source).map((finding) => `${finding.severity}:${finding.line}`),
    ['warning:13'],
    'the phantom job-level `defaults:` must not escalate an unrelated step',
  );
});

test('an embedded `- run:` inside a heredoc mints no phantom block (#3807)', () => {
  const source = [
    'jobs:',
    '  sample:',
    '    steps:',
    '      - name: write a workflow fixture',
    '        shell: bash',
    '        run: |',
    "          cat > wf.yml <<'YAML'",
    '          steps:',
    '            - run: |',
    '                producer | head -1',
    '          YAML',
    '',
  ].join('\n');
  assert.deepEqual(analyzeWorkflow('sample.yml', source), []);
});

test('a reasonless allow annotation is an error wherever it appears (#3768)', () => {
  // The hatch may never be used without a reason — including above a statement the
  // lint would not have reported, where the annotation is inert.
  const inert = findings(['# pipefail-lint: allow', 'echo safe'].join('\n'), { shell: 'bash' });
  assert.equal(inert.length, 1);
  assert.equal(inert[0].severity, 'error');
  assert.match(inert[0].detail, /no reasoning/u);

  // A lone annotation with nothing under it is reported too.
  const lone = findings('# pipefail-lint: allow', { shell: 'bash' });
  assert.equal(lone.length, 1);
  assert.match(lone[0].detail, /no reasoning/u);
});

test('the lint reads both workflow spellings, and so does its reachability check (#3768)', () => {
  assert.equal(isWorkflowSource('ci.yml'), true);
  assert.equal(isWorkflowSource('ci.yaml'), true);
  assert.equal(isWorkflowSource('README.md'), false);

  const dir = mkdtempSync(join(tmpdir(), 'pipefail-lint-'));
  try {
    writeFileSync(
      join(dir, 'sample.yaml'),
      ['jobs:', '  a:', '    steps:', '      - shell: bash', '        run: |', '          git tag | head -1', ''].join(
        '\n',
      ),
    );
    const found = lintWorkflows(dir);
    assert.deepEqual(
      found.map((finding) => `${finding.file}:${finding.severity}`),
      ['sample.yaml:error'],
    );
    // The reachability invariant the corpus test asserts must hold over a `.yaml` too.
    assert.ok(collectRunBlocks(readFileSync(join(dir, 'sample.yaml'), 'utf8')).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('composite action steps are scanned and default to pipefail in scope (#3808)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pipefail-lint-actions-'));
  try {
    mkdirSync(join(root, '.github', 'actions', 'probe'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'actions', 'probe', 'action.yml'),
      [
        'name: probe',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - shell: bash',
        '      run: |',
        '        git tag | head -1',
        '    - run: |',
        '        git log | head -1',
        '',
      ].join('\n'),
    );
    // A JavaScript action has no `run:` step and contributes nothing.
    mkdirSync(join(root, 'packages', 'js-action'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'js-action', 'action.yml'),
      ['name: js', 'runs:', "  using: node20", "  main: index.js", ''].join('\n'),
    );

    assert.deepEqual(
      findActionFiles(root).map((path) => path.replaceAll('\\', '/')).sort(),
      ['.github/actions/probe/action.yml', 'packages/js-action/action.yml'],
    );

    assert.deepEqual(
      lintCompositeActions(root).map((finding) => `${finding.file}:${finding.line}:${finding.severity}`),
      [
        '.github/actions/probe/action.yml:7:error',
        // A composite `run:` step is required to declare `shell:`, so an unresolved one
        // is the reader failing — the safe default is pipefail in scope.
        '.github/actions/probe/action.yml:9:error',
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every tracked composite action is inside the scanned set (#3808)', () => {
  // The discovery half: the walker prunes build and dependency trees, so assert that
  // no pruned directory hides a tracked `action.y*ml` from the lint.
  const repoRoot = resolve(import.meta.dirname, '../..');
  const tracked = execFileSync('git', ['ls-files', '-z', '*action.yml', '*action.yaml'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    // `git ls-files '*action.yml'` matches any path *ending* in it, so
    // `packages/x/docker-action.yml` comes back too. The walker keys on the exact
    // basename GitHub requires, so filter to that or the guard fails spuriously.
    .filter((entry) => entry.split('/').at(-1) === 'action.yml' || entry.split('/').at(-1) === 'action.yaml')
    .sort();
  const walked = new Set(findActionFiles(repoRoot).map((path) => path.replaceAll('\\', '/')));
  assert.deepEqual(
    tracked.filter((path) => !walked.has(path)),
    [],
    'a tracked action file the lint never reads is a silent hole in the gate',
  );
});

// Regressions from the sweep's own internal review.

test('an `exit` inside an awk regex or string is not the exit statement', () => {
  assert.equal(earlyExitConsumer("awk '/exit code/{print}'"), null);
  assert.equal(earlyExitConsumer('awk \'{print "exit"}\''), null);
  assert.equal(earlyExitConsumer("awk '/fail/{print; exit}'"), 'awk …exit');
});

test('a trailing comment is not part of a `shell:` value', () => {
  // Reading the comment into the shell string makes `shellSetsPipefail` miss the `bash`
  // and downgrades a real pipefail site to a warning — a fail-open on the gate.
  const step = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - shell: bash # the default is not pipefail',
    '        run: |',
    '          git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', step).map((finding) => finding.severity),
    ['error'],
  );

  const jobDefaults = [
    'jobs:',
    '  a:',
    '    defaults:',
    '      run:',
    '        shell: bash # every step',
    '    steps:',
    '      - run: |',
    '          git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', jobDefaults).map((finding) => finding.severity),
    ['error'],
  );
});

test('every block-scalar indicator masks its body', () => {
  // `collectRunBlocks` accepts any `|`/`>` header, so the mask must too: a header the
  // mask does not recognise reopens the phantom-`defaults:` hole for that step.
  for (const indicator of ['|', '|-', '|+', '|2', '|2-', '|-2', '>', '>-']) {
    const source = [
      'jobs:',
      '  sample:',
      '    steps:',
      '      - name: write a workflow fixture',
      `        run: ${indicator}`,
      "          cat > wf.yml <<'YAML'",
      '          defaults:',
      '            run:',
      '              shell: bash',
      '          YAML',
      '      - name: real step, no shell declared',
      '        run: |',
      '          producer | head -1',
      '',
    ].join('\n');
    assert.deepEqual(
      analyzeWorkflow('sample.yml', source).map((finding) => finding.severity),
      ['warning'],
      `run: ${indicator}`,
    );
  }
});

test('a composite action under a generated-looking directory is still discovered', () => {
  // `dist` and `build` are real places to put `.github/actions/<name>/action.yml`, and a
  // prune entry matching a bare name at any depth would hide one from the lint while the
  // discovery guard blamed the repository for it.
  const root = mkdtempSync(join(tmpdir(), 'pipefail-lint-prune-'));
  try {
    for (const name of ['build', 'dist', 'coverage']) {
      mkdirSync(join(root, '.github', 'actions', name), { recursive: true });
      writeFileSync(
        join(root, '.github', 'actions', name, 'action.yml'),
        ['runs:', '  using: composite', '  steps:', '    - shell: bash', '      run: |', '        git tag | head -1', ''].join(
          '\n',
        ),
      );
    }
    assert.deepEqual(
      findActionFiles(root).map((path) => path.replaceAll('\\', '/')),
      [
        '.github/actions/build/action.yml',
        '.github/actions/coverage/action.yml',
        '.github/actions/dist/action.yml',
      ],
    );
    assert.equal(lintCompositeActions(root).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an annotation finding is not reported as a pipe into a consumer', () => {
  const [annotation] = findings('# pipefail-lint: allow', { shell: 'bash' });
  assert.equal(annotation.kind, 'annotation');
  assert.equal(annotation.consumer, null);
  const [pipe] = findings('git tag | head -1', { shell: 'bash' });
  assert.equal(pipe.kind, 'pipe');
  assert.equal(pipe.consumer, 'head');
});
