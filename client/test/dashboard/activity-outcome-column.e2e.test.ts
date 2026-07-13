/**
 * App-level regression coverage for issue #502 — the Activity table's new
 * task-relative `Outcome` column (spec/2026-05-22-run-outcome.md).
 *
 * The component-level render tests in
 * `src/dashboard/spa/src/pages/overview/ActivityCard.test.tsx` already assert
 * the badge/label logic in isolation. This test closes the loop end-to-end:
 * it drives the *rendered app* — a real daemon serving the built SPA bundle —
 * with a mocked `/v1/status` whose `taskRuns.recentTasks` carries the three
 * canonical outcome shapes, then asserts the four #502 acceptance points
 * render in the browser DOM. It proves the full pipe:
 *   /v1/status  →  Overview.tsx ingest (TaskRunRow.outcome passthrough)
 *               →  ActivityCard classifyOutcome + column + badge cell.
 *
 * Acceptance points verified in the running app:
 *   1. A COMPLETE (succeeded) solve run with outcome:'fail' shows State:
 *      succeeded AND Outcome: fail side by side.
 *   2. A COMPLETE solve run with outcome:'awaiting' shows Outcome: "awaiting eval".
 *   3. A FAILED run with outcome:null shows Outcome: "—".
 *   4. The `Outcome` column header sits between `State` and `Started`.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mockDaemonApi,
  DEFAULT_STATUS_PAYLOAD,
  DEFAULT_RUNNING_BOOTSTRAP,
} from './helpers/mock-daemon-api';

const PORT = 17342;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

const NOW = Date.now();

// Bootstrap the operator into exactly one joined SolverNet so the Activity
// card selects it by default and — because `joined.length <= 1` — surfaces
// every run row without solverType scoping. Match the prediction.v1 contract
// so joinedNets derives solverType 'prediction.v1'.
const BOOTSTRAP_WITH_JOINED = {
  ...DEFAULT_RUNNING_BOOTSTRAP,
  joinedSolverNets: {
    'bafkrei-prediction-manifest': {
      name: 'Prediction Markets',
      manifestCid: 'bafkrei-prediction-manifest',
      contract: { id: 'prediction', version: 'v1' },
      roles: ['solving'],
      harness: 'claude-code-learner',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['jinn-prediction-plugin'],
    },
  },
};

// Three canonical run rows exercising the Outcome column.
const RECENT_TASKS = [
  // (a) COMPLETE (succeeded) solve run the network judged a fail.
  {
    requestId: '0xoutcomefail000000000000000000000000000000000000000000000001',
    manifestCid: 'bafkrei-delivery-cid-a',
    solverType: 'prediction.v1',
    taskRole: 'restoration',
    state: 'COMPLETE',
    implName: 'claude-code-learner',
    windowStartTs: NOW - 300_000,
    runStartedAt: NOW - 300_000,
    stateUpdatedAt: NOW - 90_000,
    deliveryTxHash: null,
    failureReason: null,
    outcome: 'fail',
  },
  // (b) COMPLETE solve run still awaiting the network's verdict quorum.
  {
    requestId: '0xoutcomeawaiting00000000000000000000000000000000000000000002',
    manifestCid: 'bafkrei-delivery-cid-b',
    solverType: 'prediction.v1',
    taskRole: 'restoration',
    state: 'COMPLETE',
    implName: 'claude-code-learner',
    windowStartTs: NOW - 200_000,
    runStartedAt: NOW - 200_000,
    stateUpdatedAt: NOW - 60_000,
    deliveryTxHash: null,
    failureReason: null,
    outcome: 'awaiting',
  },
  // (c) FAILED run with no outcome axis. runStartedAt is populated so the
  // "never engaged" filter keeps the row (a genuine mid-run failure).
  {
    requestId: '0xoutcomenull0000000000000000000000000000000000000000000000003',
    manifestCid: 'bafkrei-delivery-cid-c',
    solverType: 'prediction.v1',
    taskRole: 'restoration',
    state: 'FAILED',
    implName: 'claude-code-learner',
    windowStartTs: NOW - 100_000,
    runStartedAt: NOW - 100_000,
    stateUpdatedAt: NOW - 30_000,
    deliveryTxHash: null,
    failureReason: 'solver crashed mid-run',
    outcome: null,
  },
];

const STATUS_WITH_TASK_RUNS = {
  ...DEFAULT_STATUS_PAYLOAD,
  taskRuns: {
    totals: {
      observedTasks: 3,
      activeTaskRuns: 0,
      completed: 2,
      solutions: 2,
      verdicts: 1,
      failed: 1,
    },
    inFlight: [],
    recentTasks: RECENT_TASKS,
  },
};

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-activity-outcome-e2e-'));
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error(`dist/bin/jinn.js missing — run \`yarn build\` first`);
  }
  daemon = spawn('node', [distBin, 'run', '--no-ui'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      JINN_PASSWORD: 'test-password',
      JINN_API_PORT: String(PORT),
      BASE_RPC_URL: 'http://127.0.0.1:65000',
      JINN_NETWORK: 'testnet',
      JINN_DISABLE_TESTNET_FAUCET: '1',
    },
    stdio: 'pipe',
  });

  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf-8');
    const m = /UI handshake URL:\s+(\S+)/.exec(text);
    if (m && !handshakeUrl) handshakeUrl = m[1];
  };
  daemon.stderr?.on('data', onChunk);
  daemon.stdout?.on('data', onChunk);

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
        headers: { 'x-jinn-ui-token': 'unused' },
      });
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('daemon never came up on test port');
});

test.afterAll(async () => {
  if (daemon && !daemon.killed) {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!daemon.killed) daemon.kill('SIGKILL');
  }
});

test('Activity table renders the task-relative Outcome column (#502)', async ({ page }) => {
  // Baseline route mocks first; then override /v1/status + /v1/bootstrap with
  // the #502 fixtures. Playwright's last-registered-wins semantics put these
  // overrides in front of the defaults installed by mockDaemonApi.
  await mockDaemonApi(page);

  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(STATUS_WITH_TASK_RUNS),
      }),
  );
  await page.route(
    (url) => url.pathname === '/v1/bootstrap',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(BOOTSTRAP_WITH_JOINED),
      }),
  );

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);
  await expect(page).toHaveURL(/\/overview$/);

  // The Activity table must render (all three rows survive the filters).
  const table = page.getByTestId('activity-tasks-table');
  await expect(table).toBeVisible();

  // ── AC4: the Outcome column header sits between State and Started ──────
  const headers = table.getByRole('columnheader');
  await expect(headers).toHaveText(['Run', 'Task', 'State', 'Outcome', 'Started']);

  // ── AC1: COMPLETE (succeeded) solve run with outcome:'fail' shows BOTH
  //         State: succeeded AND Outcome: fail on the same row ───────────
  const failRow = page.getByTestId(
    'activity-task-row-0xoutcomefail000000000000000000000000000000000000000000000001',
  );
  await expect(failRow).toBeVisible();
  await expect(failRow).toContainText('succeeded');
  await expect(failRow).toContainText('fail');
  // Sanity: the State and Outcome labels are two distinct cells, not one badge.
  // The 4th cell (index 3) is Outcome; assert its badge reads exactly "fail".
  const failOutcomeCell = failRow.getByRole('cell').nth(3);
  await expect(failOutcomeCell).toHaveText('fail');
  const failStateCell = failRow.getByRole('cell').nth(2);
  await expect(failStateCell).toHaveText('succeeded');

  // ── AC2: COMPLETE solve run with outcome:'awaiting' → "awaiting eval" ──
  const awaitingRow = page.getByTestId(
    'activity-task-row-0xoutcomeawaiting00000000000000000000000000000000000000000002',
  );
  await expect(awaitingRow).toBeVisible();
  await expect(awaitingRow.getByRole('cell').nth(3)).toHaveText('awaiting eval');

  // ── AC3: FAILED run with outcome:null → Outcome cell renders "—" ──────
  const nullRow = page.getByTestId(
    'activity-task-row-0xoutcomenull0000000000000000000000000000000000000000000000003',
  );
  await expect(nullRow).toBeVisible();
  await expect(nullRow).toContainText('failed');
  await expect(nullRow.getByRole('cell').nth(3)).toHaveText('—');

  // Evidence capture for the reviewer.
  await table.screenshot({
    path: join(process.cwd(), 'test/dashboard/__screenshots__/activity-outcome-column-502.png'),
  });
});
