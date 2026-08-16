/**
 * Stub Discovery API indexer for acceptance-tier tests.
 *
 * Boots an in-process Hono mini-server that mirrors the REST shape of the
 * daemon's discovery endpoints (as surfaced by `ttz8`). Also watches the
 * locally-deployed IdentityRegistryStub's `MetadataSet` events via viem's
 * `watchContractEvent` and translates `plugin:*` records into in-memory
 * `PluginPublication` rows — mimicking the real Ponder indexer's behaviour
 * without booting Ponder.
 *
 * Routes:
 *   GET /v1/discovery/plugin-publications    — `listPluginPublications`
 *   GET /v1/discovery/builder-artifacts      — `listBuilderArtifacts`
 *   GET /v1/discovery/plugin-scores          — `getPluginScores` (populated via side-channel)
 *   POST /__test/record-run                  — test-only side-channel for `recordRunForTest`
 *
 * The stub does NOT implement the full DiscoveryAPI (findClaimableTasks, etc.).
 * Only the builder-facing surfaces used by the cold-start E2E are wired.
 */

import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { decodeAbiParameters, createPublicClient, http, defineChain } from 'viem';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { PluginPublication, PluginScoreHistoryRow } from '../../../src/plugin-registry/publication-reader.js';
import { PLUGIN_PAYLOAD_TUPLE } from '../../../src/erc8004/abis.js';
import { IDENTITY_REGISTRY_STUB_ABI } from './identity-registry-deploy.js';

function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createHttpServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not resolve allocated port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

export interface TestRunRecord {
  pluginCid: string;
  taskId: string;
  operatorAgentId: string;
  verdict: string;
  score?: number;
}

export interface StubIndexerHandle {
  /** Base URL of the stub indexer HTTP server. */
  url: string;
  /** Stop the event watcher + HTTP server. */
  stop(): Promise<void>;
  /** In-memory PluginPublication rows accumulated from MetadataSet events. */
  getRows(): PluginPublication[];
  /**
   * Test-only side-channel: record a simulated task run for a plug-in CID.
   * The row appears in GET /v1/discovery/plugin-scores responses.
   */
  recordRunForTest(run: TestRunRecord): Promise<void>;
}

export interface StubIndexerOpts {
  rpcUrl: string;
  identityRegistryAddress: `0x${string}`;
  chainId?: number;
}

/**
 * Start the stub indexer on an ephemeral port.
 *
 * Immediately begins watching `MetadataSet` events on the deployed
 * IdentityRegistryStub. Events arrive with a slight delay (one block behind);
 * tests that assert on indexer state should use `waitForRow()` polling.
 */
export async function startStubIndexer(opts: StubIndexerOpts): Promise<StubIndexerHandle> {
  const { rpcUrl, identityRegistryAddress } = opts;
  const chainId = opts.chainId ?? 31337;

  const rows: PluginPublication[] = [];
  const testRuns: TestRunRecord[] = [];

  const chain = defineChain({
    id: chainId,
    name: 'anvil-stub',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  // Watch MetadataSet events and translate plugin:* keys into PluginPublication rows.
  const unwatch = publicClient.watchContractEvent({
    address: identityRegistryAddress,
    abi: IDENTITY_REGISTRY_STUB_ABI,
    eventName: 'MetadataSet',
    onLogs: (logs) => {
      for (const log of logs) {
        const { agentId, metadataKey, metadataValue } = log.args as {
          agentId: bigint;
          metadataKey: string;
          metadataValue: `0x${string}`;
        };

        if (!metadataKey || !metadataKey.startsWith('plugin:')) continue;
        const pluginCid = metadataKey.slice('plugin:'.length);

        try {
          const [version, pluginName, pluginVersion, pluginSha256, supports, publishedAt] =
            decodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, metadataValue);

          if (version === 1) {
            // Upsert: remove any existing row for the same CID, then push.
            const idx = rows.findIndex((r) => r.cid === pluginCid);
            if (idx !== -1) rows.splice(idx, 1);

            rows.push({
              builderAgentId: String(agentId),
              cid: pluginCid,
              name: String(pluginName),
              version: String(pluginVersion),
              supports: (supports as string[]).map(String),
              publishedAt: Number(publishedAt),
              artifactType: 'plugin',
              revoked: false,
              pluginSha256: pluginSha256 as `0x${string}`,
            });
          } else if (version === 2) {
            // Revocation: mark existing row as revoked.
            const existing = rows.find((r) => r.cid === pluginCid);
            if (existing) {
              existing.revoked = true;
            }
          }
        } catch {
          // Ignore non-plugin payloads — silently skip bad decodes.
        }
      }
    },
    onError: (_err) => {
      // Non-fatal — the watcher reconnects automatically.
    },
  });

  // Build the Hono app.
  const app = new Hono();

  /** GET /v1/discovery/plugin-publications */
  app.get('/v1/discovery/plugin-publications', (c) => {
    const solverType = c.req.query('solverType');
    const builderAgentId = c.req.query('builderAgentId');
    const includeRevoked = c.req.query('includeRevoked') !== 'false';
    const limitStr = c.req.query('limit');
    const limit = limitStr ? Math.min(Number(limitStr), 1000) : 100;

    let result = [...rows];
    if (solverType) result = result.filter((r) => r.supports.includes(solverType));
    if (builderAgentId) result = result.filter((r) => r.builderAgentId === builderAgentId);
    if (!includeRevoked) result = result.filter((r) => !r.revoked);
    result = result.slice(0, limit);

    return c.json({ publications: result });
  });

  /** GET /v1/discovery/builder-artifacts?builderAgentId=... */
  app.get('/v1/discovery/builder-artifacts', (c) => {
    const builderAgentId = c.req.query('builderAgentId');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? Math.min(Number(limitStr), 1000) : 100;

    if (!builderAgentId) return c.json({ error: 'builderAgentId is required' }, 400);

    const result = rows.filter((r) => r.builderAgentId === builderAgentId).slice(0, limit);
    return c.json({ artifacts: result });
  });

  /** GET /v1/discovery/plugin-scores?pluginCid=... */
  app.get('/v1/discovery/plugin-scores', (c) => {
    const pluginCid = c.req.query('pluginCid');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? Math.min(Number(limitStr), 1000) : 100;

    if (!pluginCid) return c.json({ error: 'pluginCid is required' }, 400);

    const now = Math.floor(Date.now() / 1000);
    const pub = rows.find((r) => r.cid === pluginCid);

    const scores: PluginScoreHistoryRow[] = testRuns
      .filter((r) => r.pluginCid === pluginCid)
      .slice(0, limit)
      .map((r) => ({
        pluginCid: r.pluginCid,
        taskId: r.taskId,
        operatorAgentId: r.operatorAgentId,
        verdict: r.verdict,
        score: r.score,
        ts: now,
        forkSuspected: false,
      }));

    return c.json({ scores, publication: pub ?? null });
  });

  /** POST /__test/record-run — test-only side-channel */
  app.post('/__test/record-run', async (c) => {
    const run = (await c.req.json()) as TestRunRecord;
    testRuns.push(run);
    return c.json({ ok: true });
  });

  const port = await allocatePort();
  const serverUrl = `http://127.0.0.1:${port}`;

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const srv = serve(
      { fetch: app.fetch, port, hostname: '127.0.0.1' },
      () => resolve(srv as HttpServer),
    );
    (srv as HttpServer).on('error', reject);
  });

  return {
    url: serverUrl,
    stop: async () => {
      unwatch();
      await new Promise<void>((res) => {
        (httpServer as HttpServer).close(() => res());
        (httpServer as HttpServer).closeAllConnections?.();
      });
    },
    getRows: () => rows,
    recordRunForTest: async (run: TestRunRecord) => {
      const resp = await fetch(`${serverUrl}/__test/record-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(run),
      });
      if (!resp.ok) throw new Error(`recordRunForTest failed: ${resp.status}`);
    },
  };
}
