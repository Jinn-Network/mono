import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(scriptsDir, '..', 'workflows');
const publish = readFileSync(path.join(workflowsDir, 'npm-publish.yml'), 'utf8');
const monitorPath = path.join(workflowsDir, 'npm-publish-monitor.yml');
const monitor = readFileSync(monitorPath, 'utf8');

function githubScriptForStep(workflow, stepName) {
  const lines = workflow.split('\n');
  const stepAt = lines.findIndex((line) => line.includes(`name: ${stepName}`));
  assert.notEqual(stepAt, -1, `step "${stepName}" must exist`);
  const scriptAt = lines.findIndex(
    (line, index) => index > stepAt && /^\s+script: \|$/.test(line),
  );
  assert.notEqual(scriptAt, -1, `step "${stepName}" must have a block script`);
  const firstCodeAt = lines.findIndex(
    (line, index) => index > scriptAt && line.trim().length > 0,
  );
  const indent = lines[firstCodeAt].match(/^\s*/)[0].length;
  const code = [];
  for (let index = firstCodeAt; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/)[0].length < indent) break;
    code.push(line.slice(Math.min(indent, line.length)));
  }
  return code.join('\n');
}

function monitorHarness({
  triggerRun,
  runs,
  jobsByRun,
  issues = [],
  beforeFirstIssueList,
}) {
  const calls = [];
  let issueListCalls = 0;
  const actions = {
    listWorkflowRuns: async (args) => runs.filter(
      (run) => (!args.event || run.event === args.event) && (!args.status || run.status === args.status),
    ),
    listJobsForWorkflowRun: async (args) => jobsByRun[args.run_id] ?? [],
    getWorkflow: async () => ({ data: { id: 7 } }),
  };
  const issuesApi = {
    listForRepo: async (args) => {
      const matching = issues.filter(
        (issue) => issue.state === args.state && issue.labels.includes(args.labels),
      );
      issueListCalls += 1;
      if (issueListCalls === 1 && beforeFirstIssueList) {
        await beforeFirstIssueList();
      }
      return matching;
    },
    createLabel: async (args) => calls.push({ method: 'createLabel', args }),
    createComment: async (args) => calls.push({ method: 'createComment', args }),
    update: async (args) => {
      calls.push({ method: 'update', args });
      const issue = issues.find((candidate) => candidate.number === args.issue_number);
      if (issue) Object.assign(issue, args);
      return { data: issue };
    },
    create: async (args) => {
      calls.push({ method: 'create', args });
      const issue = {
        number: Math.max(100, ...issues.map((candidate) => candidate.number)) + 1,
        title: args.title,
        body: args.body,
        state: 'open',
        labels: args.labels,
      };
      issues.push(issue);
      return { data: issue };
    },
  };
  const github = {
    rest: { actions, issues: issuesApi },
    paginate: async (fn, args) => fn(args),
  };
  const context = {
    payload: { workflow_run: triggerRun },
    repo: { owner: 'Jinn-Network', repo: 'mono' },
  };
  const core = new Proxy({}, { get: () => () => {} });
  return { github, context, core, calls, issues };
}

async function runCompletedMonitor(harness) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const script = githubScriptForStep(monitor, 'Reconcile train-specific alert');
  await new AsyncFunction('github', 'context', 'core', script)(
    harness.github,
    harness.context,
    harness.core,
  );
}

async function runHungMonitor(harness, train = 'canary') {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const script = githubScriptForStep(monitor, 'Alert on overlong active runs');
  await new AsyncFunction('github', 'context', 'core', 'process', script)(
    harness.github,
    harness.context,
    harness.core,
    { env: { HUNG_AFTER_MINUTES: '105', TRAIN: train } },
  );
}

test('publish checks out and verifies the exact build commit before packaging', () => {
  assert.match(
    publish,
    /ref: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.event_name == 'workflow_dispatch' && inputs\.release_sha \|\| github\.sha \}\}/,
  );

  const verifyAt = publish.indexOf('name: Verify exact publish commit');
  const installAt = publish.indexOf('run: yarn install --immutable');
  const packageAt = publish.indexOf('name: Publish canary');
  assert.ok(verifyAt >= 0, 'exact-commit verification step must exist');
  assert.ok(verifyAt < installAt, 'exact-commit verification must precede dependency installation');
  assert.ok(verifyAt < packageAt, 'exact-commit verification must precede publishing');

  const verification = publish.slice(verifyAt, installAt);
  assert.match(verification, /git rev-parse HEAD/);
  assert.match(verification, /JINN_BUILD_COMMIT/);
  assert.match(verification, /exit 1/);
});

test('stable publishing is recoverable and waits for the registry before acceptance', () => {
  const existingAt = publish.indexOf('name: Check immutable client package');
  const recheckAt = publish.indexOf('name: Recheck immutable stable client package');
  const stablePublishAt = publish.indexOf('name: Publish stable');
  const waitAt = publish.indexOf('name: Wait for stable client tarball');
  const stableAcceptanceAt = publish.indexOf('name: Registry consumer acceptance (stable)');

  assert.ok(existingAt >= 0, 'an immutable-package recovery guard must exist');
  assert.ok(recheckAt > existingAt, 'stable state must be rechecked after long-running gates');
  assert.ok(stablePublishAt > recheckAt, 'the final registry recheck must precede stable publish');
  assert.ok(waitAt > stablePublishAt, 'registry propagation wait must follow stable publish');
  assert.ok(
    stableAcceptanceAt > waitAt,
    'stable registry acceptance must not run before the package tarball is available',
  );

  const existingStep = publish.slice(existingAt, publish.indexOf('- run: yarn typecheck'));
  assert.match(existingStep, /PACKAGE_SPEC:/);
  assert.match(existingStep, /npm view "\$\{PACKAGE_SPEC\}" gitHead/);
  assert.match(existingStep, /JINN_BUILD_COMMIT/);
  assert.match(existingStep, /published=true/);
  assert.match(existingStep, /published=false/);

  const recheckStep = publish.slice(recheckAt, stablePublishAt);
  assert.match(recheckStep, /npm view "\$\{PACKAGE_SPEC\}" gitHead/);
  assert.match(recheckStep, /JINN_BUILD_COMMIT/);
  assert.match(recheckStep, /published=true/);
  assert.match(recheckStep, /published=false/);

  const stablePublishStep = publish.slice(stablePublishAt, waitAt);
  assert.match(
    stablePublishStep,
    /steps\.stable_existing\.outputs\.published != 'true'/,
    'a matching previously published immutable version must be skipped on recovery',
  );
});

test('publish alerts are handled outside the publish job', () => {
  assert.doesNotMatch(publish, /name: Alert on publish failure/);
  assert.doesNotMatch(publish, /name: Close publish-failure alert on success/);

  assert.match(monitor, /workflow_run:/);
  assert.match(monitor, /workflows: \['npm Publish'\]/);
  assert.match(monitor, /types: \[completed\]/);
  assert.match(monitor, /schedule:/);
  assert.match(monitor, /actions: read/);
  assert.match(monitor, /issues: write/);
  assert.doesNotMatch(monitor, /actions\/checkout/);
  assert.doesNotMatch(monitor, /contents: write/);
  assert.doesNotMatch(monitor, /id-token: write/);
});

test('monitor state is train-specific and rejects stale completion events', () => {
  assert.match(monitor, /npm-publish-\$\{train\}-failure/);
  assert.match(monitor, /latestObserved\.status !== 'completed'/);
  assert.match(monitor, /const targetRun = latestObserved/);
  assert.match(monitor, /job\.conclusion !== 'skipped'/);
  assert.match(monitor, /cancel-in-progress: false/);
  assert.match(monitor, /github\.event\.workflow_run\.event == 'push' && 'canary' \|\| 'stable'/);
  assert.match(
    monitor,
    /group: npm-publish-monitor-\$\{\{ matrix\.train \}\}/,
    'each watchdog train must share the completion reconciler concurrency group',
  );
  assert.match(monitor, /matrix:\s*\n\s+train: \[canary, stable\]/);
});

test('monitor detects runs that outlive the bounded publish timeout', () => {
  assert.match(monitor, /HUNG_AFTER_MINUTES: '105'/);
  assert.match(
    monitor,
    /const statuses = \['in_progress', 'queued', 'waiting', 'requested', 'pending'\]/,
  );
  assert.match(monitor, /publish appears hung/i);
});

test('a canary recovery closes only the canary alert', async () => {
  const run = {
    id: 11,
    run_number: 11,
    workflow_id: 7,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'a'.repeat(40),
    html_url: 'https://example.test/runs/11',
  };
  const canary = {
    number: 41,
    title: '[npm-publish-canary-failure] failure',
    body: 'old canary failure',
    state: 'open',
    labels: ['automated:npm-publish-canary-failure'],
  };
  const stable = {
    number: 42,
    title: '[npm-publish-stable-failure] failure',
    body: 'stable failure',
    state: 'open',
    labels: ['automated:npm-publish-stable-failure'],
  };
  const harness = monitorHarness({
    triggerRun: run,
    runs: [run],
    jobsByRun: { 11: [{ name: 'Publish package', conclusion: 'success' }] },
    issues: [canary, stable],
  });

  await runCompletedMonitor(harness);

  assert.equal(canary.state, 'closed');
  assert.equal(stable.state, 'open');
  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'update').map((call) => call.args.issue_number),
    [41],
  );
});

test('an older success cannot close a newer failed run on the same train', async () => {
  const olderSuccess = {
    id: 20,
    run_number: 20,
    workflow_id: 7,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'b'.repeat(40),
    html_url: 'https://example.test/runs/20',
  };
  const newerFailure = {
    ...olderSuccess,
    id: 21,
    run_number: 21,
    conclusion: 'failure',
    head_sha: 'c'.repeat(40),
    html_url: 'https://example.test/runs/21',
  };
  const alert = {
    number: 43,
    title: '[npm-publish-canary-failure] previous failure',
    body: 'previous run',
    state: 'open',
    labels: ['automated:npm-publish-canary-failure'],
  };
  const harness = monitorHarness({
    triggerRun: olderSuccess,
    runs: [olderSuccess, newerFailure],
    jobsByRun: {
      20: [{ name: 'Publish package', conclusion: 'success' }],
      21: [{ name: 'Publish package', conclusion: 'failure' }],
    },
    issues: [alert],
  });

  await runCompletedMonitor(harness);

  assert.equal(alert.state, 'open');
  assert.match(alert.body, /npm-publish-monitor-run:21/);
  assert.ok(!harness.calls.some(
    (call) => call.method === 'update' && call.args.state === 'closed',
  ));
});

test('a skipped newer release wakes reconciliation of the previous real stable failure', async () => {
  const failed = {
    id: 30,
    run_number: 30,
    workflow_id: 7,
    event: 'release',
    status: 'completed',
    conclusion: 'failure',
    head_sha: 'd'.repeat(40),
    html_url: 'https://example.test/runs/30',
  };
  const skipped = {
    ...failed,
    id: 31,
    run_number: 31,
    conclusion: 'success',
    head_sha: 'e'.repeat(40),
    html_url: 'https://example.test/runs/31',
  };
  const harness = monitorHarness({
    triggerRun: skipped,
    runs: [failed, skipped],
    jobsByRun: {
      30: [{ name: 'Publish package', conclusion: 'failure' }],
      31: [{ name: 'Publish package', conclusion: 'skipped' }],
    },
  });

  await runCompletedMonitor(harness);

  const created = harness.calls.find((call) => call.method === 'create');
  assert.equal(created.args.labels[0], 'automated:npm-publish-stable-failure');
  assert.match(created.args.body, /npm-publish-monitor-run:30/);
});

test('the external watchdog alerts on a canary run beyond the publish timeout', async () => {
  const hung = {
    id: 40,
    run_number: 40,
    workflow_id: 7,
    event: 'push',
    status: 'in_progress',
    conclusion: null,
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    head_sha: 'f'.repeat(40),
    html_url: 'https://example.test/runs/40',
  };
  const harness = monitorHarness({
    triggerRun: hung,
    runs: [hung],
    jobsByRun: {},
  });

  await runHungMonitor(harness);

  const created = harness.calls.find((call) => call.method === 'create');
  assert.equal(created.args.labels[0], 'automated:npm-publish-canary-failure');
  assert.match(created.args.body, /appears hung/);
  assert.match(created.args.body, /npm-publish-monitor-run:40/);
});

test('a scheduled watchdog repairs a dropped completion event without another completion wake-up', async () => {
  const failed = {
    id: 45,
    run_number: 45,
    workflow_id: 7,
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    head_sha: '0'.repeat(40),
    html_url: 'https://example.test/runs/45',
  };
  const harness = monitorHarness({
    triggerRun: failed,
    runs: [failed],
    jobsByRun: {
      45: [{ name: 'Publish package', conclusion: 'failure' }],
    },
  });

  // GitHub concurrency may replace a pending completion consumer with this
  // scheduled watchdog. The surviving job must make the completion harmless
  // to drop, without relying on a later artificial completion event.
  await runHungMonitor(harness);

  const created = harness.calls.find((call) => call.method === 'create');
  assert.ok(created, 'the surviving watchdog must reconcile the failed completion');
  assert.equal(created.args.labels[0], 'automated:npm-publish-canary-failure');
  assert.match(created.args.body, /npm-publish-monitor-run:45/);
  assert.doesNotMatch(created.args.body, /appears hung/);
});

test('a scheduled watchdog closes a stale alert after a dropped successful completion event', async () => {
  const success = {
    id: 46,
    run_number: 46,
    workflow_id: 7,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    head_sha: '9'.repeat(40),
    html_url: 'https://example.test/runs/46',
  };
  const alert = {
    number: 46,
    title: '[npm-publish-canary-failure] previous failure',
    body: 'previous run',
    state: 'open',
    labels: ['automated:npm-publish-canary-failure'],
  };
  const harness = monitorHarness({
    triggerRun: success,
    runs: [success],
    jobsByRun: {
      46: [{ name: 'Publish package', conclusion: 'success' }],
    },
    issues: [alert],
  });

  await runHungMonitor(harness);

  assert.equal(alert.state, 'closed');
  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'update').map((call) => call.args.issue_number),
    [46],
  );
});

test('a forced watchdog/completion race leaves one current train alert', async () => {
  let arrivals = 0;
  let release;
  const bothListed = new Promise((resolve) => {
    release = resolve;
  });
  const beforeFirstIssueList = async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await bothListed;
  };

  const failed = {
    id: 50,
    run_number: 50,
    workflow_id: 7,
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    head_sha: '1'.repeat(40),
    html_url: 'https://example.test/runs/50',
  };
  const hung = {
    ...failed,
    id: 51,
    run_number: 51,
    status: 'in_progress',
    conclusion: null,
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    head_sha: '2'.repeat(40),
    html_url: 'https://example.test/runs/51',
  };
  const issues = [];
  const completedHarness = monitorHarness({
    triggerRun: failed,
    runs: [failed],
    jobsByRun: { 50: [{ name: 'Publish package', conclusion: 'failure' }] },
    issues,
    beforeFirstIssueList,
  });
  const hungHarness = monitorHarness({
    triggerRun: hung,
    runs: [hung],
    jobsByRun: {},
    issues,
    beforeFirstIssueList,
  });

  await Promise.all([
    runCompletedMonitor(completedHarness),
    runHungMonitor(hungHarness),
  ]);

  // A later completion reconciliation is authoritative and must also repair
  // any duplicate left by an interrupted or pre-concurrency monitor run.
  const cleanupHarness = monitorHarness({
    triggerRun: failed,
    runs: [failed],
    jobsByRun: { 50: [{ name: 'Publish package', conclusion: 'failure' }] },
    issues,
  });
  await runCompletedMonitor(cleanupHarness);

  const open = issues.filter(
    (issue) => issue.state === 'open'
      && issue.labels.includes('automated:npm-publish-canary-failure'),
  );
  assert.equal(open.length, 1, 'duplicate train alerts must be consolidated');
  assert.match(open[0].body, /npm-publish-monitor-run:50/);
  assert.ok(
    issues.filter((issue) => issue.state === 'closed').length >= 1,
    'the duplicate must not remain as an orphan open issue',
  );
});

test('npm-publish.yml carries no hard-coded @jinn-network/sdk version literal', () => {
  // The sdk version must be derived from packages/sdk/package.json at run
  // time (marketplace-surfaces design §6 R1): a pinned literal red-lines
  // every client canary the moment the sdk version bumps.
  const pinned = publish.match(/@jinn-network\/sdk@\d+\.\d+\.\d+/g) ?? [];
  assert.deepEqual(pinned, [], `hard-coded sdk version literals: ${pinned.join(', ')}`);
  const versionAssignments = publish.match(/sdk\.version\s*=\s*'\d+\.\d+\.\d+/g) ?? [];
  assert.deepEqual(versionAssignments, [], 'sdk.version must derive from the manifest, not a literal');
});
