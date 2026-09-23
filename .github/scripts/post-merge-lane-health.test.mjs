import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALERT_LABEL,
  CONFIRM_AFTER_FAILURES,
  EXCLUDED_LANES,
  GRACE_MS,
  MONITORED_LANES,
  RUN_WINDOW,
  classifyLane,
  isAlertFor,
  parseMarker,
  planAlertUpdate,
  renderAlert,
  renderMarker,
  renderRecovery,
  sameFailingRun,
  titlePrefixFor,
} from './post-merge-lane-health.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(scriptsDir, '..', 'workflows');
const monitor = readFileSync(path.join(workflowsDir, 'post-merge-lane-monitor.yml'), 'utf8');

const LANE = MONITORED_LANES[0];
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-18T12:00:00Z');

let nextRunNumber = 1000;

/** Newest-first run fixtures; `hoursAgo` places the run's completion time. */
function run({ conclusion, hoursAgo, event = 'push', branch = 'next', status = 'completed', at, attempt = 1 }) {
  const number = (nextRunNumber -= 1);
  const stamp = at ?? new Date(NOW - hoursAgo * HOUR).toISOString();
  return {
    id: 90000 + number,
    run_number: number,
    run_attempt: attempt,
    status,
    conclusion,
    event,
    head_branch: branch,
    head_sha: `${number}`.repeat(8).slice(0, 40),
    html_url: `https://github.com/o/r/actions/runs/${90000 + number}`,
    created_at: stamp,
    run_started_at: stamp,
    updated_at: stamp,
  };
}

function classify(runs, now = NOW) {
  return classifyLane({ lane: LANE, runs, now });
}

test('a green latest run is healthy', () => {
  const verdict = classify([
    run({ conclusion: 'success', hoursAgo: 1 }),
    run({ conclusion: 'failure', hoursAgo: 5 }),
  ]);
  assert.equal(verdict.state, 'healthy');
  assert.equal(verdict.lastSuccess.conclusion, 'success');
});

test('no decisive run in the window is unknown: neither an alert nor a recovery', () => {
  assert.equal(classify([]).state, 'unknown');
  assert.equal(classify([run({ conclusion: null, status: 'in_progress', hoursAgo: 1 })]).state, 'unknown');
  const flood = Array.from({ length: 50 }, (_, i) => run({ conclusion: 'cancelled', hoursAgo: i }));
  assert.equal(classify(flood).state, 'unknown');
  assert.notEqual(classify(flood).state, 'healthy', 'an empty window must not read as a recovery');
});

test('only a completed run decides anything, whatever conclusion it carries', () => {
  const verdict = classify([
    run({ conclusion: 'failure', status: 'in_progress', hoursAgo: 0.1 }),
    run({ conclusion: 'success', hoursAgo: 1 }),
  ]);
  assert.equal(verdict.state, 'healthy');
  assert.equal(verdict.latestRun.status, 'completed');
});

test('a single fresh failure waits out the grace window', () => {
  const verdict = classify([
    run({ conclusion: 'failure', hoursAgo: 2 }),
    run({ conclusion: 'success', hoursAgo: 9 }),
  ]);
  assert.equal(verdict.state, 'wait');
  assert.equal(verdict.consecutiveFailures, 1);
});

test('a single failure that nothing has recovered past the grace window alerts as unconfirmed', () => {
  const verdict = classify([
    run({ conclusion: 'failure', hoursAgo: GRACE_MS / HOUR + 1 }),
    run({ conclusion: 'success', hoursAgo: 40 }),
  ]);
  assert.equal(verdict.state, 'alert');
  assert.equal(verdict.confidence, 'unconfirmed');
});

test('the grace window closes at exactly GRACE_MS', () => {
  const failure = run({ conclusion: 'failure', hoursAgo: 0 });
  const observedAt = Date.parse(failure.updated_at);
  assert.equal(classify([failure], observedAt + GRACE_MS - 1).state, 'wait');
  assert.equal(classify([failure], observedAt + GRACE_MS).state, 'alert');
});

test('a single failing run whose timestamps cannot be parsed alerts rather than waiting forever', () => {
  const verdict = classify([run({ conclusion: 'failure', at: 'not-a-date' })], NOW + 10 * 365 * 24 * HOUR);
  assert.equal(verdict.state, 'alert');
  assert.equal(verdict.confidence, 'unconfirmed');
  const { body } = renderAlert({ lane: LANE, verdict });
  assert.ok(body.includes('unknown'), 'the unparseable date renders as unknown rather than throwing');
});

test('consecutive failures alert immediately as confirmed', () => {
  const verdict = classify([
    run({ conclusion: 'failure', hoursAgo: 0.1 }),
    run({ conclusion: 'timed_out', hoursAgo: 1 }),
    run({ conclusion: 'success', hoursAgo: 6 }),
  ]);
  assert.equal(verdict.state, 'alert');
  assert.equal(verdict.confidence, 'confirmed');
  assert.equal(verdict.consecutiveFailures, CONFIRM_AFTER_FAILURES);
  assert.equal(verdict.firstFailure.conclusion, 'timed_out');
  assert.equal(verdict.lastSuccess.conclusion, 'success');
});

test('startup_failure counts as a failure', () => {
  const verdict = classify([
    run({ conclusion: 'startup_failure', hoursAgo: 0.1 }),
    run({ conclusion: 'failure', hoursAgo: 1 }),
    run({ conclusion: 'success', hoursAgo: 6 }),
  ]);
  assert.equal(verdict.state, 'alert');
  assert.equal(verdict.consecutiveFailures, 2);
  assert.equal(verdict.latestRun.conclusion, 'startup_failure');
});

test('cancelled and skipped runs are neither failures nor recoveries', () => {
  const stillRed = classify([
    run({ conclusion: 'cancelled', hoursAgo: 0.1 }),
    run({ conclusion: 'skipped', hoursAgo: 0.2 }),
    run({ conclusion: 'failure', hoursAgo: 1 }),
    run({ conclusion: 'failure', hoursAgo: 2 }),
  ]);
  assert.equal(stillRed.state, 'alert');
  assert.equal(stillRed.consecutiveFailures, 2);

  const blip = classify([run({ conclusion: 'cancelled', hoursAgo: 0.1 }), run({ conclusion: 'success', hoursAgo: 1 })]);
  assert.equal(blip.state, 'healthy');
});

test('runs from other branches and other events are excluded', () => {
  const verdict = classify([
    run({ conclusion: 'failure', hoursAgo: 0.1, branch: 'integration/evidence-v1' }),
    run({ conclusion: 'failure', hoursAgo: 0.2, event: 'workflow_dispatch' }),
    run({ conclusion: 'success', hoursAgo: 1 }),
  ]);
  assert.equal(verdict.state, 'healthy');
});

test('runs are ordered by run number, not by the order the API returned them', () => {
  const newest = run({ conclusion: 'success', hoursAgo: 0.1 });
  const older = run({ conclusion: 'failure', hoursAgo: 3 });
  assert.equal(classify([older, newest]).state, 'healthy');
});

test('the alert title is stable across successive failing runs so the issue is deduplicated', () => {
  const first = classify([run({ conclusion: 'failure', hoursAgo: 0.1 }), run({ conclusion: 'failure', hoursAgo: 1 })]);
  const later = classify([
    run({ conclusion: 'failure', hoursAgo: 0.1 }),
    run({ conclusion: 'failure', hoursAgo: 1 }),
    run({ conclusion: 'failure', hoursAgo: 2 }),
  ]);
  const a = renderAlert({ lane: LANE, verdict: first });
  const b = renderAlert({ lane: LANE, verdict: later });
  assert.equal(a.title, b.title);
  assert.ok(a.title.startsWith(titlePrefixFor(LANE)));
  assert.ok(a.title.includes(LANE.workflow));
});

test('the alert body answers the stale-artifact question without the Actions tab', () => {
  const verdict = classify([
    run({ conclusion: 'failure', hoursAgo: 0.1 }),
    run({ conclusion: 'failure', hoursAgo: 1 }),
    run({ conclusion: 'success', hoursAgo: 30 }),
  ]);
  const { body } = renderAlert({ lane: LANE, verdict });
  assert.ok(body.includes(LANE.staleArtifact), 'body names the tags consumers pin');
  assert.ok(body.includes(verdict.lastSuccess.html_url), 'body links the last successful run');
  assert.ok(body.includes(verdict.lastSuccess.head_sha.slice(0, 8)), 'body names the last published commit');
  assert.ok(body.includes('2026-08-17'), 'body dates the last successful publish');
  assert.ok(body.includes(verdict.latestRun.html_url), 'body links the failing run');
  assert.ok(body.includes(`<!-- post-merge-lane-monitor:${LANE.file} `), 'body carries the monitor marker');
});

test('the alert body states the verdict basis so a blip is distinguishable from a broken lane', () => {
  const confirmed = renderAlert({
    lane: LANE,
    verdict: classify([
      run({ conclusion: 'failure', hoursAgo: 0.1 }),
      run({ conclusion: 'failure', hoursAgo: 1 }),
      run({ conclusion: 'success', hoursAgo: 2 }),
    ]),
  }).body;
  assert.ok(/confirmed/i.test(confirmed));
  assert.ok(confirmed.includes('2 consecutive'));
  assert.ok(!confirmed.includes('at least'), 'a bounded streak is a count, not a floor');

  const unconfirmed = renderAlert({
    lane: LANE,
    verdict: classify([run({ conclusion: 'failure', hoursAgo: GRACE_MS / HOUR + 1 })]),
  }).body;
  assert.ok(/unconfirmed/i.test(unconfirmed));
});

test('a never-succeeded lane shorter than the window reports an exact count', () => {
  const verdict = classify([
    run({ conclusion: 'cancelled', hoursAgo: 0.05 }),
    run({ conclusion: 'failure', hoursAgo: 0.1 }),
    run({ conclusion: 'failure', hoursAgo: 1 }),
    run({ conclusion: 'failure', hoursAgo: 2 }),
  ]);
  assert.equal(verdict.windowBounded, true);
  assert.equal(verdict.observedRuns, 4);
  const { body } = renderAlert({ lane: LANE, verdict });
  assert.ok(body.includes('3 consecutive'), 'the short page is the whole history');
  assert.ok(!body.includes('at least'), 'a complete history is a count, not a floor');
  assert.ok(body.includes('First failure of this streak'));
  assert.ok(body.includes('the observed history has no success'));
  assert.ok(!body.includes('Not in the observed window'));
});

test('a streak the window cannot bound is reported as a floor, not a count', () => {
  const runs = Array.from({ length: RUN_WINDOW }, (_, i) =>
    run({ conclusion: 'failure', hoursAgo: i * 0.01 }),
  );
  const verdict = classify(runs);
  assert.equal(verdict.windowBounded, false);
  assert.equal(verdict.observedRuns, RUN_WINDOW);
  const { body } = renderAlert({ lane: LANE, verdict });
  assert.ok(body.includes(`at least ${RUN_WINDOW} consecutive`), 'the count is a floor');
  assert.ok(body.includes('Oldest failure in the observed window'), 'the first failure is not asserted');
  assert.ok(!body.includes('First failure of this streak'));
  assert.ok(body.includes('Not in the observed window'), 'the last-success row is marked as window-limited');
  assert.ok(body.includes(`newest ${RUN_WINDOW} runs`), 'the body says how far the window reached');
  assert.ok(!body.includes('No successful run in the observed window'), 'it never reads as "never succeeded"');
});

test('the alert body states what closes it and what a hand-close does', () => {
  const { body } = renderAlert({
    lane: LANE,
    verdict: classify([run({ conclusion: 'failure', hoursAgo: 0.1 }), run({ conclusion: 'failure', hoursAgo: 1 })]),
  });
  assert.ok(body.includes('`push` run'), 'only a push run closes the alert');
  assert.ok(body.includes('`workflow_dispatch` runs are not counted'));
  assert.ok(body.includes('a new issue is opened'), 'nothing reopens; the copy must not promise it');
  assert.ok(!/reopens/u.test(body));
  assert.ok(body.includes('defers the next alert to the next failing run'));
  assert.ok(body.includes('Put notes in comments'));
  assert.ok(/rewritten, with a comment, when a new failing run arrives or the\s+confidence changes/u.test(body), 'the copy names both rewrite causes');
});

test('the recovery comment names the run that recovered the lane', () => {
  const verdict = classify([run({ conclusion: 'success', hoursAgo: 0.1 })]);
  const comment = renderRecovery({ lane: LANE, verdict });
  assert.ok(comment.includes(verdict.lastSuccess.html_url));
  assert.ok(comment.includes(LANE.workflow));
});

test('rendering a recovery without a successful run behind it is a programming error', () => {
  assert.throws(() => renderRecovery({ lane: LANE, verdict: classify([]) }), /unknown/u);
  assert.throws(() => renderRecovery({ lane: LANE, verdict: classify([run({ conclusion: 'failure', hoursAgo: 1 })]) }));
});

test('rendering an alert for a healthy lane is a programming error', () => {
  assert.throws(() => renderAlert({ lane: LANE, verdict: classify([run({ conclusion: 'success', hoursAgo: 1 })]) }));
});

test('the marker round-trips the lane file, the latest failing run, and the confidence', () => {
  const verdict = classify([run({ conclusion: 'failure', hoursAgo: 0.1 }), run({ conclusion: 'failure', hoursAgo: 1 })]);
  const { body } = renderAlert({ lane: LANE, verdict });
  assert.deepEqual(parseMarker(body), {
    file: LANE.file,
    runId: String(verdict.latestRun.id),
    attempt: '1',
    confidence: 'confirmed',
  });
  assert.equal(parseMarker(`note\n${renderMarker({ lane: LANE, latestRun: verdict.latestRun, confidence: 'confirmed' })}`).runId, String(verdict.latestRun.id));
  assert.equal(parseMarker('no marker here'), null);
  assert.equal(parseMarker(null), null);
});

test('a re-run of the same failing run is a different failing run', () => {
  // A re-run keeps the run id. Without the attempt, a lane that recovered on a re-run and then
  // failed on the next re-run would match its own recovery-closed alert and never file again.
  const failing = run({ conclusion: 'failure', hoursAgo: 30 });
  const rerun = { ...failing, run_attempt: 3 };
  const markerOf = (latestRun) => parseMarker(renderMarker({ lane: LANE, latestRun, confidence: 'unconfirmed' }));
  assert.equal(markerOf(rerun).attempt, '3');
  assert.ok(sameFailingRun(markerOf(failing), markerOf({ ...failing })));
  assert.ok(!sameFailingRun(markerOf(failing), markerOf(rerun)), 'a later attempt is new');
  assert.ok(!sameFailingRun(markerOf(failing), markerOf(run({ conclusion: 'failure', hoursAgo: 1 }))));
  assert.ok(!sameFailingRun(null, markerOf(failing)), 'a missing marker never matches');
  assert.ok(monitor.includes('sameFailingRun('), 'the monitor compares failing runs through the helper');
});

test('alerts filed before the attempt was recorded are still recognized as attempt 1', () => {
  // Exact markers of alerts the monitor filed from `next` before it recorded the attempt.
  // Unrecognized, each would be duplicated and never commented on or closed.
  const lane = (file) => MONITORED_LANES.find((candidate) => candidate.file === file);
  const stack = lane('stack-npm-publish.yml');
  const sdk = lane('sdk-npm-publish.yml');
  const stackBody = 'alert\n<!-- post-merge-lane-monitor:stack-npm-publish.yml run:35139002461 confidence:confirmed -->';
  const sdkBody = 'alert\n<!-- post-merge-lane-monitor:sdk-npm-publish.yml run:35150354211 confidence:confirmed -->';
  assert.deepEqual(parseMarker(stackBody), {
    file: 'stack-npm-publish.yml',
    runId: '35139002461',
    attempt: '1',
    confidence: 'confirmed',
  });
  assert.equal(parseMarker(sdkBody).attempt, '1');
  assert.ok(isAlertFor(stack, { body: stackBody }));
  assert.ok(isAlertFor(sdk, { body: sdkBody }));
  assert.ok(!isAlertFor(sdk, { body: stackBody }), 'a legacy alert belongs to its own lane only');
  assert.ok(!isAlertFor(stack, { body: sdkBody }));

  const latest = { ...run({ conclusion: 'failure', hoursAgo: 1 }), id: 35139002461 };
  const fresh = (latestRun) => parseMarker(renderMarker({ lane: stack, latestRun, confidence: 'confirmed' }));
  assert.ok(sameFailingRun(parseMarker(stackBody), fresh(latest)), 'a still-latest legacy alert is not rewritten');
  assert.ok(!sameFailingRun(parseMarker(stackBody), fresh({ ...latest, run_attempt: 2 })), 'a re-run is new');
});

test('an alert is selected by its marker, never by title prefix, and never a pull request', () => {
  const verdict = classify([run({ conclusion: 'failure', hoursAgo: 0.1 }), run({ conclusion: 'failure', hoursAgo: 1 })]);
  const { title, body } = renderAlert({ lane: LANE, verdict });
  const other = MONITORED_LANES[1];
  const lookalike = { ...LANE, workflow: `${LANE.workflow} (arm64)`, file: 'operator-images-arm64.yml' };

  assert.ok(isAlertFor(LANE, { title, body }));
  assert.ok(!isAlertFor(other, { title, body }), 'another lane never matches this alert');
  assert.ok(!isAlertFor(lookalike, { title, body }), 'a lane whose name extends this one does not match by prefix');
  assert.ok(!isAlertFor(LANE, { title, body: 'the marker was edited away' }));
  assert.ok(!isAlertFor(LANE, { title: 'unrelated', body: null }));
  assert.ok(!isAlertFor(LANE, { title, body, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/1' } }));
  assert.ok(isAlertFor(LANE, { title: 'retitled by a human', body }), 'the title is display only');
});

test('an open alert is rewritten only for a new failing run or a changed confidence', () => {
  // Fixtures created earlier carry higher run numbers, so the newer run is made first.
  const newer = run({ conclusion: 'failure', hoursAgo: 0.05 });
  const latest = run({ conclusion: 'failure', hoursAgo: 0.1 });
  const confirmed = classify([latest, run({ conclusion: 'failure', hoursAgo: 1 })]);
  const { title, body } = renderAlert({ lane: LANE, verdict: confirmed });
  const plan = (issue, next = { title, body }) => planAlertUpdate({ issue, ...next });

  assert.equal(plan({ title, body }), 'current', 'a scheduled tick with nothing new is a no-op');
  assert.equal(
    plan({ title, body: `A human note.\n\n${body}` }),
    'current',
    'a note added to the body survives while the marker is intact',
  );
  const legacyBody = `older copy\n<!-- post-merge-lane-monitor:${LANE.file} run:${latest.id} confidence:confirmed -->`;
  assert.equal(plan({ title, body: legacyBody }), 'current', 'a legacy marker for the same attempt is current');

  assert.equal(plan({ title: 'retitled by a human', body }), 'retitle', 'a retitle is repaired without a comment');

  const newRun = renderAlert({ lane: LANE, verdict: classify([newer, latest]) });
  assert.equal(plan({ title, body }, newRun), 'rewrite', 'a new failing run is news');
  const rerun = renderAlert({
    lane: LANE,
    verdict: classify([{ ...latest, run_attempt: 2 }, run({ conclusion: 'failure', hoursAgo: 1 })]),
  });
  assert.equal(plan({ title, body }, rerun), 'rewrite', 'a failing re-run is news');
  const downgraded = renderAlert({
    lane: LANE,
    verdict: classify([{ ...latest, updated_at: new Date(NOW - 30 * HOUR).toISOString() }]),
  });
  assert.equal(parseMarker(downgraded.body).runId, String(latest.id), 'same failing run, different confidence');
  assert.equal(plan({ title, body }, downgraded), 'rewrite', 'a confidence change is news');
  assert.equal(plan({ title: 'retitled', body }, newRun), 'rewrite', 'a rewrite also restores the title');
});

/**
 * The `on:` block of a workflow, as `{ key: [lines under it] }` for each trigger at
 * two-space indent. A tiny line-based reader rather than a YAML dependency: this test runs
 * with bare `node --test` both pre-merge and as the monitor's first step.
 */
function triggersOf(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/u.test(line));
  if (start === -1) return null;
  const triggers = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    if (/^\s*(#|$)/u.test(line)) continue;
    const key = line.match(/^ {2}([A-Za-z_]+):/u);
    if (key) {
      current = key[1];
      triggers[current] = [];
      continue;
    }
    if (current) triggers[current].push(line);
  }
  return triggers;
}

/**
 * Branch patterns under `on.<key>.branches`, in flow (`[a, b]`) or block (`- a`) form; `null`
 * when there is no such trigger. A trigger with no branch or tag filter runs on every branch,
 * which reads as `['**']`; one filtered only by tags (or only by `branches-ignore`, which no
 * workflow here uses) names no branch.
 */
function triggerBranches(source, key = 'push') {
  const lines = triggersOf(source)?.[key];
  if (!lines) return null;
  const branches = [];
  let inList = false;
  let filtered = false;
  for (const line of lines) {
    if (/^ {4}(branches-ignore|tags|tags-ignore):/u.test(line)) filtered = true;
    const flow = line.match(/^ {4}branches:\s*\[([^\]]*)\]/u);
    if (flow) return flow[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean);
    if (/^ {4}branches:\s*$/u.test(line)) {
      inList = true;
      filtered = true;
      continue;
    }
    if (inList) {
      const item = line.match(/^ {5,}-\s*['"]?([^'"#\s]+)/u);
      if (item) branches.push(item[1]);
      else if (!/^\s*(#|$)/u.test(line)) inList = false;
    }
  }
  return filtered ? branches : ['**'];
}

const pushBranches = (source) => triggerBranches(source, 'push');

/** Whether a GitHub branch filter pattern (`*` within a segment, `**` across) matches `branch`. */
function branchMatches(pattern, branch) {
  const regex = pattern
    .split('**')
    .map((part) => part.split('*').map((text) => text.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${regex}$`, 'u').test(branch);
}

const PRE_MERGE = ['pull_request', 'pull_request_target', 'merge_group'];

/**
 * Every workflow that runs after merge to `branch` and has no pre-merge trigger: the monitor's
 * remit. That is a push trigger matching the branch, or a `workflow_run` trigger whose branch
 * filter names it (a chained lane such as npm-publish.yml). An unfiltered `workflow_run` takes
 * its branch from the upstream workflow, which this reader cannot resolve, so it is not counted.
 */
function postMergeOnlyLanes(branch) {
  return readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/u.test(file))
    .filter((file) => {
      const source = readFileSync(path.join(workflowsDir, file), 'utf8');
      const triggers = triggersOf(source);
      if (!triggers || PRE_MERGE.some((key) => key in triggers)) return false;
      const chained = triggerBranches(source, 'workflow_run') ?? [];
      return (
        (pushBranches(source) ?? []).some((pattern) => branchMatches(pattern, branch)) ||
        (!chained.includes('**') && chained.some((pattern) => branchMatches(pattern, branch)))
      );
    })
    .sort();
}

test('the push-trigger reader anchors under the push key and accepts both branches forms', () => {
  assert.deepEqual(pushBranches('on:\n  push:\n    branches: [next]\n  workflow_dispatch:\n'), ['next']);
  assert.deepEqual(pushBranches('on:\n  schedule:\n    - cron: "0 8 * * *"\n  push:\n    branches:\n      - main\n      - next\n\npermissions:\n'), ['main', 'next']);
  assert.equal(pushBranches('on:\n  workflow_run:\n    workflows: [CI]\n    branches: [next]\n'), null, 'a branches list under another trigger is not a push trigger');
  assert.deepEqual(pushBranches('on:\n  push:\n    paths:\n      - "x/**"\n'), ['**'], 'a push trigger without a branch filter runs on every branch');
  assert.deepEqual(pushBranches('on:\n  push:\n    tags: ["v*"]\n'), [], 'a tag-only push trigger names no branch');
  assert.deepEqual(triggerBranches('on:\n  workflow_run:\n    workflows: [CI]\n    branches: [next]\n', 'workflow_run'), ['next']);
  assert.ok(branchMatches('**', 'next') && branchMatches('ne*', 'next') && branchMatches('next', 'next'));
  assert.ok(!branchMatches('main', 'next') && !branchMatches('release/*', 'next') && !branchMatches('nex', 'next'));
  assert.ok(!('pull_request' in triggersOf('on:\n  push:\n    branches: [next]\n')));
  assert.ok('merge_group' in triggersOf('on:\n  push:\n    branches: [next]\n  merge_group:\n'));
});

test('every registered lane names a real workflow that is genuinely post-merge-only', () => {
  assert.ok(MONITORED_LANES.length > 0);
  for (const lane of MONITORED_LANES) {
    const file = path.join(workflowsDir, lane.file);
    assert.ok(existsSync(file), `${lane.file} must exist`);
    const source = readFileSync(file, 'utf8');
    assert.ok(
      new RegExp(`^name:\\s*${lane.workflow}\\s*$`, 'mu').test(source),
      `${lane.file} must be named "${lane.workflow}" — workflow_run matches on the name`,
    );
    const triggers = triggersOf(source);
    assert.ok(triggers, `${lane.file} must declare an on: block`);
    for (const key of PRE_MERGE) {
      assert.ok(!(key in triggers), `${lane.file} has pre-merge coverage (${key}) and is not a post-merge-only lane`);
    }
    const branches = pushBranches(source);
    assert.ok(branches, `${lane.file} must have a push trigger`);
    assert.ok(
      branches.some((pattern) => branchMatches(pattern, lane.branch)),
      `${lane.file} must push-trigger on ${lane.branch}, not ${JSON.stringify(branches)}`,
    );
    assert.ok(lane.staleArtifact.length > 0, `${lane.file} must say what goes stale when it stops publishing`);
  }
});

test('every post-merge-only lane on next is either registered or excluded on the record', () => {
  const lanes = postMergeOnlyLanes('next');
  assert.ok(lanes.length >= MONITORED_LANES.length, 'the enumeration must at least find the registered lanes');
  const registered = new Set(MONITORED_LANES.map((lane) => lane.file));
  const excluded = new Set(EXCLUDED_LANES.map((lane) => lane.file));
  for (const file of lanes) {
    assert.ok(
      registered.has(file) || excluded.has(file),
      `${file} runs only after merge to next and is neither in MONITORED_LANES nor in EXCLUDED_LANES`,
    );
    assert.ok(!(registered.has(file) && excluded.has(file)), `${file} is both registered and excluded`);
  }
  for (const lane of EXCLUDED_LANES) {
    assert.ok(existsSync(path.join(workflowsDir, lane.file)), `${lane.file} is excluded but does not exist`);
    assert.ok(lanes.includes(lane.file), `${lane.file} is excluded but is not a post-merge-only lane on next`);
    assert.ok(lane.reason.length > 0, `${lane.file} is excluded without a reason`);
    assert.ok(!MONITORED_LANES.some((registered) => registered.workflow === lane.workflow));
  }
  assert.ok(EXCLUDED_LANES.some((lane) => lane.file === 'main-next-ancestor-check.yml'));
});

test('no registered lane name is a prefix of another', () => {
  for (const a of MONITORED_LANES) {
    for (const b of MONITORED_LANES) {
      if (a !== b) assert.ok(!b.workflow.startsWith(a.workflow), `${b.workflow} extends ${a.workflow}`);
    }
  }
});

test('the monitor workflow subscribes to exactly the registered lanes', () => {
  const listed = monitor.match(/workflows:\s*\[([^\]]*)\]/u);
  assert.ok(listed, 'the monitor must declare a workflow_run workflows list');
  const names = listed[1].split(',').map((entry) => entry.trim()).filter(Boolean).sort();
  assert.deepEqual(names, MONITORED_LANES.map((lane) => lane.workflow).sort());
});

test('the monitor runs on a schedule and holds only read-plus-issues authority', () => {
  assert.ok(/^\s{2}schedule:/mu.test(monitor), 'the schedule is what bounds detection latency');
  assert.ok(/actions: read/u.test(monitor));
  assert.ok(/issues: write/u.test(monitor));
  assert.ok(!/packages: write/u.test(monitor) && !/contents: write/u.test(monitor));
  assert.ok(monitor.includes(ALERT_LABEL), 'the monitor must use the shared alert label');
  assert.ok(monitor.includes('post-merge-lane-health.test.mjs'), 'the monitor verifies its own decision logic');
});

test('the monitor selects alerts by marker, reads a full page, and closes only on health', () => {
  assert.ok(monitor.includes('isAlertFor('), 'alerts are selected through the marker helper');
  assert.ok(!monitor.includes('startsWith('), 'no title-prefix selection remains');
  assert.ok(monitor.includes('parseMarker('), 'a hand-closed alert is recognized by its marker');
  assert.ok(monitor.includes('planAlertUpdate('), 'an open alert is updated through the plan helper');
  assert.ok(!monitor.includes('canonical.title !== title'), 'a title difference alone never reaches the comment path');
  assert.ok(/per_page: 100,\s*\n\s*\}\);\s*\n\s*const verdict = classifyLane/u.test(monitor), 'the run window is the full page one request allows');
  assert.equal(RUN_WINDOW, 100, 'classifyLane and the monitor share the same page size');
  assert.ok(monitor.includes("verdict.state !== 'healthy'"), 'only a healthy verdict reaches the close loop');
});

test('lanes that already have a dedicated monitor are excluded on the record', () => {
  const npmPublish = EXCLUDED_LANES.find((lane) => lane.workflow === 'npm Publish');
  assert.ok(npmPublish, 'the registry must record why npm Publish is not listed here');
  assert.ok(/npm-publish-monitor\.yml/u.test(npmPublish.reason));
  assert.ok(!MONITORED_LANES.some((lane) => lane.workflow === 'npm Publish'));
});
