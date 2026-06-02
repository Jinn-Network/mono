import { baseSepolia } from 'viem/chains';
import { spawnAnvilFork, type AnvilHarness } from '../../_support/chain/anvil.js';
import { spawnPonderIndexer, type PonderHandle } from '../../_support/indexer/ponder.js';
import { createDiscoveryAPI } from '../../../src/discovery/factory.js';
import { DiscoveryUnavailableError } from '../../../src/discovery/types.js';
import { runScenario, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types.js';

// The Jinn indexer (packages/indexer/ponder.config.ts) indexes Base Sepolia
// (84532). The round-trip forks that chain so the daemon's GraphQL queries are
// exercised against the same entity schema the daemon writes/reads on testnet.
const FORK_RPC_URL = process.env['BASE_SEPOLIA_RPC_URL'] ?? process.env['BASE_RPC_URL'];
const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * Schema-agreement probes — the daemon's own GraphQL query shapes, mirrored
 * from `client/src/discovery/http.ts`. The field selections are load-bearing:
 * the fufn-class regression this scenario catches is the live indexer schema
 * drifting away from the columns the daemon selects (a renamed/removed column
 * surfaces as a GraphQL `errors` entry, NOT as a network failure). These probe
 * the schema directly so they do NOT depend on the indexer reaching realtime
 * `/ready` — a fresh fork is far behind the indexer's start block, so `/ready`
 * stays red, but the GraphQL schema is served as soon as the HTTP server is up.
 */
const ENVELOPES_PROBE = `
query QueryEnvelopes($where: envelopeFilter, $limit: Int!) {
  envelopes(where: $where, limit: $limit, orderBy: "publishedAtBlock", orderDirection: "desc") {
    items { agentId manifestCid manifestHash evidenceTier publishedAtBlock }
  }
}
`;

const TASKS_PROBE = `
query Tasks($manifestDigest: String!, $limit: Int!, $offset: Int!) {
  tasks(
    where: { manifestDigest: $manifestDigest, finalized: false, refunded: false },
    limit: $limit,
    offset: $offset,
    orderBy: "id",
    orderDirection: "asc"
  ) {
    items { id taskCidDigest manifestDigest createdAtBlock createdAtTx claimWindowEnd maxClaims chainId }
    pageInfo { hasNextPage endCursor }
  }
}
`;

interface GqlResponse {
  data?: Record<string, { items?: unknown[] }>;
  errors?: Array<{ message?: string }>;
}

/**
 * POST a daemon GraphQL query against the live Ponder endpoint and assert the
 * schema accepts it. A schema mismatch (drifted/removed column) returns a
 * GraphQL `errors` array → we throw so the verdict is a `real-bug` fail (the
 * message does not match any flake pattern). A well-formed response must carry
 * `data.<entity>.items` as an array.
 */
async function assertSchemaAgreement(
  graphqlUrl: string,
  entity: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Ponder GraphQL HTTP ${res.status} ${res.statusText} for ${entity}`);
  }
  const json = (await res.json()) as GqlResponse;
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message ?? 'unknown').join('; ');
    // Schema drift relative to the daemon's query — the fufn regression class.
    throw new Error(`daemon-vs-indexer schema mismatch on "${entity}": ${msg}`);
  }
  const items = json.data?.[entity]?.items;
  if (!Array.isArray(items)) {
    throw new Error(`Ponder GraphQL "${entity}" response missing items array`);
  }
}

/**
 * T1.3 — indexer round-trip (spec §3.1 + §6 Home-1).
 *
 * Hermetic local Ponder vs a forked chain, asserting daemon-vs-indexer schema
 * agreement — the fufn-class regression (the 2026-05-23 substrate incident was
 * indexer-related). The round-trip:
 *
 *   1. spawnAnvilFork of Base Sepolia (the chain ponder.config.ts indexes).
 *   2. spawnPonderIndexer against that chain (chainId 84532).
 *   3. Build the real daemon discovery client (discovery.mode='http',
 *      discovery.url=handle.graphqlUrl) via createDiscoveryAPI.
 *   4. Drive the daemon's GraphQL query shapes against the live Ponder schema
 *      and assert agreement; then exercise the real HttpDiscoveryAPI client end
 *      to end (tolerating the indexer-not-yet-synced state on a cold fork).
 *   5. teardown ponder → anvil in finally.
 *
 * When a hard prerequisite is genuinely unavailable (no fork RPC, anvil binary
 * missing, Ponder package not installed) the scenario returns `verdict: 'skip'`
 * with a clear reason; the default path attempts the real round-trip.
 */
export async function runT13IndexerRoundTrip(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  return runScenario('T1.3', opts, async ({ log }) => {
    if (!FORK_RPC_URL) {
      log('No BASE_SEPOLIA_RPC_URL / BASE_RPC_URL in env — cannot fork the indexed chain.');
      return {
        verdict: 'skip',
        failNotes: 'BASE_SEPOLIA_RPC_URL unset — no live RPC to fork for the hermetic indexer round-trip',
      };
    }

    let chain: AnvilHarness | null = null;
    let indexer: PonderHandle | null = null;

    try {
      // ── Phase 1: anvil fork of Base Sepolia ────────────────────────────────
      log('Phase 1: spawn Anvil fork of Base Sepolia (chainId 84532)');
      try {
        chain = await spawnAnvilFork({ forkUrl: FORK_RPC_URL, chain: baseSepolia, silent: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // anvil binary missing → genuine prerequisite gap, skip cleanly.
        if (/failed to spawn|ENOENT|not found/i.test(msg)) {
          log(`Anvil unavailable: ${msg}`);
          return { verdict: 'skip', failNotes: `anvil binary unavailable: ${msg}` };
        }
        throw err;
      }
      log(`  Anvil ready at ${chain.rpcUrl}`);

      // ── Phase 2: local Ponder against the forked chain ─────────────────────
      log('Phase 2: spawn local Ponder against the forked chain');
      try {
        indexer = await spawnPonderIndexer({ rpcUrl: chain.rpcUrl, chainId: BASE_SEPOLIA_CHAIN_ID });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Ponder package not installed / yarn workspace not built → prerequisite
        // gap, skip cleanly. A genuine RPC-unreachable error reads as a fork/anvil
        // problem (infra) and is rethrown so classifyFailure tags it flake-infra.
        if (/ENOENT|command not found|Cannot find module|no such file/i.test(msg)) {
          log(`Ponder unavailable: ${msg}`);
          return { verdict: 'skip', failNotes: `Ponder indexer package unavailable: ${msg}` };
        }
        throw err;
      }
      log(`  Ponder GraphQL at ${indexer.graphqlUrl}`);

      // ── Phase 3: real daemon discovery client (mode=http) ──────────────────
      log('Phase 3: build the daemon discovery client (mode=http) against the live endpoint');
      const discovery = createDiscoveryAPI(
        { mode: 'http', url: indexer.graphqlUrl },
        { chainId: BASE_SEPOLIA_CHAIN_ID },
      );

      // ── Phase 4a: daemon-vs-indexer schema agreement (the fufn check) ──────
      log('Phase 4a: assert daemon GraphQL query shapes round-trip against the live schema');
      await assertSchemaAgreement(indexer.graphqlUrl, 'envelopes', ENVELOPES_PROBE, { where: {}, limit: 1 });
      log('  envelopes schema OK');
      await assertSchemaAgreement(indexer.graphqlUrl, 'tasks', TASKS_PROBE, {
        manifestDigest: '0x0000000000000000000000000000000000000000000000000000000000000000',
        limit: 1,
        offset: 0,
      });
      log('  tasks schema OK');

      // ── Phase 4b: exercise the real HttpDiscoveryAPI client end to end ─────
      // The daemon's HttpDiscoveryAPI gates reads on Ponder's /ready, which on a
      // freshly-forked chain is still red (the fork tip is far behind the
      // indexer's configured start block, so historical sync hasn't reached
      // realtime). That is the expected cold-fork state, NOT a schema failure —
      // schema agreement was already proven in 4a. So a DiscoveryUnavailableError
      // here is tolerated and logged; any other error propagates as a fail.
      log('Phase 4b: exercise the real HttpDiscoveryAPI client (queryEnvelopes)');
      try {
        const refs = await discovery.queryEnvelopes({ limit: 1 });
        log(`  HttpDiscoveryAPI.queryEnvelopes returned ${refs.length} ref(s) — indexer at realtime`);
      } catch (err) {
        if (err instanceof DiscoveryUnavailableError) {
          log(`  HttpDiscoveryAPI not-yet-ready (expected on a cold fork): ${err.message}`);
        } else {
          throw err;
        }
      }

      log('indexer round-trip OK — daemon and indexer agree on schema');
      return { verdict: 'pass' };
    } finally {
      if (indexer) {
        try { await indexer.teardown(); } catch { /* best-effort */ }
      }
      if (chain) {
        try { await chain.teardown(); } catch { /* best-effort */ }
      }
    }
  });
}
