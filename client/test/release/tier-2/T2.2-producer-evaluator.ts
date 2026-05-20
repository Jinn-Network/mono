/**
 * T2.2 — producer/evaluator on Anvil-fork scenario.
 *
 * Scenario contract (from docs/superpowers/plans/2026-05-19-tier-2-scenarios-plan.md Task 6):
 *   op-a posts a known-solvable SWE-rebench v2 task (stub harness returns canned patch),
 *   op-b runs the real evaluator and posts verdict.
 *   Assert verdictCode=1 and activity counters increment.
 *
 * Real daemon API surface (confirmed by grepping client/src/api/ for "app.post"):
 *   - POST /v1/solvernets/drafts          — draft creation (solvernets-endpoints.ts:666)
 *   - POST /v1/solvernets/drafts/:id/launch — launch a draft (solvernets-endpoints.ts:935)
 *   - POST /v1/operator/pricing           — pricing config (operator-artifacts-endpoint.ts:333)
 *   - POST /v1/operator/join/:cid         — join a SolverNet (setup-endpoints.ts:485)
 *   - POST /v1/setup/solvernets/:name     — setup endpoint (setup-endpoints.ts:331)
 *   - POST /v1/auth/claude/spawn          — spawn Claude auth (setup-endpoints.ts:130)
 *   - POST /api/admin/restart             — admin restart (admin-endpoint.ts:48)
 *   - NO   POST /v1/tasks                 — NOT present in v0.1.6
 *   - NO   GET  /v1/tasks/:id             — NOT present (/v1/launcher/tasks is a LIST only)
 *   - NO   GET  /v1/verdicts?taskId=...   — NOT present at all
 *   - NO   GET  /v1/activity             — NOT present; activity surfaces via GET /v1/status
 *
 * Activity counts: surfaced in GET /v1/status body as `activityCounts: Record<string, number>`
 * (see client/src/api/status-build.ts:37 and gather-status.ts:447).
 *
 * Real task posting goes via on-chain Mech Marketplace (postRestorationJob, etc) —
 * see client/src/adapters/mech/ — not via HTTP. T2.2 therefore returns 'skip' with
 * a diagnostic message pointing to the follow-up GitHub issue.
 *
 * Follow-up: https://github.com/Jinn-Network/mono/issues/350
 * (T2.2 producer-evaluator: missing /v1/tasks, /v1/verdicts, /v1/activity endpoints)
 */

import * as path from 'node:path';

import { setupTier2Scenario, type Tier2Handle } from './tier-2-helpers.js';
import { EvidenceLog, skipVerdict, failVerdict } from './scenario-evidence.js';
import type { ScenarioVerdict, ScenarioOptions } from '../../../scripts/release/scenario-types.js';
import {
  KNOWN_INSTANCE_ID,
  KNOWN_REPO,
  KNOWN_COMMIT,
  KNOWN_EXPECTED_VERDICT,
  KNOWN_MANIFEST_CID,
} from './fixtures/known-instance.js';

// Suppress unused-variable warnings for constants used only in forward-compat block.
void KNOWN_REPO;
void KNOWN_COMMIT;
void KNOWN_EXPECTED_VERDICT;
void KNOWN_MANIFEST_CID;

// Resolved at call time (ESM: import.meta.dirname is the directory of this file).
const fixturesDir = path.resolve(import.meta.dirname, 'fixtures');

// ── Speculative task-posting endpoint to probe ───────────────────────────────
// This is the endpoint the scenario would use if it existed. If it ever returns
// a clear success (200/201), T2.2 should be updated to proceed to the happy
// path below.
//
// IMPORTANT: the "available" check is intentionally narrow. A 401/405/500 does
// NOT mean the happy path is ready — it means the route is absent for this
// method, auth-gated, or erroring. Treating those as "implemented" would
// advance into the not-implemented happy path and raise a spurious real-bug
// fail. Only an explicit 200/201 counts as available.
async function probeTaskPostEndpoint(
  apiPort: number,
): Promise<{ reachable: boolean; status: number | null }> {
  try {
    // GET on the speculative endpoint — if it's mounted and read-able we'd
    // get 200; if not mounted (or mounted POST-only) we'd get 404/405.
    const res = await fetch(`http://127.0.0.1:${apiPort}/v1/tasks`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    return { reachable: true, status: res.status };
  } catch {
    return { reachable: false, status: null };
  }
}

// ── Callable entry point for the orchestrator (Task 10) ──────────────────────

export async function runT22ProducerEvaluator(
  opts: ScenarioOptions,
): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidence = new EvidenceLog(opts.evidencePath);
  const log = (msg: string): void => evidence.log(msg);

  let handle: Tier2Handle | null = null;

  // ── Prerequisite: BASE_SEPOLIA_RPC_URL ────────────────────────────────────
  // setupTier2Scenario throws if the env var is absent; guard early so the
  // error message is T2.2-specific and we can skip cleanly.
  if (!process.env['BASE_SEPOLIA_RPC_URL']) {
    log('SKIP: BASE_SEPOLIA_RPC_URL not set; cannot fork Base Sepolia for T2.2.');
    log(
      'Set BASE_SEPOLIA_RPC_URL to a Base Sepolia RPC endpoint and re-run to ' +
      'exercise the T2.2 infrastructure setup. Even with the RPC set, T2.2 will ' +
      'currently still skip because the /v1/tasks endpoint is missing (see step 2).',
    );
    await evidence.flush();
    return skipVerdict({
      scenarioId: 'T2.2',
      startedAt: started,
      evidencePath: opts.evidencePath,
      failNotes: 'BASE_SEPOLIA_RPC_URL not set; skipping infrastructure setup',
    });
  }

  try {
    // ── Step 1: Spin up substrate + Anvil fork + daemons ────────────────────
    log('Step 1: setup substrate workspace + Anvil fork of Base Sepolia + op-a/op-b daemons');
    log(`  known instance: ${KNOWN_INSTANCE_ID}`);
    log(`  fixtures dir:   ${fixturesDir}`);
    handle = await setupTier2Scenario({
      scenarioId: 'T2.2',
      portBase: 7760,
      extraEnv: {
        JINN_HARNESS_STUB_INSTANCE: KNOWN_INSTANCE_ID,
        JINN_HARNESS_STUB_FIXTURES_DIR: fixturesDir,
        // Required sentinel: the stub harness factory throws unless JINN_TEST_MODE
        // is exactly '1' (defense-in-depth so a stray env var can never activate
        // the fake harness in a real operator run).
        JINN_TEST_MODE: '1',
      },
    });
    log(`  workspace: ${handle.workspace.workspaceRoot}`);
    log(`  anvil rpc: ${handle.anvilRpcUrl}`);
    const opAPort = handle.daemons.daemons['op-a']!.apiPort;
    const opBPort = handle.daemons.daemons['op-b']!.apiPort;
    log(`  op-a api: http://127.0.0.1:${opAPort}`);
    log(`  op-b api: http://127.0.0.1:${opBPort}`);

    // ── Step 1b: Capture initial activity counts via /v1/status ──────────────
    log('Step 1b: capturing initial activity counts from op-a /v1/status');
    const statusRes = await fetch(`http://127.0.0.1:${opAPort}/v1/status`);
    if (statusRes.ok) {
      const statusBody = await statusRes.json() as { activityCounts?: Record<string, number> };
      log(`   op-a /v1/status activityCounts: ${JSON.stringify(statusBody.activityCounts ?? {})}`);
    } else {
      log(`   op-a /v1/status returned ${statusRes.status} — daemon may not be ready`);
    }

    // ── Step 2: Probe for speculative /v1/tasks endpoint ─────────────────────
    log('Step 2: probing speculative /v1/tasks endpoint against op-a');
    const probe = await probeTaskPostEndpoint(opAPort);
    const probeIndicatesAvailable =
      probe.reachable && (probe.status === 200 || probe.status === 201);
    log(
      `  GET /v1/tasks: reachable=${probe.reachable}, status=${probe.status ?? 'unreachable'}` +
      (probeIndicatesAvailable
        ? '  <--- 200/201 response; endpoint implemented!'
        : ' (not a 200/201 — not implemented for the happy path)'),
    );

    // Also probe known-real endpoints to confirm daemon health.
    log('Step 2b: probing known-real endpoints for baseline health check');
    const knownEndpoints = [
      '/v1/operator/artifacts', // GET, bearer-gated — expect 401 without token
      '/v1/solvernets/drafts',  // GET — solvernets list
    ];
    for (const ep of knownEndpoints) {
      try {
        const r = await fetch(`http://127.0.0.1:${opAPort}${ep}`, {
          signal: AbortSignal.timeout(3000),
        });
        log(`  ${ep}: reachable=true, status=${r.status}`);
      } catch {
        log(`  ${ep}: reachable=false`);
      }
    }

    // Narrow: only an explicit 200/201 means the happy path is implementable.
    // 401/405/500 are treated as "not present for this method" so the scenario
    // skips cleanly instead of advancing into the not-implemented throw.
    const taskEndpointAvailable = probeIndicatesAvailable;

    if (!taskEndpointAvailable) {
      // ── Expected path for v0.1.6: skip because /v1/tasks is missing ─────────
      log('');
      log('Step 2 result: /v1/tasks endpoint is not present in this daemon build.');
      log('  Real task-posting surface as of v0.1.6:');
      log('    Real tasks are posted via on-chain Mech Marketplace (postRestorationJob),');
      log('    not via HTTP. See client/src/adapters/mech/adapter.ts.');
      log('  Activity counts surface via:');
      log('    GET /v1/status → body.activityCounts: Record<string, number>');
      log('    (see client/src/api/status-build.ts:37, gather-status.ts:447)');
      log('  Missing for T2.2:');
      log('    POST /v1/tasks              — no HTTP entry point for task posting');
      log('    GET  /v1/tasks/:id          — no get-by-id route (/v1/launcher/tasks is list-only)');
      log('    GET  /v1/verdicts?taskId=X  — no verdict query surface');
      log('    GET  /v1/activity           — no dedicated activity endpoint');
      log('');
      log('  To make T2.2 pass, one of the following is needed:');
      log('    (a) Add POST /v1/tasks (wraps MechAdapter.postRestorationJob on-chain call)');
      log('    (b) Rewrite T2.2 to drive task posting via mech adapter directly from test process');
      log('');
      log('  Follow-up issue: https://github.com/Jinn-Network/mono/issues/350');
      log('');
      log('Verdict: skip');

      await evidence.flush();
      return skipVerdict({
        scenarioId: 'T2.2',
        startedAt: started,
        evidencePath: opts.evidencePath,
        failNotes:
          'T2.2 /v1/tasks endpoint not present in this daemon build (v0.1.6). ' +
          'Real task posting goes via on-chain Mech Marketplace (postRestorationJob), not HTTP. ' +
          'Activity counts surface via GET /v1/status body.activityCounts. ' +
          'See https://github.com/Jinn-Network/mono/issues/350.',
      });
    }

    // ── Step 3 (only reachable if a future build exposes /v1/tasks) ──────────
    // This branch does not execute in v0.1.6 but documents the intended scenario
    // flow so it can be implemented when the task-posting endpoint lands.
    log('Step 3: /v1/tasks endpoint detected — proceeding to happy path (NOT YET IMPLEMENTED)');
    log('  NOTE: this branch is not expected to execute in v0.1.6.');

    // [Future implementation]:
    //   3a. POST /v1/tasks on op-a with KNOWN_INSTANCE_ID + stub harness patch
    //       → extract taskId from response
    //   3b. Poll GET /v1/tasks/:taskId on op-a until delivery status is 'delivered'
    //       (or timeout after wallClockBudgetMs)
    //   3c. Poll GET /v1/verdicts?taskId=<taskId> on op-b until verdict arrives
    //       (or timeout)
    //   3d. Assert verdict.verdictCode === KNOWN_EXPECTED_VERDICT (1)
    //   3e. Capture final activity counts from GET /v1/status on op-a and op-b
    //   3f. Assert at least one activity counter incremented from baseline

    log('Step 3+: happy-path not implemented; returning fail to flag unexpected code path');
    throw new Error(
      'T2.2 happy-path not implemented: this branch executes only if /v1/tasks exists, ' +
      'but implementing the happy path was deferred pending GH issue resolution. ' +
      'See https://github.com/Jinn-Network/mono/issues/350.',
    );
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    await evidence.flush();
    return failVerdict({
      scenarioId: 'T2.2',
      startedAt: started,
      evidencePath: opts.evidencePath,
      error: err,
    });
  } finally {
    if (handle) {
      try { await handle.teardown(); } catch {}
    }
  }
}
