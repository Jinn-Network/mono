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
  lintRepository,
  lintWorkflows,
  workflowDisplayPath,
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

test('a `||` guard outside a compound command still guards what is inside it', () => {
  // The guard is a top-level operator applied to the whole group, so the `;` inside the
  // group is not a statement boundary the guard can fall the wrong side of. Reporting
  // these was the reverse of the lint's contract: a red required gate on an idiom whose
  // only escape is an allow annotation whose stated reason would not be true.
  assert.deepEqual(severities('{ producer | head -1; } || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('for f in a b; do producer | head -1; done || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('if producer | head -1; then echo y; fi || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('( producer | head -1 ) || true', { shell: 'bash' }), []);
  // `||` binds the whole `&&` list to its left: `(a && b) || true`.
  assert.deepEqual(severities('producer | head -1 && echo hit || true', { shell: 'bash' }), []);
});

test('an unguarded compound is still read through, and only the guarded part of it is spared', () => {
  assert.deepEqual(severities('{ producer | head -1; }', { shell: 'bash' }), ['error:head']);
  assert.deepEqual(severities('for f in a b; do producer | head -1; done', { shell: 'bash' }), [
    'error:head',
  ]);
  assert.deepEqual(severities('if producer | head -1; then echo y; fi', { shell: 'bash' }), [
    'error:head',
  ]);
  // The inner guard covers the inner pipeline only; the second one is still reported.
  assert.deepEqual(
    severities('if { producer | head -1; } || true; then git tag | head -1; fi', { shell: 'bash' }),
    ['error:head'],
  );
  // A `;` does not carry a later guard leftward.
  assert.deepEqual(severities('producer | head -1; echo done || true', { shell: 'bash' }), [
    'error:head',
  ]);
});

test('a function definition is a group too, so a guard written inside its body counts', () => {
  // The group opener sits behind the definition prefix (`f` `(` `)` `{`), so reading only
  // the first token left the definition unwrapped and split its raw text on `|` — cutting
  // the inner `||` in half and losing the guard. Every spelling bash accepts is pinned,
  // because the multi-line ones stay clean only by accident of the logical-line split.
  assert.deepEqual(severities('f() { producer | head -1 || true; }; f', { shell: 'bash' }), []);
  assert.deepEqual(severities('f () { producer | head -1 || true; }', { shell: 'bash' }), []);
  assert.deepEqual(severities('function f { producer | head -1 || true; }', { shell: 'bash' }), []);
  assert.deepEqual(severities('function f() { producer | head -1 || true; }', { shell: 'bash' }), []);
  assert.deepEqual(severities('f() (producer | head -1 || true)', { shell: 'bash' }), []);
  assert.deepEqual(severities('f() { producer | grep -q x || true; }', { shell: 'bash' }), []);
  assert.deepEqual(severities('echo a; f() { producer | head -1 || true; }', { shell: 'bash' }), []);
  // Unwrapping is not silencing: an unguarded body is still an error, and the finding
  // names the pipeline rather than the fragment the definition was cut at.
  const unguarded = findings('f() { producer | head -1; }', { shell: 'bash' });
  assert.deepEqual(
    unguarded.map((finding) => `${finding.severity}:${finding.consumer}`),
    ['error:head'],
  );
  assert.equal(unguarded[0].statement, 'producer | head -1');
  // A brace group passed as an argument is not a definition — the parentheses are what
  // make one, unless `function` is written.
  assert.deepEqual(severities('f { producer | head -1; }', { shell: 'bash' }), ['error:head']);
});

test('a redirection is not a list separator: the pipe on its right is still a pipe', () => {
  // `2>&1` and `&>` carry an `&` that only looks like the background operator. Reading it
  // as one would cut the pipeline in two and lose the producer entirely — a silent hole
  // in the gate, which is the failure mode this lint exists to close.
  assert.deepEqual(severities('producer 2>&1 | grep -q needle', { shell: 'bash' }), ['error:grep -q']);
  assert.deepEqual(severities('producer |& grep -q needle', { shell: 'bash' }), ['error:grep -q']);
  assert.deepEqual(severities('producer 2>&1 | grep -q needle || true', { shell: 'bash' }), []);
});

test('the finding names the offending pipeline, not the compound wrapper around it', () => {
  const result = findings('{ producer | head -1; echo done; }', { shell: 'bash' });
  assert.equal(result.length, 1);
  assert.equal(result[0].statement, 'producer | head -1');
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
  assert.equal(earlyExitConsumer("sed 's/ q / /'"), null, 'a space-delimited q inside a script is not the q command');
  assert.equal(earlyExitConsumer("sed -e 's/a/b/' -e 's/ q /x/'"), null);
  assert.equal(earlyExitConsumer("sed -n '/needle/{p;q}'"), 'sed …q');
  assert.equal(earlyExitConsumer("sed '2 q'"), 'sed …q', 'an address may be spaced off its command');
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

test('a `set … pipefail` nested inside a compound does not escape it', () => {
  // Unwrapping compounds made these toggles visible to the walk for the first time.
  // Honouring them would downgrade a genuine `error` on the pipeline that follows —
  // under `shell: bash` pipefail is in scope for it in every one of these shapes, and
  // the `if false` branch does not even run.
  for (const nested of [
    '( set +o pipefail; echo x )',
    '{ set +o pipefail; echo x; }',
    'if false; then set +o pipefail; fi',
    'for f in a; do set +o pipefail; done',
    'f() { set +o pipefail; }',
  ]) {
    assert.deepEqual(
      severities([nested, 'git tag | head -1'].join('\n'), { shell: 'bash' }),
      ['error:head'],
      nested,
    );
  }

  // The mirror image: a branch that never runs must not red a gate that should advise.
  assert.deepEqual(
    severities(['if false; then set -o pipefail; fi', 'git tag | head -1'].join('\n'), { shell: 'sh' }),
    ['warning:head'],
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

test('a trailing comment does not hide `jobs:` from the job-range reader', () => {
  // `collectJobRanges` anchors on `jobs:`; a comment on that line used to leave every
  // job-level `defaults:` unresolved, silently downgrading a real error to an advisory.
  const source = [
    'jobs: # all lanes',
    '  a:',
    '    defaults:',
    '      run:',
    '        shell: bash # the lane needs pipefail',
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

test('a flow-style `defaults: { run: { shell: bash } }` resolves like the block form', () => {
  const source = [
    'jobs:',
    '  a:',
    '    defaults: { run: { shell: bash } }',
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

test('a step key column is the dash prefix, not a hard-coded two spaces', () => {
  // `-   shell: bash` is legal YAML and puts the step's keys at column dash+4.
  const source = [
    'jobs:',
    '  a:',
    '    steps:',
    '      -   shell: bash',
    '          run: |',
    '            git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    collectRunBlocks(source).map((block) => block.declared),
    ['bash'],
  );
  assert.deepEqual(
    analyzeWorkflow('sample.yml', source).map((finding) => finding.severity),
    ['error'],
  );
});

test('the advisory names the shell GitHub actually invokes', () => {
  assert.match(findings('git tag | head -1')[0].detail, /default shell \(`bash -e`\)/u);
  assert.match(findings('git tag | head -1', { shell: 'sh' })[0].detail, /`sh -e \{0\}`/u);
  assert.doesNotMatch(findings('git tag | head -1', { shell: 'sh' })[0].detail, /bash/u);
  assert.match(findings('git tag | head -1', { shell: 'zsh -e {0}' })[0].detail, /`zsh -e \{0\}`/u);
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

test('a workflow written through a heredoc contributes no `defaults:` to the enclosing file', () => {
  // The block scalar holding the heredoc is a string, so the `defaults:` inside it is
  // text. Read as structure it becomes a job-level scope and escalates the *next*,
  // entirely unrelated step from `warning` to `error` — and there is no honest place to
  // write the allow annotation, since the real site is safe for the reason the lint
  // already models.
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
  );
});

test('a `run:` written inside a block scalar mints no run block', () => {
  // The same class one key over: an embedded `- run: |` read as structure gives the lint
  // a step that does not exist, with a body it invents by indentation.
  const source = [
    'jobs:',
    '  sample:',
    '    steps:',
    '      - name: write a workflow fixture',
    '        shell: bash',
    '        run: |',
    "          cat > wf.yml <<'YAML'",
    '          - run: |',
    '              git tag | head -1',
    '          YAML',
    '',
  ].join('\n');
  assert.deepEqual(analyzeWorkflow('sample.yml', source), []);
  assert.deepEqual(
    collectRunBlocks(source).map((block) => block.runLine),
    [6],
  );
});

test('a phantom scope hides a real error as readily as it invents one', () => {
  // The escalation direction is the one the issue reported, but the same phantom read
  // the other way round is worse: the embedded `shell: sh` shadowed the real
  // workflow-level `bash`, and a genuinely pipefail-exposed site downgraded itself to an
  // advisory warning the gate does not fail on.
  const source = [
    'defaults:',
    '  run:',
    '    shell: bash',
    'jobs:',
    '  sample:',
    '    steps:',
    '      - run: |',
    "          cat > wf.yml <<'YAML'",
    '          defaults:',
    '            run:',
    '              shell: sh',
    '          YAML',
    '      - run: git tag | head -1',
    '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', source).map((finding) => `${finding.severity}:${finding.line}`),
    ['error:13'],
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
  // `&&` is not a boundary the guard stops at: `a && b || true` is `(a && b) || true`, so
  // a failing pipeline short-circuits into the same `|| true`.
  assert.deepEqual(severities('producer | head -1 && other || true', { shell: 'bash' }), []);
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
  assert.match(findings('git tag | head -1', { shell: 'sh' })[0].detail, /`sh -e \{0\}`/u);
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
      // A `run:` step this WOULD report if it were scanned, so the `using: composite`
      // filter is load-bearing: a vacuous fixture with no pipeline proves nothing.
      [
        'name: js',
        'runs:',
        '  using: node20',
        '  main: index.js',
        '  steps:',
        '    - shell: bash',
        '      run: |',
        '        git tag | head -1',
        '',
      ].join('\n'),
    );

    // `#3808` says `action.y*ml`; GitHub reads both spellings, so both are pinned.
    mkdirSync(join(root, '.github', 'actions', 'alt'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'actions', 'alt', 'action.yaml'),
      ['runs:', '  using: composite', '  steps:', '    - shell: bash', '      run: |', '        git tag | head -1', ''].join(
        '\n',
      ),
    );

    assert.deepEqual(
      findActionFiles(root).map((path) => path.replaceAll('\\', '/')).sort(),
      ['.github/actions/alt/action.yaml', '.github/actions/probe/action.yml', 'packages/js-action/action.yml'],
    );

    assert.deepEqual(
      lintCompositeActions(root).map((finding) => `${finding.file}:${finding.line}:${finding.severity}`),
      [
        '.github/actions/alt/action.yaml:6:error',
        '.github/actions/probe/action.yml:7:error',
        // A composite `run:` step is required to declare `shell:`, so an unresolved one
        // is the reader failing — the safe default is pipefail in scope.
        '.github/actions/probe/action.yml:9:error',
        // `packages/js-action/action.yml` is absent: it declares `using: node20`, so the
        // composite filter must keep its pipeline out of the corpus.
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every tracked composite action is inside the scanned set (#3808)', (t) => {
  // The discovery half: the walker prunes build and dependency trees, so assert that
  // no pruned directory hides a tracked `action.y*ml` from the lint.
  const repoRoot = resolve(import.meta.dirname, '../..');
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '-z', '*action.yml', '*action.yaml'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch {
    // A source tarball or a checkout without git cannot answer the question. Skip loudly
    // rather than erroring, and rely on the hermetic prune controls below.
    t.skip('git is unavailable, so the tracked set cannot be read');
    return;
  }
  const tracked = listed
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

// Regressions from the sweep's independent review.

test('a `||` guard on a compound spanning body lines reaches the site inside it (#3806)', () => {
  // The multi-line spelling is the ordinary one in a workflow. `splitTopLevel` resolves
  // a compound written on one line; this is the same guard honoured across lines, and
  // without it a correctly guarded pipeline reddens a required gate.
  for (const body of [
    ['{', '  producer | head -1', '} || true'],
    ['if producer | head -1; then', '  echo y', 'fi || true'],
    ['for f in a b; do', '  producer | head -1', 'done || true'],
    ['(', '  producer | head -1', ') || true'],
  ]) {
    assert.deepEqual(severities(body.join('\n'), { shell: 'bash' }), [], body[0]);
  }

  // …and the same compounds without the guard still report.
  for (const body of [
    ['{', '  producer | head -1', '}'],
    ['if producer | head -1; then', '  echo y', 'fi'],
    ['for f in a b; do', '  producer | head -1', 'done'],
  ]) {
    assert.deepEqual(severities(body.join('\n'), { shell: 'bash' }), ['error:head'], body[0]);
  }

  // A guard on a compound opened *after* a statement does not reach back to it.
  assert.deepEqual(
    severities(['producer | head -1', 'if x; then', '  echo y', 'fi || true'].join('\n'), { shell: 'bash' }),
    ['error:head'],
  );
});

test('a subshell opener glued to its first word still opens the compound (#3806)', () => {
  // `(printf …` and `… echo yes)` are the ordinary spelling. Recognising `(` only as a
  // standalone token left the outer guard on a different unit from the consumer.
  assert.deepEqual(severities("(printf '%s' \"$x\" | grep -q foo && echo yes) || true", { shell: 'bash' }), []);
  assert.deepEqual(severities('(producer | head -1; echo ok) || true', { shell: 'bash' }), []);
  assert.deepEqual(severities("(printf '%s' \"$x\" | grep -q foo && echo yes)", { shell: 'bash' }), [
    'error:grep -q',
  ]);
});

test("a subshell's `set ±o pipefail` dies with the subshell", () => {
  // Verified against bash: neither toggle escapes `( … )`. A `{ … }` group, and loop and
  // `if` bodies, do run in the current shell, so their toggles carry.
  assert.deepEqual(severities(['( set -o pipefail; : )', 'printf x | head -1'].join('\n')), ['warning:head']);
  assert.deepEqual(severities(['( set +o pipefail; : )', 'printf x | head -1'].join('\n'), { shell: 'bash' }), [
    'error:head',
  ]);
  assert.deepEqual(severities(['{ set -o pipefail; }', 'printf x | head -1'].join('\n')), ['error:head']);
});

test('`until`, `select` and `case` are compound openers too (#3806)', () => {
  assert.deepEqual(severities('until producer | head -1; do echo y; done || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('select f in a b; do producer | head -1; done || true', { shell: 'bash' }), []);
  // A `case` arm's `)` must not close the `case` itself, on one line or across them.
  assert.deepEqual(severities('case "$x" in a) producer | head -1 ;; esac || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('case "$x" in a) producer | head -1 ;; esac', { shell: 'bash' }), ['error:head']);
  assert.deepEqual(
    severities(['case "$x" in', '  a) producer | head -1 ;;', 'esac'].join('\n'), { shell: 'bash' }),
    ['error:head'],
  );
});

test('a comment inside a `defaults:` block is not a `shell:` declaration', () => {
  // The first `shell:`-shaped text used to win, so a comment beat the real key below it:
  // a fail-open when it named a weaker shell, a gate-failing error when it named a
  // stronger one.
  const commentedWeaker = [
    'jobs:', '  j:', '    defaults:', '      run:',
    '        # shell: sh was the old setting', '        shell: bash',
    '    steps:', '      - run: printf x | head -1', '',
  ].join('\n');
  assert.deepEqual(analyzeWorkflow('sample.yml', commentedWeaker).map((f) => f.severity), ['error']);

  const commentedStronger = [
    'jobs:', '  j:', '    defaults:', '      run:',
    '        # shell: bash', '        shell: sh',
    '    steps:', '      - run: printf x | head -1', '',
  ].join('\n');
  assert.deepEqual(analyzeWorkflow('sample.yml', commentedStronger).map((f) => f.severity), ['warning']);

  // A comment may sit at any column, including one shallower than the `defaults:` key.
  // Treating it as the end of the block loses the declaration below it.
  const outdented = [
    'jobs:', '  j:', '    defaults:', '      run:',
    '# an explanation at column 0', '        shell: bash',
    '    steps:', '      - run: printf x | head -1', '',
  ].join('\n');
  assert.deepEqual(analyzeWorkflow('sample.yml', outdented).map((f) => f.severity), ['error']);

  const trailing = [
    'jobs:', '  j:', '    defaults:', '      run:',
    '        working-directory: ./x # shell: sh is set elsewhere', '        shell: bash',
    '    steps:', '      - run: printf x | head -1', '',
  ].join('\n');
  assert.deepEqual(analyzeWorkflow('sample.yml', trailing).map((f) => f.severity), ['error']);
});

test('a trailing comment on a job key or on `defaults:` does not lose the scope (#3806)', () => {
  const source = [
    'jobs: # all lanes', '  sample: # linux only', '    defaults: # every step',
    '      run:', '        shell: bash', '    steps:', '      - run: |',
    '          git tag | head -1', '',
  ].join('\n');
  assert.deepEqual(analyzeWorkflow('sample.yml', source).map((f) => f.severity), ['error']);
});

test('a blank line inside a block scalar does not end its body (#3807)', () => {
  // A blank line is legal anywhere in a block scalar. If the mask ended there, the
  // embedded `defaults:` below it would become a phantom job-level default again and
  // escalate the neighbouring step from warning to error.
  const source = [
    'jobs:', '  sample:', '    steps:',
    '      - name: write a workflow fixture', '        run: |',
    "          cat > wf.yml <<'YAML'", '          name: generated', '',
    '          defaults:', '            run:', '              shell: bash', '          YAML',
    '      - name: real step, no shell declared', '        run: |',
    '          producer | head -1', '',
  ].join('\n');
  assert.deepEqual(
    analyzeWorkflow('sample.yml', source).map((finding) => `${finding.severity}:${finding.line}`),
    ['warning:15'],
  );
});

test('an option argument is not read as the awk program or the sed script', () => {
  // Without the arg-taking sets, `-v msg=exit` is read as the program and matches
  // `\bexit\b` — a false error on a required gate.
  assert.equal(earlyExitConsumer("awk -v msg=exit '{print msg}'"), null);
  assert.equal(earlyExitConsumer("awk -F exit '{print}'"), null);
  assert.equal(earlyExitConsumer('sed -f q'), null, 'a script file named q is not the q command');
  assert.equal(earlyExitConsumer("awk -v n=1 'NR==n{exit}'"), 'awk …exit', 'the program is still read');
});

test('the awk variants and the grep long forms are all classified', () => {
  assert.equal(earlyExitConsumer("gawk 'NR==1{exit}'"), 'awk …exit');
  assert.equal(earlyExitConsumer("mawk 'NR==1{exit}'"), 'awk …exit');
  assert.equal(earlyExitConsumer("nawk 'NR==1{exit}'"), 'awk …exit');
  assert.equal(earlyExitConsumer('grep --silent needle'), 'grep --silent');
  assert.equal(earlyExitConsumer('{ head -1 )'), null, 'a mismatched group is not unwrapped');
});

test('the prune set stays narrow enough to reach any plausible action location (#3808)', () => {
  // Widening the prune set is the failure the `git ls-files` guard cannot see while the
  // repository tracks no action file — it would report a hole the walker itself created.
  const root = mkdtempSync(join(tmpdir(), 'pipefail-lint-names-'));
  try {
    const names = ['bin', 'build', 'coverage', 'dist', 'lib', 'out', 'target', 'tmp', 'vendor'];
    for (const name of names) {
      mkdirSync(join(root, '.github', 'actions', name), { recursive: true });
      writeFileSync(join(root, '.github', 'actions', name, 'action.yml'), 'runs:\n  using: composite\n');
    }
    assert.deepEqual(
      findActionFiles(root)
        .map((path) => path.replaceAll('\\', '/').split('/').at(-2))
        .sort(),
      [...names].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the discovery guard fires when a composite action sits under a pruned tree (#3808)', () => {
  // The `git ls-files` guard is vacuous while the repository tracks no `action.y*ml`.
  // This is its positive control: the set difference it computes is exercised on a tree
  // where that difference is non-empty.
  const root = mkdtempSync(join(tmpdir(), 'pipefail-lint-pruned-'));
  try {
    const planted = [];
    for (const pruned of ['.git', '.yarn', 'node_modules']) {
      mkdirSync(join(root, pruned, 'pkg'), { recursive: true });
      writeFileSync(join(root, pruned, 'pkg', 'action.yml'), 'runs:\n  using: composite\n');
      planted.push(`${pruned}/pkg/action.yml`);
    }
    mkdirSync(join(root, '.github', 'actions', 'real'), { recursive: true });
    writeFileSync(join(root, '.github', 'actions', 'real', 'action.yml'), 'runs:\n  using: composite\n');

    const walked = findActionFiles(root).map((path) => path.replaceAll('\\', '/'));
    assert.deepEqual(walked, ['.github/actions/real/action.yml']);
    assert.deepEqual(planted.filter((path) => !new Set(walked).has(path)), planted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the whole repository is clean under the entry point the gate runs', () => {
  // `main()` calls `lintRepository()`, not `lintWorkflows()`: the composite arm and the
  // composition of the two were otherwise covered only by temp-dir fixtures.
  const errors = lintRepository().filter((finding) => finding.severity === 'error');
  assert.deepEqual(errors.map((finding) => `${finding.file}:${finding.line} ${finding.statement}`), []);
});

test('a workflow finding names a repository-relative path, so the annotation lands', () => {
  // `::error file=…` only attaches to a file in the GitHub UI when the path is
  // repo-relative; a corpus outside the repository falls back to the bare name.
  const dir = mkdtempSync(join(tmpdir(), 'pipefail-lint-path-'));
  try {
    writeFileSync(
      join(dir, 'probe.yml'),
      ['jobs:', '  a:', '    steps:', '      - shell: bash', '        run: |', '          git tag | head -1', ''].join(
        '\n',
      ),
    );
    assert.deepEqual(lintWorkflows(dir).map((finding) => finding.file), ['probe.yml']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The live corpus reports nothing, so the in-repository arm is pinned on the decision
  // itself rather than on a finding that never appears.
  assert.equal(workflowDisplayPath(workflowsDir, 'ci.yml'), join('.github', 'workflows', 'ci.yml'));
  assert.equal(workflowDisplayPath('/definitely/outside/the/repo', 'ci.yml'), 'ci.yml');
});

test('a guarded compound retracts only the findings that stand before its closer (#3921)', () => {
  // The retraction range used to end at the whole closing line, so a statement written
  // *after* the closer — which is the `||` fallback itself, and genuinely unguarded —
  // was swallowed along with the compound's own findings. Keying the range end on the
  // closer's token position is what tells the two apart.
  for (const body of [
    ['{', '  echo hi', '} || producer | head -1'],
    ['for f in a; do', '  echo $f', 'done || producer | head -1'],
    ['{', '  echo hi', '} || true; producer | head -1'],
  ]) {
    assert.deepEqual(severities(body.join('\n'), { shell: 'bash' }), ['error:head'], body.at(-1));
  }

  // …and the last body statement may still share the closer's line, where the retraction
  // has to reach it.
  assert.deepEqual(
    severities(['{', '  echo a', '  producer | head -1; } || true'].join('\n'), { shell: 'bash' }),
    [],
  );
});

test('a pipeline standing before a compound opener is outside the compound (#3922)', () => {
  // `lineNesting`'s `openerFirst` is what decides whether a line's own findings sit
  // inside the compound that line opens. Its `false` branch was unpinned: forcing the
  // field to `true` left the whole suite green while this shape went silently clean.
  assert.deepEqual(
    severities(['producer | head -1; if x; then', '  echo y', 'fi || true'].join('\n'), { shell: 'bash' }),
    ['error:head'],
  );
  // The `true` branch, for contrast: here the pipeline is the compound's own condition.
  assert.deepEqual(
    severities(['if producer | head -1; then', '  echo y', 'fi || true'].join('\n'), { shell: 'bash' }),
    [],
  );
});

test("a `case` arm's `)` does not close the subshell around the `case` (#3924)", () => {
  // The arm terminator has no opener of its own, so it used to pop the nearest open
  // `paren` from the block's stack — the enclosing subshell. The subshell's real `)`
  // then closed nothing and its guard never reached the arm, reddening a required gate
  // over a guarded pipeline.
  assert.deepEqual(
    severities(
      ['(', '  case "$x" in', '    a) producer | head -1 ;;', '  esac', ') || true'].join('\n'),
      { shell: 'bash' },
    ),
    [],
  );
  assert.deepEqual(
    severities(
      ['(', '  case "$x" in', '    a) echo one ;;', '  esac', '  producer | head -1', ') || true'].join('\n'),
      { shell: 'bash' },
    ),
    [],
  );
  // Losing the arm terminator must not lose a genuinely unguarded pipeline with it.
  assert.deepEqual(
    severities(['(', '  case "$x" in', '    a) producer | head -1 ;;', '  esac', ')'].join('\n'), {
      shell: 'bash',
    }),
    ['error:head'],
  );
  // A subshell opened *inside* an arm still owns its own `)`.
  assert.deepEqual(
    severities(
      ['case "$x" in', '  a) (', '    producer | head -1', '  ) || true ;;', 'esac'].join('\n'),
      { shell: 'bash' },
    ),
    [],
  );
  // The arm may open on the `case`'s own line, where the block stack has not yet been
  // told the `case` is open and only the line itself can tell the two `)` apart.
  assert.deepEqual(
    severities(
      ['(', '  case "$x" in a) producer | head -1 ;;', '  esac', ') || true'].join('\n'),
      { shell: 'bash' },
    ),
    [],
  );
});

test('a guard on a function definition does not reach the deferred body (#4000)', () => {
  // Verified against bash: `f () { seq 1 5000000 | head -1 >/dev/null; } || true; f` exits
  // 141 at the call. The guard covers defining the function, which cannot fail; the body
  // runs unguarded whenever the function is later called.
  for (const body of [
    ['f () {', '  producer | head -1', '} || true', 'f'],
    ['function f {', '  producer | head -1', '} || true', 'f'],
    ['{', '  f () {', '    producer | head -1', '  }', '} || true', 'f'],
  ]) {
    assert.deepEqual(severities(body.join('\n'), { shell: 'bash' }), ['error:head'], body[0]);
  }
  assert.deepEqual(severities('f () { producer | head -1; } || true', { shell: 'bash' }), ['error:head']);

  // A guard written *inside* the body is the one that runs with the body, so it counts —
  // on one line and across them.
  assert.deepEqual(severities('f () { producer | head -1 || true; }', { shell: 'bash' }), []);
  assert.deepEqual(
    severities(['f () {', '  producer | head -1 || true', '}'].join('\n'), { shell: 'bash' }),
    [],
  );
  assert.deepEqual(
    severities(['f () {', '  { producer | head -1', '  } || true', '}'].join('\n'), { shell: 'bash' }),
    [],
  );
});
