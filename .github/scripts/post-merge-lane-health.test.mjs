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
  planLaneReconcile,
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
const STACK = MONITORED_LANES.find((lane) => lane.file === 'stack-npm-publish.yml');
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

function classifyStack(runs, jobsByRunId, now = NOW) {
  return classifyLane({ lane: STACK, runs, now, jobsByRunId });
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

test('the Stack lane names stack-canary as its publishing job; the other lanes do not', () => {
  assert.equal(STACK.publishingJob, 'stack-canary');
  assert.equal(STACK.workflow, 'Stack npm Publish');
  const stackWorkflow = readFileSync(path.join(workflowsDir, STACK.file), 'utf8');
  // GitHub's job.name is the `name:` field, not the YAML key (`canary-publish`).
  assert.match(
    stackWorkflow,
    new RegExp(`^ {4}name: ${STACK.publishingJob}$`, 'mu'),
    `${STACK.file} must declare name: ${STACK.publishingJob} — that is the Actions job.name`,
  );
  for (const lane of MONITORED_LANES) {
    if (lane !== STACK) {
      assert.equal(lane.publishingJob, undefined, `${lane.workflow} must keep classifying from the run conclusion alone`);
    }
  }
});

test('a Stack success whose stack-canary job was skipped is unknown, not healthy', () => {
  const latest = run({ conclusion: 'success', hoursAgo: 1 });
  const verdict = classifyStack([latest], { [latest.id]: [{ name: 'stack-canary', conclusion: 'skipped' }] });
  assert.equal(verdict.state, 'unknown');
  assert.notEqual(verdict.state, 'healthy');
});

test('a Stack success whose matrix stack-canary job was skipped is unknown', () => {
  const latest = run({ conclusion: 'success', hoursAgo: 1 });
  const verdict = classifyStack(
    [latest],
    { [String(latest.id)]: [{ name: 'stack-canary (sealed-platform-v1)', conclusion: 'skipped' }] },
  );
  assert.equal(verdict.state, 'unknown');
});

test('a Stack success with a live stack-canary job is healthy', () => {
  const latest = run({ conclusion: 'success', hoursAgo: 1 });
  const verdict = classifyStack([latest], { [latest.id]: [{ name: 'stack-canary', conclusion: 'success' }] });
  assert.equal(verdict.state, 'healthy');
  assert.equal(verdict.lastSuccess, latest);
});

test('a Stack success whose matrix stack-canary jobs ran is healthy', () => {
  // stack-npm-publish.yml names the job `stack-canary` and matrices it, so GitHub
  // reports `stack-canary (<release_group>)`, never the bare name. A skipped matrix
  // job is also unknown when the name does not match (fail-closed), so that case
  // cannot prove the prefix matcher; a live matrix success can.
  const latest = run({ conclusion: 'success', hoursAgo: 1 });
  const verdict = classifyStack(
    [latest],
    {
      [latest.id]: [
        { name: 'canary-verification', conclusion: 'success' },
        { name: 'stack-canary (sealed-platform-v1)', conclusion: 'success' },
        { name: 'stack-canary (implementations-v1)', conclusion: 'success' },
      ],
    },
  );
  assert.equal(verdict.state, 'healthy');
  assert.equal(verdict.lastSuccess, latest);
});

test('a Stack success without a matching publishing job is unknown (fail-closed)', () => {
  const latest = run({ conclusion: 'success', hoursAgo: 1 });
  assert.equal(classifyStack([latest]).state, 'unknown', 'no jobsByRunId');
  assert.equal(classifyStack([latest], {}).state, 'unknown', 'run id missing from jobsByRunId');
  assert.equal(classifyStack([latest], { [latest.id]: [] }).state, 'unknown', 'empty job list');
  assert.equal(
    classifyStack([latest], { [latest.id]: [{ name: 'canary-verification', conclusion: 'success' }] }).state,
    'unknown',
    'unrelated job names',
  );
});

test('Operator Images success without jobsByRunId is still healthy', () => {
  assert.equal(classify([run({ conclusion: 'success', hoursAgo: 1 })]).state, 'healthy');
});

test('a skipped Stack success does not mask a later decisive failure as healthy', () => {
  const skipSuccess = run({ conclusion: 'success', hoursAgo: 0.1 });
  const failure = run({ conclusion: 'failure', hoursAgo: 2 });
  const verdict = classifyStack([skipSuccess, failure], {
    [skipSuccess.id]: [{ name: 'stack-canary', conclusion: 'skipped' }],
  });
  assert.notEqual(verdict.state, 'healthy');
  assert.equal(verdict.latestRun, failure);
  assert.equal(verdict.state, 'wait');
  assert.equal(verdict.lastSuccess, undefined);
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
  // The deferral decision compares through the helper: a closed alert for the first attempt
  // defers that attempt and files for the re-run.
  const closedAlerts = [{ number: 1, ...renderAlert({ lane: LANE, verdict: classify([failing]) }) }];
  const reconcile = (latestRun) =>
    planLaneReconcile({ lane: LANE, verdict: classify([latestRun]), openAlerts: [], closedAlerts })[0].kind;
  assert.equal(reconcile(failing), 'log', 'the same attempt defers to its closed alert');
  assert.equal(reconcile(rerun), 'create', 'a failing re-run files afresh');
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

// planLaneReconcile (#4260): every open/update/close decision the monitor makes, as data.
function reconcileFixtures() {
  // Fixtures created earlier carry higher run numbers, so the newest run is made first.
  const recovered = run({ conclusion: 'success', hoursAgo: 0.01 });
  const newer = run({ conclusion: 'failure', hoursAgo: 0.05 });
  const latest = run({ conclusion: 'failure', hoursAgo: 0.1 });
  const older = run({ conclusion: 'failure', hoursAgo: 1 });
  const alert = classify([latest, older]);
  const rendered = renderAlert({ lane: LANE, verdict: alert });
  const newRun = classify([newer, latest]);
  const healthy = classify([recovered, latest]);
  return { alert, rendered, newRun, healthy };
}

const plan = (input) => planLaneReconcile({ lane: LANE, openAlerts: [], closedAlerts: [], ...input });

test('reconcile: an alert verdict with no open or matching closed alert creates one', () => {
  const { alert, rendered } = reconcileFixtures();
  const otherLane = { number: 5, ...renderAlert({ lane: MONITORED_LANES[1], verdict: alert }) };
  assert.deepEqual(plan({ verdict: alert, openAlerts: [otherLane], closedAlerts: [otherLane] }), [
    { kind: 'create', title: rendered.title, body: rendered.body },
  ]);
});

test('reconcile: a closed alert naming the same failing run defers instead of filing', () => {
  const { alert, rendered, newRun } = reconcileFixtures();
  const marker = parseMarker(rendered.body);
  const closed = { number: 7, ...rendered };
  assert.deepEqual(plan({ verdict: alert, closedAlerts: [closed] }), [
    {
      kind: 'log',
      level: 'info',
      message: `${LANE.workflow}: alert #7 was closed for run ${marker.runId} attempt ${marker.attempt}; deferring to the next failing run.`,
    },
  ]);
  assert.equal(plan({ verdict: newRun, closedAlerts: [closed] })[0].kind, 'create', 'a new failing run files afresh');
});

test('reconcile: a current alert only logs, a stale one is rewritten, a retitled one is repaired', () => {
  const { alert, rendered, newRun } = reconcileFixtures();
  const open = { number: 9, ...rendered };
  assert.deepEqual(plan({ verdict: alert, openAlerts: [open] }), [
    { kind: 'log', level: 'info', message: `${LANE.workflow} alert #9 is current.` },
  ]);

  const fresh = renderAlert({ lane: LANE, verdict: newRun });
  assert.deepEqual(plan({ verdict: newRun, openAlerts: [open] }), [
    { kind: 'comment', issue: 9, body: fresh.body },
    { kind: 'update', issue: 9, fields: { title: fresh.title, body: fresh.body } },
    { kind: 'log', level: 'warning', message: `Updated ${LANE.workflow} alert #9.` },
  ]);

  assert.deepEqual(plan({ verdict: alert, openAlerts: [{ ...open, title: 'retitled' }] }), [
    { kind: 'update', issue: 9, fields: { title: rendered.title } },
    { kind: 'log', level: 'notice', message: `Restored the title of ${LANE.workflow} alert #9.` },
  ]);
});

test('reconcile: duplicates are consolidated into the lowest-numbered alert', () => {
  const { alert, rendered } = reconcileFixtures();
  const actions = plan({
    verdict: alert,
    openAlerts: [{ number: 30, ...rendered }, { number: 12, ...rendered }, { number: 20, ...rendered }],
  });
  assert.deepEqual(actions, [
    { kind: 'log', level: 'info', message: `${LANE.workflow} alert #12 is current.` },
    ...[20, 30].flatMap((issue) => [
      { kind: 'comment', issue, body: `Duplicate ${LANE.workflow} alert; consolidated into #12.` },
      { kind: 'close', issue, reason: 'not_planned' },
      { kind: 'log', level: 'notice', message: `Closed duplicate ${LANE.workflow} alert #${issue}.` },
    ]),
  ]);
});

test('reconcile: only a healthy verdict closes open alerts', () => {
  const { rendered, healthy } = reconcileFixtures();
  const openAlerts = [{ number: 4, ...rendered }, { number: 3, ...rendered }];
  assert.deepEqual(plan({ verdict: healthy, openAlerts }), [3, 4].flatMap((issue) => [
    { kind: 'comment', issue, body: renderRecovery({ lane: LANE, verdict: healthy }) },
    { kind: 'close', issue, reason: 'completed' },
    { kind: 'log', level: 'notice', message: `Closed ${LANE.workflow} alert #${issue}.` },
  ]));

  const wait = classify([run({ conclusion: 'failure', hoursAgo: 2 }), run({ conclusion: 'success', hoursAgo: 9 })]);
  for (const verdict of [wait, classify([])]) {
    assert.deepEqual(plan({ verdict, openAlerts }), [
      { kind: 'log', level: 'info', message: `${LANE.workflow}: ${verdict.state}; leaving 2 alert(s) open.` },
    ]);
    assert.deepEqual(plan({ verdict }), [
      { kind: 'log', level: 'info', message: `${LANE.workflow}: ${verdict.state}.` },
    ]);
  }
  assert.deepEqual(plan({ verdict: healthy }), [
    { kind: 'log', level: 'info', message: `${LANE.workflow}: healthy.` },
  ]);
});

test('reconcile: a skipped Stack success does not close an open Stack alert', () => {
  const skipSuccess = run({ conclusion: 'success', hoursAgo: 0.1 });
  const failing = classifyLane({
    lane: STACK,
    runs: [run({ conclusion: 'failure', hoursAgo: 1 }), run({ conclusion: 'failure', hoursAgo: 2 })],
    now: NOW,
  });
  const rendered = renderAlert({ lane: STACK, verdict: failing });
  const verdict = classifyStack([skipSuccess], {
    [skipSuccess.id]: [{ name: 'stack-canary', conclusion: 'skipped' }],
  });
  assert.equal(verdict.state, 'unknown');
  const actions = planLaneReconcile({
    lane: STACK,
    verdict,
    openAlerts: [{ number: 11, ...rendered }],
    closedAlerts: [],
  });
  assert.deepEqual(actions, [
    { kind: 'log', level: 'info', message: `${STACK.workflow}: unknown; leaving 1 alert(s) open.` },
  ]);
  assert.ok(!actions.some((action) => action.kind === 'close'));
});

test('reconcile: a pull request carrying the label is never acted on', () => {
  const { alert, rendered, healthy } = reconcileFixtures();
  const pr = { number: 2, ...rendered, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/2' } };
  assert.deepEqual(plan({ verdict: healthy, openAlerts: [pr] }), [
    { kind: 'log', level: 'info', message: `${LANE.workflow}: healthy.` },
  ]);
  assert.deepEqual(plan({ verdict: alert, openAlerts: [pr], closedAlerts: [pr] }), [
    { kind: 'create', title: rendered.title, body: rendered.body },
  ]);
});

/**
 * The `on:` block of a workflow, as `{ key: [lines under it] }` for each trigger at
 * two-space indent. A tiny line-based reader rather than a YAML dependency: this test runs
 * with bare `node --test` both pre-merge and as the monitor's first step.
 *
 * The single-line forms `on: push` and `on: [push, workflow_dispatch]` read as triggers with
 * no lines under them (#4604). Any other shape — a flow mapping, a quoted key, no `on:` at
 * all — is `null`, which the enumeration below refuses rather than skips.
 */
function triggersOf(source) {
  const lines = source.split('\n');
  for (const line of lines) {
    const inline = line.match(/^on:[ \t]+([^\s#{][^#]*?)\s*(?:#.*)?$/u);
    if (!inline) continue;
    const flow = inline[1].match(/^\[([^\]]*)\]$/u);
    const keys = flow ? flow[1].split(',') : [inline[1]];
    const names = keys.map((key) => key.trim().replace(/^(['"])(.*)\1$/u, '$2')).filter(Boolean);
    if (!names.every((name) => /^[A-Za-z_]+$/u.test(name))) return null;
    return Object.fromEntries(names.map((name) => [name, []]));
  }
  const start = lines.findIndex((line) => /^on:\s*(?:#.*)?$/u.test(line));
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
    .filter((file) => laneFromSource(file, readFileSync(path.join(workflowsDir, file), 'utf8'), branch))
    .sort();
}

/**
 * Whether one workflow source is a post-merge-only lane on `branch`. A workflow whose `on:`
 * this reader cannot parse throws rather than reading as "not a lane": skipping it would let a
 * new lane slip past the registry test unnoticed, the blind spot that test exists for (#4604).
 */
function laneFromSource(file, source, branch) {
  const triggers = triggersOf(source);
  assert.ok(triggers, `${file}: the trigger reader cannot parse its on: block; teach triggersOf the shape`);
  if (PRE_MERGE.some((key) => key in triggers)) return false;
  const chained = triggerBranches(source, 'workflow_run') ?? [];
  return (
    (pushBranches(source) ?? []).some((pattern) => branchMatches(pattern, branch)) ||
    (!chained.includes('**') && chained.some((pattern) => branchMatches(pattern, branch)))
  );
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

test('the trigger reader accepts single-line on: forms and returns null for any other shape', () => {
  // #4604: a scalar or flow-sequence `on:` read as null, and the enumeration skipped the file.
  assert.deepEqual(triggersOf('on: push\n'), { push: [] });
  assert.deepEqual(triggersOf('on: [push, workflow_dispatch]\n'), { push: [], workflow_dispatch: [] });
  assert.deepEqual(triggersOf('on:  # triggers\n  push:\n    branches: [next]\n'), { push: ['    branches: [next]'] });
  assert.deepEqual(pushBranches('on: push\n'), ['**']);
  assert.deepEqual(pushBranches("on: ['push']\n"), ['**']);
  assert.ok('pull_request' in triggersOf('on: [push, pull_request]\n'));
  // Shapes this reader does not parse must fail the enumeration, never drop the file from it.
  assert.equal(triggersOf('on: {push: {}}\n'), null);
  assert.equal(triggersOf('"on":\n  push:\n'), null);
  assert.equal(triggersOf('name: no triggers\n'), null);
  assert.throws(() => laneFromSource('flow.yml', 'on: {push: {}}\n', 'next'), /flow\.yml/u);
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

test('the monitor delegates every decision to planLaneReconcile and reads a full page', () => {
  // The driver performs API calls only (#4260); the decisions above are unit-tested here.
  // Fetching jobs for a lane.publishingJob is I/O (#4257), not a lifecycle decision.
  assert.ok(monitor.includes('planLaneReconcile('), 'the driver executes the planned actions');
  for (const decision of ['isAlertFor(', 'parseMarker(', 'planAlertUpdate(', 'sameFailingRun(', 'verdict.state', 'startsWith(']) {
    assert.ok(!monitor.includes(decision), `the driver makes no lifecycle decision of its own (${decision})`);
  }
  assert.ok(/switch \(action\.kind\)/u.test(monitor), 'the driver dispatches on the action kind');
  assert.ok(
    /listWorkflowRuns\(\{[\s\S]*?per_page: 100,\s*\n\s*\}\);/u.test(monitor),
    'the run window is the full page one request allows',
  );
  assert.equal(RUN_WINDOW, 100, 'classifyLane and the monitor share the same page size');
  assert.ok(monitor.includes('listJobsForWorkflowRun'), 'publishing-job lanes fetch jobs for success runs');
  assert.ok(/lane\.publishingJob/u.test(monitor), 'job fetches are gated on the lane registry, not a driver rule');
  assert.ok(
    /classifyLane\(\{[\s\S]*?jobsByRunId/u.test(monitor),
    'jobsByRunId is passed into classifyLane; the driver does not interpret jobs',
  );
});

test('lanes that already have a dedicated monitor are excluded on the record', () => {
  const npmPublish = EXCLUDED_LANES.find((lane) => lane.workflow === 'npm Publish');
  assert.ok(npmPublish, 'the registry must record why npm Publish is not listed here');
  assert.ok(/npm-publish-monitor\.yml/u.test(npmPublish.reason));
  assert.ok(!MONITORED_LANES.some((lane) => lane.workflow === 'npm Publish'));
});
