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
