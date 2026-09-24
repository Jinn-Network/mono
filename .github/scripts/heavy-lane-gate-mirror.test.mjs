// The terminal gates' heavy-lane mirrors, executed as shell rather than read as text.
//
// `operator-ci-gate` and `jinn-agent-gate` each re-derive, in shell, the lane rule
// their heavy jobs express in a `if:` expression. The two spellings must agree
// exactly: if the mirror expects `success` where the `if:` skipped, the required
// context reds on a lane that was deliberately thinned; if it expects `skipped`
// where the `if:` ran, a genuinely failed heavy job is laundered into green.
//
// Issue #2831 added a third lane to that rule — the standing release-review PR
// (`base:main head:next`, opened by `release-notes-scaffold.yml`), which resyncs on
// every push to `next` and re-ran a battery the merge group had just finished. It is
// excluded on `head_ref`, which means the rule now has two clauses in every one of
// its spellings, so the mirrors are pinned here by execution rather than by regex.
//
// The other spelling is the heavy jobs' own `if:` expressions. Those are executed
// here too, by a small evaluator of the expression subset they use, against the
// same lane matrix (#3665). A revert of either spelling reds this suite, before
// merge, rather than as a persistent red on the release-review PR afterwards.
//
// Hermetic: the scripts are lifted out of the workflow sources and run under `bash`
// with the job-result environment the gate reads. Nothing else is touched.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const workflowsRoot = resolve(import.meta.dirname, '../workflows');

// The `run:` script of the named step, dedented to column zero. Raw-source slicing
// rather than a YAML parser, for the reason `workflow-selection-shell.test.mjs`
// gives: `.github/scripts/` carries no dependency manifest.
function gateScript(workflow, stepName) {
  const text = readFileSync(join(workflowsRoot, workflow), 'utf8');
  const stepAt = text.indexOf(`\n      - name: ${stepName}\n`);
  assert.notEqual(stepAt, -1, `${workflow}: no step named ${stepName}`);
  const marker = '\n        run: |\n';
  const runAt = text.indexOf(marker, stepAt);
  assert.notEqual(runAt, -1, `${workflow}: ${stepName} has no literal-block run: script`);
  const indent = '          ';
  const lines = [];
  for (const line of text.slice(runAt + marker.length).split('\n')) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }
    if (!line.startsWith(indent)) break;
    lines.push(line.slice(indent.length));
  }
  const script = `${lines.join('\n')}\n`;
  assert.match(script, /^set -euo pipefail$/mu, `${workflow}: ${stepName} must be fail-loud`);
  return script;
}

function runGate(script, env) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
}

// The lane matrix the heavy-job `if:` expressions encode. `heavy` is what those jobs
// do on the lane once the changed-package selection has picked the workflow up.
const LANES = [
  { label: 'queue-backstopped PR', env: { EVENT_NAME: 'pull_request', BASE_REF: 'next', HEAD_REF: 'autopilot/1' }, heavy: 'skipped' },
  { label: 'hotfix PR to main', env: { EVENT_NAME: 'pull_request', BASE_REF: 'main', HEAD_REF: 'fix/incident-1' }, heavy: 'success' },
  { label: 'release-review PR (#2831)', env: { EVENT_NAME: 'pull_request', BASE_REF: 'main', HEAD_REF: 'next' }, heavy: 'skipped' },
  { label: 'merge group', env: { EVENT_NAME: 'merge_group', BASE_REF: '', HEAD_REF: '' }, heavy: 'success' },
  { label: 'push', env: { EVENT_NAME: 'push', BASE_REF: '', HEAD_REF: '' }, heavy: 'success' },
];

const OPPOSITE = { success: 'skipped', skipped: 'success' };

// An `if:` value as the expression it denotes. GitHub reads `if: ${{ X }}` as `X`,
// so the wrapper is stripped rather than handed to the evaluator.
function ifExpression(value) {
  const wrapped = value.match(/^\$\{\{(.*)\}\}$/su);
  return wrapped === null ? value : wrapped[1].trim();
}

// The job-level `if:` expression of the named job, with a folded (`>-`) scalar
// joined onto one line.
function jobIf(workflow, jobId) {
  const text = readFileSync(join(workflowsRoot, workflow), 'utf8');
  const jobAt = text.indexOf(`\n  ${jobId}:\n`);
  assert.notEqual(jobAt, -1, `${workflow}: no job ${jobId}`);
  const bodyAt = jobAt + `\n  ${jobId}:\n`.length;
  const nextJob = text.slice(bodyAt).search(/\n {2}[A-Za-z0-9_-]+:\n/u);
  const body = nextJob === -1 ? text.slice(bodyAt) : text.slice(bodyAt, bodyAt + nextJob + 1);
  const lines = body.split('\n');
  const at = lines.findIndex((line) => /^ {4}if: /u.test(line));
  assert.notEqual(at, -1, `${workflow}: job ${jobId} has no if:`);
  const value = lines[at].slice('    if: '.length).trim();
  if (value !== '>-' && value !== '>') return ifExpression(value);
  const folded = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('      ')) break;
    folded.push(line.trim());
  }
  assert.ok(folded.length > 0, `${workflow}: job ${jobId} has an empty folded if:`);
  return ifExpression(folded.join(' '));
}

// The `if:` of the step whose opener is `- if:` and whose next line is the given
// `run:` line.
function stepIf(workflow, runLine) {
  const lines = readFileSync(join(workflowsRoot, workflow), 'utf8').split('\n');
  const at = lines.indexOf(`        run: ${runLine}`);
  assert.notEqual(at, -1, `${workflow}: no step running ${runLine}`);
  const opener = lines[at - 1].match(/^ {6}- if: (.*)$/u);
  assert.ok(opener, `${workflow}: the step running ${runLine} must open with its if:`);
  return ifExpression(opener[1]);
}

// The subset of GitHub's expression syntax the heavy-lane `if:`s use: string
// literals, dotted context names, `==`/`!=`, `&&`/`||`, and parentheses. Anything
// else throws, so a new construct cannot be silently misread. Every context name
// is resolved while lexing, so an unknown name throws wherever it sits.
// GitHub compares strings case-insensitively; every value here is lowercase, so
// strict equality is faithful.
function evaluateIf(expression, context) {
  const tokens = [];
  const lexer = /\s+|'([^']*)'|(==|!=|&&|\|\||\(|\))|([A-Za-z_][\w.]*)/uy;
  while (lexer.lastIndex < expression.length) {
    const at = lexer.lastIndex;
    const match = lexer.exec(expression);
    if (match === null) throw new Error(`unsupported token at ${at}: ${expression.slice(at)}`);
    if (match[1] !== undefined) {
      tokens.push({ kind: 'value', value: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: match[2] });
    } else if (match[3] !== undefined) {
      if (!Object.hasOwn(context, match[3])) throw new Error(`unknown context name: ${match[3]}`);
      tokens.push({ kind: 'value', value: context[match[3]] });
    }
  }

  let position = 0;
  const peek = () => tokens[position]?.kind;
  const expect = (kind) => {
    if (peek() !== kind) throw new Error(`expected ${kind} at token ${position}`);
    position += 1;
  };
  const primary = () => {
    if (peek() === '(') {
      position += 1;
      const value = or();
      expect(')');
      return value;
    }
    if (peek() === 'value') return tokens[position++].value;
    throw new Error(`unexpected token at ${position}`);
  };
  const equality = () => {
    let value = primary();
    while (peek() === '==' || peek() === '!=') {
      const operator = tokens[position++].kind;
      const right = primary();
      value = operator === '==' ? value === right : value !== right;
    }
    return value;
  };
  const and = () => {
    let value = equality();
    while (peek() === '&&') {
      position += 1;
      const right = equality();
      value = value && right;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (peek() === '||') {
      position += 1;
      const right = and();
      value = value || right;
    }
    return value;
  };

  const result = or();
  if (position !== tokens.length) throw new Error(`trailing input at token ${position}`);
  return result;
}

// The expression context of one lane, once the changed-package selection has
// picked the workflow up.
function laneContext(lane) {
  return {
    'github.event_name': lane.env.EVENT_NAME,
    'github.base_ref': lane.env.BASE_REF,
    'github.head_ref': lane.env.HEAD_REF,
    'needs.changes.outputs.run': 'true',
  };
}

// The source lines that mention `github.head_ref`, less comment lines and the
// shell mirrors' env lines, whose whole value is exactly `${{ github.head_ref }}`
// (the mirrors are executed above). Any other `${{ ... }}` line is counted, so an
// `if: ${{ ... }}` cannot slip past.
function headRefSensitiveLines(source) {
  return source
    .split('\n')
    .filter(
      (line) =>
        !/^\s*#/u.test(line) &&
        line.includes('github.head_ref') &&
        !/^\s*[A-Z_]+: \$\{\{ github\.head_ref \}\}$/u.test(line),
    ).length;
}

// Every `if:` that spells the lane rule. The jinn-agent cold-stock job is not one
// of the five #3665 names, but its mirror is pinned against the same matrix above.
const HEAVY_IF_SITES = [
  ...['pack-smoke', 'dashboard-e2e', 'degraded-daemon-guard-e2e', 'task-creator-amd64-gold-proof'].map((jobId) => ({
    label: `ci.yml ${jobId}`,
    expression: () => jobIf('ci.yml', jobId),
  })),
  { label: 'layer-ci.yml pack:smoke step', expression: () => stepIf('layer-ci.yml', 'yarn pack:smoke') },
  { label: 'jinn-agent-ci.yml cold-stock-e2e', expression: () => jobIf('jinn-agent-ci.yml', 'cold-stock-e2e') },
];

test('operator-ci-gate mirrors the heavy jobs’ lane rule on every lane', () => {
  const script = gateScript('ci.yml', 'Require exact success from every selected operator-CI job');

  for (const lane of LANES) {
    const base = {
      ...lane.env,
      SELECTED: 'true',
      CHANGES_RESULT: 'success',
      ARCHITECTURE_RESULT: 'success',
      CHECK_RESULT: 'success',
      MARKETPLACE_E2E_RESULT: 'skipped',
    };
    const heavy = (result) => ({
      PACK_SMOKE_RESULT: result,
      DASHBOARD_E2E_RESULT: result,
      DEGRADED_DAEMON_GUARD_RESULT: result,
      GOLD_PROOF_RESULT: result,
    });

    const agreeing = runGate(script, { ...base, ...heavy(lane.heavy) });
    assert.equal(agreeing.status, 0, `${lane.label}: gate must accept heavy=${lane.heavy}\n${agreeing.stderr}`);

    const diverging = runGate(script, { ...base, ...heavy(OPPOSITE[lane.heavy]) });
    assert.notEqual(diverging.status, 0, `${lane.label}: gate must reject heavy=${OPPOSITE[lane.heavy]}`);
  }

  // Unselection never launders a red: a failed heavy job reds the gate on the lane
  // that runs it, and on the lane that skips it alike.
  for (const lane of LANES) {
    const failed = runGate(script, {
      ...lane.env,
      SELECTED: 'true',
      CHANGES_RESULT: 'success',
      ARCHITECTURE_RESULT: 'success',
      CHECK_RESULT: 'success',
      MARKETPLACE_E2E_RESULT: 'skipped',
      PACK_SMOKE_RESULT: 'failure',
      DASHBOARD_E2E_RESULT: lane.heavy,
      DEGRADED_DAEMON_GUARD_RESULT: lane.heavy,
      GOLD_PROOF_RESULT: lane.heavy,
    });
    assert.notEqual(failed.status, 0, `${lane.label}: a failed heavy job must red the gate`);
  }
});

test('jinn-agent-gate mirrors the cold-stock job’s lane rule on every lane', () => {
  const script = gateScript('jinn-agent-ci.yml', 'Require exact success from every selected jinn-agent job');

  for (const lane of LANES) {
    const base = { ...lane.env, REF: 'refs/heads/next', SELECTED: 'true', CHANGES_RESULT: 'success' };

    const agreeing = runGate(script, { ...base, COLD_STOCK_RESULT: lane.heavy });
    assert.equal(agreeing.status, 0, `${lane.label}: gate must accept cold-stock=${lane.heavy}\n${agreeing.stderr}`);

    const diverging = runGate(script, { ...base, COLD_STOCK_RESULT: OPPOSITE[lane.heavy] });
    assert.notEqual(diverging.status, 0, `${lane.label}: gate must reject cold-stock=${OPPOSITE[lane.heavy]}`);

    const failed = runGate(script, { ...base, COLD_STOCK_RESULT: 'failure' });
    assert.notEqual(failed.status, 0, `${lane.label}: a failed cold-stock job must red the gate`);
  }
});

test('the lane-rule evaluator honors precedence and refuses what it cannot read', () => {
  const context = { a: 'x', b: 'y' };
  assert.equal(evaluateIf("a == 'x' || b == 'y' && b == 'z'", context), true);
  assert.equal(evaluateIf("(a == 'x' || b == 'y') && b == 'z'", context), false);
  assert.equal(evaluateIf("a != 'x'", context), false);
  assert.throws(() => evaluateIf("contains(a, 'x')", context));
  assert.throws(() => evaluateIf("a === 'x'", context));
  assert.throws(() => evaluateIf("a == 'x')", context));
  assert.throws(() => evaluateIf("missing == 'x'", {}));
});

test('the heavy jobs’ if: expressions encode the same lane rule as their mirrors', () => {
  for (const site of HEAVY_IF_SITES) {
    const expression = site.expression();
    for (const lane of LANES) {
      assert.equal(
        evaluateIf(expression, laneContext(lane)),
        lane.heavy === 'success',
        `${site.label} on ${lane.label}: ${expression}`,
      );
    }
  }
});

test('a ${{ }}-wrapped if: is read as its expression and counted as head_ref-sensitive', () => {
  const wrapped = "${{ github.event_name != 'pull_request' || (github.base_ref == 'main' && github.head_ref != 'next') }}";
  const bare = "github.event_name != 'pull_request' || (github.base_ref == 'main' && github.head_ref != 'next')";
  assert.equal(ifExpression(wrapped), bare);
  assert.equal(ifExpression(bare), bare);
  const source = [
    '  new-heavy-job:',
    `    if: ${wrapped}`,
    '    steps:',
    '      - env:',
    '          HEAD_REF: ${{ github.head_ref }}',
    '        # a comment naming github.head_ref',
    '        run: echo "head_ref=${HEAD_REF}"',
  ].join('\n');
  assert.equal(headRefSensitiveLines(source), 1);
});

test('every head_ref-sensitive if: expression is pinned', () => {
  // A new heavy job that carries the release-review clause must join
  // HEAVY_IF_SITES. platform-architecture-control.yml spells the rule in shell,
  // which architecture-control-workflow.test.mjs executes.
  const counts = {};
  for (const workflow of ['ci.yml', 'layer-ci.yml', 'jinn-agent-ci.yml']) {
    counts[workflow] = headRefSensitiveLines(readFileSync(join(workflowsRoot, workflow), 'utf8'));
  }
  assert.deepEqual(counts, { 'ci.yml': 4, 'layer-ci.yml': 1, 'jinn-agent-ci.yml': 1 });
  // The execute list and the census must stay the same size. Emptying
  // HEAVY_IF_SITES still greens the loop above, and the census can stay
  // { ci: 4, layer: 1, jinn-agent: 1 } because it counts workflow source,
  // not the list that actually evaluates the expressions (#4646).
  assert.equal(
    HEAVY_IF_SITES.length,
    Object.values(counts).reduce((sum, count) => sum + count, 0),
  );
});
