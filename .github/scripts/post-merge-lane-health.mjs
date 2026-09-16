// Decision logic for the post-merge lane monitor (#2812).
//
// Post-merge-only lanes on `next` publish to MUTABLE tags that consumers pull.
// A lane that stops publishing is indistinguishable from a lane with nothing to
// publish, so `Operator Images` stayed red for 47 consecutive runs across 25 days
// (2026-07-24 -> 2026-08-17, #2809) and was found only by an unrelated adversarial
// sweep. Nothing the lane itself emits reaches a human.
//
// The alerting channel is the one this repository already uses for unattended
// failures: a labelled Issue opened by a trusted monitor workflow that reads Actions
// metadata and never executes code from the monitored revision. Precedents:
// npm-publish-monitor.yml, indexer-monitor.yml, main-next-ancestor-check.yml.
//
// This module is pure so the classification and the issue body are unit-testable
// without GitHub; .github/workflows/post-merge-lane-monitor.yml is a thin driver.

/** Label carried by every alert this monitor opens. */
export const ALERT_LABEL = 'automated:post-merge-lane-failure';

/** Consecutive failing runs that make a failure self-evidently real. */
export const CONFIRM_AFTER_FAILURES = 2;

/**
 * How long a SINGLE unrecovered failure is tolerated before it alerts anyway.
 * A genuine blip is followed by a green run and never opens an issue; a real break
 * that nothing has pushed over still surfaces well inside one working day, since the
 * workflow re-evaluates every six hours.
 */
export const GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The lanes this monitor watches: every workflow that runs ONLY after merge to `next`
 * and has no pre-merge trigger, so no pull request can go red on its behalf.
 *
 * `npm Publish` is deliberately absent: it already has its own train-aware monitor in
 * .github/workflows/npm-publish-monitor.yml, and two monitors filing against one lane
 * would produce competing issues. Add a lane here and to the monitor's `workflow_run`
 * list together — post-merge-lane-health.test.mjs pins the two to each other.
 *
 * @type {ReadonlyArray<{workflow: string, file: string, branch: string, staleArtifact: string}>}
 */
export const MONITORED_LANES = Object.freeze([
  Object.freeze({
    workflow: 'Operator Images',
    file: 'operator-images.yml',
    branch: 'next',
    staleArtifact:
      'Hosted operators pull `ghcr.io/<owner>/operator-<harness>:next`, and Railway services pin ' +
      '`canary-<sha>`. While this lane is red those tags keep resolving to the last image it published.',
  }),
  Object.freeze({
    workflow: 'SDK npm Publish',
    file: 'sdk-npm-publish.yml',
    branch: 'next',
    staleArtifact: 'The SDK canary dist-tag keeps resolving to the last version this lane published.',
  }),
  Object.freeze({
    workflow: 'Layer Packages npm Publish',
    file: 'layer-npm-publish.yml',
    branch: 'next',
    staleArtifact:
      'The canary dist-tags for the layer packages keep resolving to the last versions this lane published.',
  }),
  Object.freeze({
    workflow: 'Stack npm Publish',
    file: 'stack-npm-publish.yml',
    branch: 'next',
    staleArtifact:
      'The canary dist-tags for the stack packages keep resolving to the last versions this lane published.',
  }),
]);

// A run whose conclusion is not one of these decides nothing. `cancelled` is how
// concurrency supersedes a run and `skipped` is how a path filter declines one;
// counting either as a failure would alert on healthy lanes, and counting either as
// a recovery would silently close a live alert.
const FAILING = new Set(['failure', 'timed_out', 'startup_failure']);
const DECISIVE = new Set(['success', ...FAILING]);

/** Stable per-lane title prefix: one open alert per lane, deduplicated by title. */
export function titlePrefixFor(lane) {
  return `[post-merge-lane-failure] ${lane.workflow}`;
}

function completedAt(run) {
  return Date.parse(run.updated_at || run.run_started_at || run.created_at);
}

function day(run) {
  const at = completedAt(run);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : 'unknown';
}

/**
 * Classify one lane's health from its recent runs.
 *
 * @param {{lane: {branch: string}, runs: ReadonlyArray<object>, now: number}} input
 *   `runs` is any window of that lane's runs, in any order.
 * @returns {{state: 'healthy'|'wait'|'alert', confidence?: 'confirmed'|'unconfirmed',
 *   consecutiveFailures: number, latestRun?: object, firstFailure?: object, lastSuccess?: object}}
 */
export function classifyLane({ lane, runs, now }) {
  const decisive = runs
    .filter(
      (run) =>
        run.status === 'completed' &&
        run.event === 'push' &&
        run.head_branch === lane.branch &&
        DECISIVE.has(run.conclusion),
    )
    .sort((a, b) => b.run_number - a.run_number);

  const lastSuccess = decisive.find((run) => run.conclusion === 'success');
  const latestRun = decisive[0];
  if (!latestRun || latestRun.conclusion === 'success') {
    return { state: 'healthy', consecutiveFailures: 0, latestRun, lastSuccess };
  }

  const streak = [];
  for (const run of decisive) {
    if (!FAILING.has(run.conclusion)) break;
    streak.push(run);
  }
  const verdict = {
    consecutiveFailures: streak.length,
    latestRun,
    firstFailure: streak[streak.length - 1],
    lastSuccess,
  };

  if (streak.length >= CONFIRM_AFTER_FAILURES) {
    return { ...verdict, state: 'alert', confidence: 'confirmed' };
  }
  const observedAt = completedAt(latestRun);
  if (Number.isFinite(observedAt) && now - observedAt >= GRACE_MS) {
    return { ...verdict, state: 'alert', confidence: 'unconfirmed' };
  }
  return { ...verdict, state: 'wait' };
}

/**
 * Render the alert issue. Every value comes from run data, never from the current
 * time, so a scheduled re-evaluation that observes no new run reproduces the same
 * body byte for byte and the issue does not churn.
 */
export function renderAlert({ lane, verdict }) {
  if (verdict.state !== 'alert') {
    throw new Error(`renderAlert called for a ${verdict.state} lane: ${lane.workflow}`);
  }
  const { latestRun, firstFailure, lastSuccess, confidence, consecutiveFailures } = verdict;
  const basis =
    confidence === 'confirmed'
      ? `**Confirmed** — ${consecutiveFailures} consecutive failing runs on \`${lane.branch}\`. ` +
        'Repeated failure across separate commits is not an infrastructure blip.'
      : `**Unconfirmed** — one failing run, and no successful run on \`${lane.branch}\` in the ` +
        `${GRACE_MS / (60 * 60 * 1000)} hours since. It may still be a blip, but nothing has proved that.`;

  const body = [
    `## ${lane.workflow} is failing on \`${lane.branch}\``,
    '',
    basis,
    '',
    '| | |',
    '|---|---|',
    `| Workflow | \`${lane.file}\` |`,
    `| Latest failing run | ${latestRun.html_url} (\`${latestRun.conclusion}\` at \`${latestRun.head_sha.slice(0, 8)}\`, ${day(latestRun)}) |`,
    `| First failure of this streak | ${firstFailure.html_url} (${day(firstFailure)}) |`,
    lastSuccess
      ? `| Last successful run | ${lastSuccess.html_url} (\`${lastSuccess.head_sha.slice(0, 8)}\`, ${day(lastSuccess)}) |`
      : '| Last successful run | No successful run in the observed window |',
    '',
    '### What is stale while this is red',
    '',
    lane.staleArtifact,
    lastSuccess
      ? `The newest artifacts this lane published come from \`${lastSuccess.head_sha.slice(0, 8)}\` (${day(lastSuccess)}).`
      : 'No successful run in the observed window, so the published artifacts are older than it reaches.',
    '',
    '### Closing this',
    '',
    'Fix or re-run the lane. Only a later successful run on this branch closes this issue;',
    'it reopens on its own if the lane goes red again.',
    '',
    `<!-- post-merge-lane-monitor:${lane.file} run:${latestRun.id} confidence:${confidence} -->`,
  ].join('\n');

  return { title: `${titlePrefixFor(lane)} failing on ${lane.branch}`, body };
}

/** Comment left when a lane recovers, immediately before its alert is closed. */
export function renderRecovery({ lane, verdict }) {
  const url = verdict.lastSuccess ? verdict.lastSuccess.html_url : 'a later run';
  return `${lane.workflow} recovered on \`${lane.branch}\` in ${url}. Closing.`;
}
