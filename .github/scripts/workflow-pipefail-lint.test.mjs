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

test('a `||` guard on a multi-line compound is the guard it is on one line', () => {
  // The fold used to end a logical line on `{`, `if …; then` or `for …; do`, because none
  // of them ends on a continuation operator — so the opener, the pipeline and the
  // `} || true` closer were walked as three separate statements and the guard was never
  // seen beside the pipeline it guards. Inside a `run: |` block the folded spelling is
  // the one people actually write, so the idiom reported a red on a genuinely guarded
  // compound (#3923).
  for (const guarded of [
    ['{', '  producer | head -1', '} || true'],
    ['if true; then', '  producer | head -1', 'fi || true'],
    ['for f in a b; do', '  producer | head -1', 'done || true'],
    ['while read -r f; do', '  producer | head -1', 'done || true'],
    ['case $v in', '  a) producer | head -1 ;;', 'esac || true'],
  ]) {
    assert.deepEqual(severities(guarded.join('\n'), { shell: 'bash' }), [], guarded.join(' / '));
  }

  // Unfolding is not silencing: drop the guard and each one is still exactly one error.
  for (const unguarded of [
    ['{', '  producer | head -1', '}'],
    ['if true; then', '  producer | head -1', 'fi'],
    ['for f in a b; do', '  producer | head -1', 'done'],
    ['while read -r f; do', '  producer | head -1', 'done'],
    ['case $v in', '  a) producer | head -1 ;;', 'esac'],
  ]) {
    assert.deepEqual(
      severities(unguarded.join('\n'), { shell: 'bash' }),
      ['error:head'],
      unguarded.join(' / '),
    );
  }

  // A guard written inside the folded body still covers the inside only.
  assert.deepEqual(
    severities(['if true; then', '  producer | head -1 || true', '  git tag | head -1', 'fi'].join('\n'), {
      shell: 'bash',
    }),
    ['error:head'],
  );
});

test('a folded compound still ends where its closer does', () => {
  // The fold must reopen the list at the closer, or everything after a compound would be
  // swallowed into it — including the statements the gate exists to report.
  assert.deepEqual(
    severities(['if true; then', '  echo y', 'fi', 'producer | head -1'].join('\n'), { shell: 'bash' }),
    ['error:head'],
  );
  // A heredoc written inside a compound must not close the fold at its terminator.
  assert.deepEqual(
    severities(
      ['{', "  cat <<'EOF'", '  literal', '  EOF', '  producer | head -1', '} || true'].join('\n'),
      { shell: 'bash' },
    ),
    [],
  );
});

test('a case pattern closes a pattern, not the `case` itself', () => {
  // `splitStatementUnits` lowered the nesting depth on any `)` operator, and a case
  // pattern is terminated by exactly that `)`. So `case $v in a)` netted back to depth 0,
  // the `|| true` after `esac` terminated a unit holding only `esac`, and a guarded
  // pipeline reported (#3925).
  assert.deepEqual(severities('case $v in a) producer | head -1 ;; esac || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('case $v in (a) producer | head -1 ;; esac || true', { shell: 'bash' }), []);
  assert.deepEqual(severities('case $v in a) producer | head -1 ;; esac', { shell: 'bash' }), ['error:head']);
  // The guard inside one branch covers that branch only.
  assert.deepEqual(
    severities('case $v in a) echo x || true ;; b) producer | head -1 ;; esac', { shell: 'bash' }),
    ['error:head'],
  );
});

test('a command substitution is a nested list, not a hole in the statement', () => {
  // `syntaxMask` leaves `$(` and its `)` out of the mask so a pipe inside a substitution
  // is still a pipe. They are therefore not operators either, so a `||` written inside one
  // separated units as if it were top level and the reported `statement` started
  // mid-substitution (#3926).
  const garbled = findings('foo $(a || true) | head -1', { shell: 'bash' });
  assert.equal(garbled.length, 1);
  assert.equal(garbled[0].severity, 'error');
  assert.equal(garbled[0].consumer, 'head');
  assert.equal(garbled[0].statement, 'foo $(a || true) | head -1');

  // A guard written inside the substitution guards what is inside it — the same shape as
  // a brace group, now that the interior is walked as its own list.
  assert.deepEqual(severities('X="$({ producer | head -1; } || true)"', { shell: 'bash' }), []);
  assert.deepEqual(severities('X="$(if true; then producer | head -1; fi || true)"', { shell: 'bash' }), []);

  // And the substitution is still transparent to the pipe hunt it was made transparent
  // for: an unguarded pipeline inside one still reports, against the whole statement.
  const inner = findings('X="$(producer | head -1)"', { shell: 'bash' });
  assert.deepEqual(
    inner.map((finding) => `${finding.severity}:${finding.consumer}`),
    ['error:head'],
  );
  assert.equal(inner[0].statement, 'X="$(producer | head -1)"');
  // A `||` inside a substitution spares only what precedes it there, never a later
  // top-level pipeline.
  assert.deepEqual(severities('echo $(a || true); producer | head -1', { shell: 'bash' }), ['error:head']);
});

test('a redirection is not a list separator: the pipe on its right is still a pipe', () => {
  // `2>&1` and `&>` carry an `&` that only looks like the background operator. Reading it
  // as one would cut the pipeline in two and lose the producer entirely — a silent hole
  // in the gate, which is the failure mode this lint exists to close.
  assert.deepEqual(severities('producer 2>&1 | grep -q needle', { shell: 'bash' }), [
    'error:grep -q/-m',
  ]);
  assert.deepEqual(severities('producer |& grep -q needle', { shell: 'bash' }), ['error:grep -q/-m']);
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

  // Only GitHub's built-in `shell:` keywords get GitHub's own `<name> -e {0}` template.
  // Any other value is a custom shell command, run as written with the script path
  // appended and no `-e` — so claiming one for `dash` or `zsh` sent a reader looking for
  // a flag that is not there (#3965).
  for (const shell of ['dash', 'zsh']) {
    const detail = findings('git tag | head -1', { shell })[0].detail;
    assert.ok(detail.includes(`\`${shell}\``), `${shell}: ${detail}`);
    assert.doesNotMatch(detail, /-e/u, shell);
  }
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
