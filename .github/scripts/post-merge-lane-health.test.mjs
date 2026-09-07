import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALERT_LABEL,
  CONFIRM_AFTER_FAILURES,
  GRACE_MS,
  MONITORED_LANES,
  classifyLane,
  renderAlert,
  renderRecovery,
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
function run({ conclusion, hoursAgo, event = 'push', branch = 'next', status = 'completed' }) {
  const number = (nextRunNumber -= 1);
  const at = new Date(NOW - hoursAgo * HOUR).toISOString();
  return {
    id: 90000 + number,
    run_number: number,
    status,
    conclusion,
    event,
    head_branch: branch,
    head_sha: `${number}`.repeat(8).slice(0, 40),
    html_url: `https://github.com/o/r/actions/runs/${90000 + number}`,
    created_at: at,
    run_started_at: at,
    updated_at: at,
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

test('no completed runs at all is healthy, not an alert', () => {
  assert.equal(classify([]).state, 'healthy');
  assert.equal(classify([run({ conclusion: null, status: 'in_progress', hoursAgo: 1 })]).state, 'healthy');
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
    verdict: classify([run({ conclusion: 'failure', hoursAgo: 0.1 }), run({ conclusion: 'failure', hoursAgo: 1 })]),
  }).body;
  assert.ok(/confirmed/i.test(confirmed));
  assert.ok(confirmed.includes('2 consecutive'));

  const unconfirmed = renderAlert({
    lane: LANE,
    verdict: classify([run({ conclusion: 'failure', hoursAgo: GRACE_MS / HOUR + 1 })]),
  }).body;
  assert.ok(/unconfirmed/i.test(unconfirmed));
});

test('a lane with no successful run in the observed window says so rather than inventing one', () => {
  const { body } = renderAlert({
    lane: LANE,
    verdict: classify([run({ conclusion: 'failure', hoursAgo: 0.1 }), run({ conclusion: 'failure', hoursAgo: 1 })]),
  });
  assert.ok(body.includes('No successful run'));
});

test('the recovery comment names the run that recovered the lane', () => {
  const verdict = classify([run({ conclusion: 'success', hoursAgo: 0.1 })]);
  const comment = renderRecovery({ lane: LANE, verdict });
  assert.ok(comment.includes(verdict.lastSuccess.html_url));
  assert.ok(comment.includes(LANE.workflow));
});

test('rendering an alert for a healthy lane is a programming error', () => {
  assert.throws(() => renderAlert({ lane: LANE, verdict: classify([run({ conclusion: 'success', hoursAgo: 1 })]) }));
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
    assert.ok(
      !/^\s{2}pull_request:/mu.test(source) && !/^\s{2}merge_group:/mu.test(source),
      `${lane.file} has pre-merge coverage and is not a post-merge-only lane`,
    );
    assert.ok(
      new RegExp(`branches:\\s*\\[[^\\]]*\\b${lane.branch}\\b`, 'u').test(source),
      `${lane.file} must push-trigger on ${lane.branch}`,
    );
    assert.ok(lane.staleArtifact.length > 0, `${lane.file} must say what goes stale when it stops publishing`);
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

test('lanes that already have a dedicated monitor are excluded on the record', () => {
  const source = readFileSync(path.join(scriptsDir, 'post-merge-lane-health.mjs'), 'utf8');
  assert.ok(
    /npm Publish/u.test(source) && /npm-publish-monitor\.yml/u.test(source),
    'the registry must record why npm Publish is not listed here',
  );
  assert.ok(!MONITORED_LANES.some((lane) => lane.workflow === 'npm Publish'));
});
