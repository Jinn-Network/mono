/**
 * T2.1 — cross-operator corpus donation scenario.
 *
 * Scenario contract (from scenario-cross-op-donation.md):
 *   op-a produces a corpus artifact, indexer attributes it,
 *   op-b queries (402 unpaid), op-b pays x402, op-b retrieves (200 + ERC-8128 sig).
 *
 * Real daemon API surface (confirmed by grepping client/src/api/ and client/src/x402/):
 *   - GET  /v1/artifacts/:sha256/content   x402-gated serving (handler.ts:144)
 *   - POST /v1/artifacts/acquire           buyer-side acquire (server.ts:613)
 *   - GET  /v1/operator/artifacts          operator artifact listing (operator-artifacts-endpoint.ts:330)
 *   - POST /artifacts                      artifact publish (server.ts:562)
 *   - NO   /v1/corpus/produce              — speculative endpoint, NOT present
 *   - NO   /v1/corpus/:cid                 — speculative endpoint, NOT present
 *   - NO   /v1/corpus/:cid/pay             — speculative endpoint, NOT present
 *   - NO   /v1/discovery/corpus            — speculative endpoint, NOT present
 *
 * Corpus production happens via task execution + engine pack/pin path — there is no
 * HTTP entry point. T2.1 therefore returns 'skip' with a diagnostic message pointing
 * to the follow-up GitHub issue.
 *
 * Follow-up: https://github.com/Jinn-Network/mono/issues/349
 * (T2.1 cross-op donation: missing producer endpoint /v1/corpus/produce)
 */

import { setupTier2Scenario, type Tier2Handle } from './tier-2-helpers.js';
import { EvidenceLog, skipVerdict, failVerdict } from './scenario-evidence.js';
import { spawnPonderIndexer } from '../../_support/indexer/ponder.js';
import type { ScenarioVerdict, ScenarioOptions } from '../../../scripts/release/scenario-types.js';

// ── Candidate producer endpoints to probe ────────────────────────────────────
// These are the speculative paths from the scenario plan. If any return non-404
// (e.g. 200, 405, 401) that means the daemon has grown the surface and T2.1
// should be updated to exercise it.
const SPECULATIVE_PRODUCER_ENDPOINTS = [
  '/v1/corpus/produce',
  '/v1/discovery/corpus',
] as const;

async function probeEndpoint(
  apiPort: number,
  urlPath: string,
): Promise<{ status: number | null; reachable: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}${urlPath}`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    return { status: res.status, reachable: true };
  } catch {
    return { status: null, reachable: false };
  }
}

// ── Callable entry point for the orchestrator (Task 10) ──────────────────────

export async function runT21CrossOpDonation(
  opts: ScenarioOptions,
): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidence = new EvidenceLog(opts.evidencePath);
  const log = (msg: string): void => evidence.log(msg);

  let handle: Tier2Handle | null = null;
  let indexer: Awaited<ReturnType<typeof spawnPonderIndexer>> | null = null;

  // ── Prerequisite: BASE_SEPOLIA_RPC_URL ────────────────────────────────────
  // setupTier2Scenario throws if the env var is absent; guard early so the
  // error message is T2.1-specific and we can skip cleanly.
  if (!process.env['BASE_SEPOLIA_RPC_URL']) {
    log('SKIP: BASE_SEPOLIA_RPC_URL not set; cannot fork Base Sepolia for T2.1.');
    log(
      'Set BASE_SEPOLIA_RPC_URL to a Base Sepolia RPC endpoint and re-run to ' +
      'exercise the T2.1 infrastructure setup. Even with the RPC set, T2.1 will ' +
      'currently still skip because the producer endpoint is missing (see step 2).',
    );
    await evidence.flush();
    return skipVerdict({
      scenarioId: 'T2.1',
      startedAt: started,
      evidencePath: opts.evidencePath,
      failNotes: 'BASE_SEPOLIA_RPC_URL not set; skipping infrastructure setup',
    });
  }

  try {
    // ── Step 1: Spin up substrate + Anvil fork + daemons ────────────────────
    log('Step 1: setup substrate workspace + Anvil fork of Base Sepolia + op-a/op-b daemons');
    handle = await setupTier2Scenario({ scenarioId: 'T2.1', portBase: 7750 });
    log(`  workspace: ${handle.workspace.workspaceRoot}`);
    log(`  anvil rpc: ${handle.anvilRpcUrl}`);
    const opAPort = handle.daemons.daemons['op-a']!.apiPort;
    const opBPort = handle.daemons.daemons['op-b']!.apiPort;
    log(`  op-a api: http://127.0.0.1:${opAPort}`);
    log(`  op-b api: http://127.0.0.1:${opBPort}`);

    // ── Step 2: Probe for speculative producer endpoints ─────────────────────
    log('Step 2: probing speculative T2.1 producer endpoints against op-a');
    const probeResults: Record<string, { status: number | null; reachable: boolean }> = {};
    for (const ep of SPECULATIVE_PRODUCER_ENDPOINTS) {
      const result = await probeEndpoint(opAPort, ep);
      probeResults[ep] = result;
      log(
        `  ${ep}: reachable=${result.reachable}, status=${result.status ?? 'unreachable'}` +
        (result.reachable && result.status !== 404
          ? '  <--- non-404 response; endpoint may be implemented!'
          : ' (404/unreachable — not implemented)'),
      );
    }

    // Determine whether any speculative endpoint is available (non-404, reachable).
    const anyProducerAvailable = Object.entries(probeResults).some(
      ([, r]) => r.reachable && r.status !== null && r.status !== 404,
    );

    // Also probe the known-real artifact surfaces to confirm they're up.
    log('Step 2b: probing known-real artifact surfaces for baseline health check');
    const knownEndpoints = [
      '/v1/artifacts/acquire',  // POST — we GET it, expect 404 or 405
      '/v1/operator/artifacts', // GET, bearer-gated — expect 401 without token
    ];
    for (const ep of knownEndpoints) {
      const r = await probeEndpoint(opAPort, ep);
      log(`  ${ep}: reachable=${r.reachable}, status=${r.status ?? 'unreachable'}`);
    }

    if (!anyProducerAvailable) {
      // ── Expected path for v0.1.6: skip because producer endpoint is missing ─
      log('');
      log('Step 2 result: no speculative producer endpoint is present in this daemon build.');
      log('  Real corpus surface as of v0.1.6:');
      log('    GET  /v1/artifacts/:sha256/content  — x402-gated serving (client/src/x402/handler.ts:144)');
      log('    POST /v1/artifacts/acquire          — buyer-side acquire  (client/src/api/server.ts:613)');
      log('    GET  /v1/operator/artifacts         — operator listing    (client/src/api/operator-artifacts-endpoint.ts:330)');
      log('    POST /artifacts                     — publish artifact    (client/src/api/server.ts:562)');
      log('  Missing for T2.1:');
      log('    POST /v1/corpus/produce             — no HTTP entry point for corpus production');
      log('    GET  /v1/corpus/:cid                — no corpus-by-CID fetch route');
      log('    POST /v1/corpus/:cid/pay            — no pay-and-retrieve route');
      log('    GET  /v1/discovery/corpus           — no corpus discovery route');
      log('');
      log('  Corpus production today happens exclusively via:');
      log('    task execution → engine pack/pin path → signed envelope → IPFS upload');
      log('    There is no REST entry point to trigger or expose that path.');
      log('');
      log('  To make T2.1 pass, one of the following is needed:');
      log('    (a) Add POST /v1/corpus/produce (calls Corpus.produce with a payload)');
      log('    (b) Rewrite T2.1 to drive corpus production through full task execution');
      log('        against the Anvil fork (much heavier; ~2-3x more implementation work)');
      log('');
      log('  Follow-up issue: https://github.com/Jinn-Network/mono/issues/349');
      log('');
      log('Verdict: skip');

      await evidence.flush();
      return skipVerdict({
        scenarioId: 'T2.1',
        startedAt: started,
        evidencePath: opts.evidencePath,
        failNotes:
          'T2.1 producer endpoint /v1/corpus/produce not present in this daemon build (v0.1.6). ' +
          'Corpus production has no HTTP entry point; driven only via task execution + engine pack/pin path. ' +
          'See https://github.com/Jinn-Network/mono/issues/349.',
      });
    }

    // ── Step 3 (only reachable if a future build exposes the producer surface) ─
    // This branch does not execute in v0.1.6 but documents the intended scenario
    // flow so it can be implemented when the producer endpoint lands.
    log('Step 3: producer endpoint detected — spawning Ponder indexer against fork');
    log('  NOTE: this branch is not expected to execute in v0.1.6.');
    indexer = await spawnPonderIndexer({
      rpcUrl: handle.anvilRpcUrl,
      chainId: 84532,
      readyTimeoutMs: 45000,
    });
    log(`  indexer graphql: ${indexer.graphqlUrl}`);

    // [Future implementation]:
    //   3a. POST /v1/corpus/produce on op-a with SAMPLE_PAYLOAD
    //   3b. Poll Ponder indexer until it attributes the CID to op-a's address
    //   3c. GET /v1/corpus/<cid> from op-b → expect 402 Payment Required
    //   3d. POST /v1/corpus/<cid>/pay from op-b with x402 payment header
    //   3e. Assert 200 with payload bytes + ERC-8128 signature on op-b response
    //   3f. Assert USDC balance delta on op-a matches priceUsdc
    log('Step 3+: happy-path not implemented; returning fail to flag the unexpected code path');
    throw new Error(
      'T2.1 happy-path not implemented: this branch executes only if the speculative producer ' +
      'endpoint exists, but implementing the happy path was deferred pending GH issue resolution.',
    );
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    await evidence.flush();
    return failVerdict({
      scenarioId: 'T2.1',
      startedAt: started,
      evidencePath: opts.evidencePath,
      error: err,
    });
  } finally {
    if (indexer) {
      try { await indexer.teardown(); } catch {}
    }
    if (handle) {
      try { await handle.teardown(); } catch {}
    }
  }
}

