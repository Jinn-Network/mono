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
// Scope: this monitor decides from the RUN-LEVEL conclusion, except on a lane that
// names a `publishingJob`. There a `success` is decisive only when that job actually
// ran: a skipped `stack-canary` (the flag-off path in stack-npm-publish.yml,
// DR-2026-08-17-d) is non-decisive, the same as a cancelled run or a path-filter
// skip. A success with no job list, an empty list, or no matching job is also
// non-decisive (fail-closed). Failures, timeouts, and startup_failure stay
// decisive without jobs. The driver fetches those jobs; this module classifies.
//
// This module is pure so the classification, the issue body, and every
// open/update/close decision are unit-testable without GitHub.
// .github/workflows/post-merge-lane-monitor.yml is a thin driver: it fetches runs
// and alerts, asks `planLaneReconcile` what to do, and performs those API calls in
// order without deciding anything itself (#4260).

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
 * @type {ReadonlyArray<{workflow: string, file: string, branch: string, staleArtifact: string,
 *   publishingJob?: string}>}
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
    publishingJob: 'stack-canary',
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

function jobsForRun(jobsByRunId, runId) {
  if (jobsByRunId == null) return undefined;
  if (jobsByRunId instanceof Map) {
    return jobsByRunId.get(runId) ?? jobsByRunId.get(String(runId));
  }
  return jobsByRunId[runId] ?? jobsByRunId[String(runId)];
}

function publishingJobRan(jobs, publishingJob) {
  if (!Array.isArray(jobs)) return false;
  const matrixPrefix = `${publishingJob} (`;
  return jobs.some(
    (job) =>
      (job.name === publishingJob || (typeof job.name === 'string' && job.name.startsWith(matrixPrefix))) &&
      job.conclusion !== 'skipped',
  );
}

function isDecisiveRun(run, lane, jobsByRunId) {
  if (run.status !== 'completed' || run.event !== 'push' || run.head_branch !== lane.branch) return false;
  if (!DECISIVE.has(run.conclusion)) return false;
  if (FAILING.has(run.conclusion)) return true;
  if (!lane.publishingJob) return true;
  return publishingJobRan(jobsForRun(jobsByRunId, run.id), lane.publishingJob);
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
 * @param {{lane: {branch: string, publishingJob?: string}, runs: ReadonlyArray<object>, now: number,
 *   jobsByRunId?: Map<string|number, ReadonlyArray<object>> | Record<string, ReadonlyArray<object>>}} input
 *   `runs` is any window of that lane's runs, in any order. `jobsByRunId` is consulted only
 *   when `lane.publishingJob` is set; run ids may be numbers or strings.
 * @returns {{state: 'healthy'|'unknown'|'wait'|'alert', confidence?: 'confirmed'|'unconfirmed',
 *   consecutiveFailures: number, observedRuns: number, windowBounded: boolean,
 *   latestRun?: object, firstFailure?: object, lastSuccess?: object}}
 */
export function classifyLane({ lane, runs, now, jobsByRunId }) {
  const decisive = runs
    .filter((run) => isDecisiveRun(run, lane, jobsByRunId))
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

const log = (level, message) => ({ kind: 'log', level, message });

/**
 * Every action one lane's reconciliation takes, in the order the driver must perform them
 * (#4260). The driver executes each and decides nothing:
 *
 * - `{ kind: 'log', level: 'info'|'notice'|'warning', message }`
 * - `{ kind: 'comment', issue, body }`
 * - `{ kind: 'close', issue, reason: 'completed'|'not_planned' }`
 * - `{ kind: 'update', issue, fields: { title?, body? } }`
 * - `{ kind: 'create', title, body }` — the driver adds the alert label and logs the new number.
 *
 * `openAlerts` is the full open listing for the alert label and `closedAlerts` the most recently
 * updated closed page, both raw: alerts are identified here by their marker, never by title,
 * because a title prefix is only unambiguous while no lane name extends another, and the listing
 * also returns pull requests, which must never be treated as alerts. The lowest-numbered open
 * alert is canonical; any others are duplicates.
 *
 * @param {{lane: object, verdict: object, openAlerts: ReadonlyArray<object>,
 *   closedAlerts: ReadonlyArray<object>}} input
 * @returns {Array<object>}
 */
export function planLaneReconcile({ lane, verdict, openAlerts, closedAlerts }) {
  const open = openAlerts.filter((issue) => isAlertFor(lane, issue)).sort((a, b) => a.number - b.number);

  if (verdict.state !== 'alert') {
    if (open.length === 0) return [log('info', `${lane.workflow}: ${verdict.state}.`)];
    // Only a proven recovery closes an alert. A `wait` verdict is a lane that is still red
    // and merely not yet re-confirmed, and an `unknown` verdict is a window with no decisive
    // run in it; neither is evidence of health.
    if (verdict.state !== 'healthy') {
      return [log('info', `${lane.workflow}: ${verdict.state}; leaving ${open.length} alert(s) open.`)];
    }
    return open.flatMap((alert) => [
      { kind: 'comment', issue: alert.number, body: renderRecovery({ lane, verdict }) },
      { kind: 'close', issue: alert.number, reason: 'completed' },
      log('notice', `Closed ${lane.workflow} alert #${alert.number}.`),
    ]);
  }

  const { title, body } = renderAlert({ lane, verdict });
  const marker = parseMarker(body);
  const [canonical, ...duplicates] = open;
  if (!canonical) {
    // A hand-closed alert whose marker still names the current failing run attempt has
    // already been seen by a human: filing again now would only re-post it every tick. The
    // next failing run, or a failing re-run, changes the marker and files afresh. A
    // recovery-closed match is the same contract: the closed issue's marker must name this
    // tick's failing run attempt. That is not "whenever the success that closed it no longer
    // decides." If that success is a re-run of the alerted run and is itself re-run (in
    // progress or cancelled), an older failure can become latest and file a short-lived new
    // alert; the next healthy tick closes it. Staying quiet is right only when the current
    // failing attempt is still the one the closed alert named.
    //
    // Only the page of closed alerts the driver read is searched: if more than that were
    // updated after the matching one, the deferral is missed and one extra alert is filed.
    // With a 100-issue page that needs 100 alert updates within one failing run's life.
    const closed = closedAlerts.find(
      (issue) => isAlertFor(lane, issue) && sameFailingRun(parseMarker(issue.body), marker),
    );
    if (closed) {
      return [
        log(
          'info',
          `${lane.workflow}: alert #${closed.number} was closed for run ${marker.runId} attempt ${marker.attempt}; deferring to the next failing run.`,
        ),
      ];
    }
    return [{ kind: 'create', title, body }];
  }

  // A comment is posted only when the latest failing run attempt or the confidence changed;
  // a human retitle is repaired silently. A note a human added to the body survives until
  // one of those changes rewrites it.
  const actions = [];
  const update = planAlertUpdate({ issue: canonical, title, body });
  if (update === 'rewrite') {
    actions.push(
      { kind: 'comment', issue: canonical.number, body },
      { kind: 'update', issue: canonical.number, fields: { title, body } },
      log('warning', `Updated ${lane.workflow} alert #${canonical.number}.`),
    );
  } else if (update === 'retitle') {
    actions.push(
      { kind: 'update', issue: canonical.number, fields: { title } },
      log('notice', `Restored the title of ${lane.workflow} alert #${canonical.number}.`),
    );
  } else {
    actions.push(log('info', `${lane.workflow} alert #${canonical.number} is current.`));
  }

  for (const duplicate of duplicates) {
    actions.push(
      {
        kind: 'comment',
        issue: duplicate.number,
        body: `Duplicate ${lane.workflow} alert; consolidated into #${canonical.number}.`,
      },
      { kind: 'close', issue: duplicate.number, reason: 'not_planned' },
      log('notice', `Closed duplicate ${lane.workflow} alert #${duplicate.number}.`),
    );
  }
  return actions;
}
