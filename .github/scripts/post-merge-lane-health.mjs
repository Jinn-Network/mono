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
// Scope: this monitor decides from the RUN-LEVEL conclusion only. A run that
// concludes `success` while its publishing job was skipped reads healthy here — the
// stack canary publish is gated on `vars.PLATFORM_CANARY_PUBLISH_ENABLED`
// (stack-npm-publish.yml, DR-2026-08-17-d), and while that flag is off the lane is
// deliberately not publishing rather than failing. Resolving jobs per run, the way
// npm-publish-monitor.yml does for one lane, is a separate decision (#4257).
//
// This module is pure so the classification and the issue body are unit-testable
// without GitHub; .github/workflows/post-merge-lane-monitor.yml is a thin driver.

/** Label carried by every alert this monitor opens. */
export const ALERT_LABEL = 'automated:post-merge-lane-failure';

/** Consecutive failing runs that make a failure self-evidently real. */
export const CONFIRM_AFTER_FAILURES = 2;

/**
 * Newest-run page the monitor reads (`per_page` in post-merge-lane-monitor.yml).
 * A returned list shorter than this is the lane's full history, so counts are exact
 * even when no success is in it.
 */
export const RUN_WINDOW = 100;

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
 * Every post-merge-only lane on `next` is either here or in `EXCLUDED_LANES` with its
 * reason; post-merge-lane-health.test.mjs enumerates the workflows and fails on one
 * that is in neither. Add a lane here and to the monitor's `workflow_run` list
 * together — the same test pins the two to each other.
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

/**
 * Post-merge-only lanes on `next` that this monitor deliberately does not watch, each
 * with the reason. A lane that turns out to be neither registered nor listed here fails
 * the registry test, so a new lane cannot slip past coverage unnoticed (#2809's blind spot).
 *
 * @type {ReadonlyArray<{workflow: string, file: string, reason: string}>}
 */
export const EXCLUDED_LANES = Object.freeze([
  Object.freeze({
    workflow: 'npm Publish',
    file: 'npm-publish.yml',
    reason:
      'Already has its own train-aware monitor in npm-publish-monitor.yml; two monitors filing ' +
      'against one lane would produce competing issues.',
  }),
  Object.freeze({
    workflow: 'main-next ancestor check',
    file: 'main-next-ancestor-check.yml',
    reason:
      'Publishes no mutable artifact, so nothing goes stale while it is red, and it files its own ' +
      'issue when it fails.',
  }),
]);

// A run whose conclusion is not one of these decides nothing. `cancelled` is how
// concurrency supersedes a run and `skipped` is how a path filter declines one;
// counting either as a failure would alert on healthy lanes, and counting either as
// a recovery would silently close a live alert.
const FAILING = new Set(['failure', 'timed_out', 'startup_failure']);
const DECISIVE = new Set(['success', ...FAILING]);

/** Stable per-lane title prefix; display only — alerts are identified by their marker. */
export function titlePrefixFor(lane) {
  return `[post-merge-lane-failure] ${lane.workflow}`;
}

// `attempt:` is optional because alerts filed before it was recorded omit it; those mean attempt 1.
const MARKER = /<!-- post-merge-lane-monitor:(\S+) run:(\d+) (?:attempt:(\d+) )?confidence:(\S+) -->/u;

/**
 * Machine marker written into every alert body. Keyed on the lane's file, which is
 * exact where a title prefix is only usually unambiguous, and naming the latest failing
 * run and its attempt so a later tick can tell a genuinely new failure from a re-render.
 * The attempt matters because a re-run keeps the run id.
 */
export function renderMarker({ lane, latestRun, confidence }) {
  return `<!-- post-merge-lane-monitor:${lane.file} run:${latestRun.id} attempt:${latestRun.run_attempt ?? 1} confidence:${confidence} -->`;
}

/** @returns {{file: string, runId: string, attempt: string, confidence: string} | null} */
export function parseMarker(body) {
  const match = typeof body === 'string' ? body.match(MARKER) : null;
  return match ? { file: match[1], runId: match[2], attempt: match[3] ?? '1', confidence: match[4] } : null;
}

/** Whether two parsed markers name the same attempt of the same failing run. */
export function sameFailingRun(a, b) {
  return Boolean(a && b) && a.runId === b.runId && a.attempt === b.attempt;
}

/**
 * How to bring an open alert up to date with a freshly rendered one. The marker names the
 * latest failing run attempt and the confidence, so a comment is posted (`rewrite`) only
 * when one of those changed. A title that differs on its own is display drift, repaired
 * without a comment and without touching the body (`retitle`). Anything else is `current`,
 * so a scheduled tick never churns and a note a human added to the body survives.
 * @returns {'current'|'retitle'|'rewrite'}
 */
export function planAlertUpdate({ issue, title, body }) {
  const existing = parseMarker(issue.body);
  const next = parseMarker(body);
  if (!sameFailingRun(existing, next) || existing.confidence !== next.confidence) return 'rewrite';
  return issue.title === title ? 'current' : 'retitle';
}

/**
 * Whether an issue from the alert-label listing is one of this lane's alerts. Matches on
 * the marker, never the title, and never a pull request: `issues.listForRepo` returns
 * both, and a pull request carrying the label must not be commented on or closed.
 */
export function isAlertFor(lane, issue) {
  if (issue.pull_request) return false;
  const marker = parseMarker(issue.body);
  return marker !== null && marker.file === lane.file;
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
 * `unknown` is a window with no decisive run in it — nothing to alert on, but nothing
 * that proves recovery either, so the driver leaves any open alert alone. It is kept
 * apart from `healthy`, which always names the successful run that earned it.
 *
 * `windowBounded` is whether the streak length and its first failure are known rather
 * than floors: either a success sits behind the streak, or the page is shorter than
 * `RUN_WINDOW` so the returned list is the whole history. The last-success row still
 * names a run only when one is in the window.
 *
 * @param {{lane: {branch: string}, runs: ReadonlyArray<object>, now: number}} input
 *   `runs` is any window of that lane's runs, in any order.
 * @returns {{state: 'healthy'|'unknown'|'wait'|'alert', confidence?: 'confirmed'|'unconfirmed',
 *   consecutiveFailures: number, observedRuns: number, windowBounded: boolean,
 *   latestRun?: object, firstFailure?: object, lastSuccess?: object}}
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
  const observedRuns = runs.length;
  if (!latestRun) {
    return { state: 'unknown', consecutiveFailures: 0, observedRuns, windowBounded: false };
  }
  if (latestRun.conclusion === 'success') {
    return { state: 'healthy', consecutiveFailures: 0, observedRuns, windowBounded: true, latestRun, lastSuccess };
  }

  const streak = [];
  for (const run of decisive) {
    if (!FAILING.has(run.conclusion)) break;
    streak.push(run);
  }
  const verdict = {
    consecutiveFailures: streak.length,
    observedRuns,
    // A success behind the streak, or a short page that is the whole history, makes
    // the streak length exact. A full page with no success may continue earlier, so
    // the count is a floor.
    windowBounded: lastSuccess !== undefined || observedRuns < RUN_WINDOW,
    latestRun,
    firstFailure: streak[streak.length - 1],
    lastSuccess,
  };

  if (streak.length >= CONFIRM_AFTER_FAILURES) {
    return { ...verdict, state: 'alert', confidence: 'confirmed' };
  }
  // A timestamp that cannot be parsed cannot prove the failure is fresh, so it is
  // treated as past the grace window: an early alert is recoverable, a lane that can
  // never alert is the silence this monitor exists to end.
  const observedAt = completedAt(latestRun);
  if (!Number.isFinite(observedAt) || now - observedAt >= GRACE_MS) {
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
  const { latestRun, firstFailure, lastSuccess, confidence, consecutiveFailures, observedRuns, windowBounded } =
    verdict;
  const count = windowBounded ? `${consecutiveFailures}` : `at least ${consecutiveFailures}`;
  const basis =
    confidence === 'confirmed'
      ? `**Confirmed** — ${count} consecutive failing runs on \`${lane.branch}\`. ` +
        'Repeated failure across separate commits is not an infrastructure blip.'
      : `**Unconfirmed** — one failing run, and no successful run on \`${lane.branch}\` in the ` +
        `${GRACE_MS / (60 * 60 * 1000)} hours since. It may still be a blip, but nothing has proved that.`;
  const windowNote = `the observed window holds the newest ${observedRuns} runs and did not reach a success`;

  const body = [
    `## ${lane.workflow} is failing on \`${lane.branch}\``,
    '',
    basis,
    '',
    '| | |',
    '|---|---|',
    `| Workflow | \`${lane.file}\` |`,
    `| Latest failing run | ${latestRun.html_url} (\`${latestRun.conclusion}\` at \`${latestRun.head_sha.slice(0, 8)}\`, ${day(latestRun)}) |`,
    windowBounded
      ? `| First failure of this streak | ${firstFailure.html_url} (${day(firstFailure)}) |`
      : `| Oldest failure in the observed window | ${firstFailure.html_url} (${day(firstFailure)}) — the streak may start earlier |`,
    lastSuccess
      ? `| Last successful run | ${lastSuccess.html_url} (\`${lastSuccess.head_sha.slice(0, 8)}\`, ${day(lastSuccess)}) |`
      : windowBounded
        ? `| Last successful run | None — the observed history has no success |`
        : `| Last successful run | Not in the observed window — ${windowNote} |`,
    '',
    '### What is stale while this is red',
    '',
    lane.staleArtifact,
    lastSuccess
      ? `The newest artifacts this lane published come from \`${lastSuccess.head_sha.slice(0, 8)}\` (${day(lastSuccess)}).`
      : windowBounded
        ? 'The observed history has no successful run, so this lane has not published a current artifact.'
        : `The published artifacts are older than the observed window reaches (${windowNote}); find the ` +
          'last successful run in the Actions tab.',
    '',
    '### Closing this',
    '',
    `Fix or re-run the lane. Only a later successful \`push\` run on \`${lane.branch}\` — a new push, or a`,
    're-run of a failed push run — closes this issue; `workflow_dispatch` runs are not counted.',
    'If the lane goes red again after that, a new issue is opened. Closing this by hand while the',
    'lane is still red defers the next alert to the next failing run or re-run. Put notes in comments: the',
    'body is rewritten, with a comment, when a new failing run arrives or the confidence changes, and the',
    'marker line below must stay.',
    '',
    renderMarker({ lane, latestRun, confidence }),
  ].join('\n');

  return { title: `${titlePrefixFor(lane)} failing on ${lane.branch}`, body };
}

/** Comment left when a lane recovers, immediately before its alert is closed. */
export function renderRecovery({ lane, verdict }) {
  if (verdict.state !== 'healthy') {
    throw new Error(`renderRecovery called for a ${verdict.state} lane: ${lane.workflow}`);
  }
  return `${lane.workflow} recovered on \`${lane.branch}\` in ${verdict.lastSuccess.html_url}. Closing.`;
}
