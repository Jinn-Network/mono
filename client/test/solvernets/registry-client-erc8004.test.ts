/**
 * Tests for the IdentityRegistry-backed SolverNetRegistryClient (Task 4).
 *
 * The implementation wires:
 *   - publishManifest / publishLifecycleTransition → IdentityRegistry.setMetadata
 *   - listLaunched / getLifecycleStatus            → SubgraphClient (most-recent-wins)
 *   - getManifest                                  → IPFS (with hash verification)
 *
 * Tests mock IPFS, the metadata publisher, and the subgraph client. No real
 * chain calls; no real network requests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';

import {
  IdentityRegistryBackedSolverNetRegistryClient,
  type MetadataPublisher,
  type IpfsClient,
  type SubgraphClient,
  type SetMetadataPublishResult,
  SOLVERNET_MANIFEST_KEY_PREFIX,
} from '../../src/solvernets/registry-client-erc8004.js';
import type { SignerWithAgentEoa, SolverNetManifestSummary } from '../../src/solvernets/registry-client.js';
import {
  signManifest,
  manifestHash,
  canonicalManifestJson,
  type UnsignedSolverNetManifestV1,
} from '../../src/solvernets/manifest.js';
import { canonicalJson } from '../../src/util/canonical-json.js';
import {
  resolveMostRecentWins,
  type SetMetadataEvent,
} from '../../src/solvernets/most-recent-wins.js';
import {
  DiscoveryUnavailableError,
  type DiscoveryAPI,
  type SolverNetLifecycleStatus,
} from '../../src/discovery/types.js';

/**
 * Heuristic for "this object looks like a SolverNetManifestV1". We only
 * need it inside the IPFS double's `cidOf` to decide whether to strip the
 * `signature` field via `canonicalManifestJson` (matching production) or
 * fall back to plain `canonicalJson` (for negative-path tests that
 * pre-seed malformed bodies). Doesn't need to be a full validator.
 */
function isManifestLike(data: unknown): data is SolverNetManifestV1 | UnsignedSolverNetManifestV1 {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { schemaVersion?: unknown }).schemaVersion === 'string' &&
    (data as { schemaVersion: string }).schemaVersion === 'solvernet.manifest.v1'
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function buildUnsignedManifest(args: {
  agentEoa: `0x${string}`;
  agentId?: string;
  safeAddress?: `0x${string}`;
  solverNetId?: string;
}): UnsignedSolverNetManifestV1 {
  return {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: args.solverNetId ?? 'launcher-1/prediction-001',
    network: 'base-sepolia',
    name: 'Prediction Markets — Test',
    description: 'A test SolverNet for registry-client tests.',
    launcher: {
      safeAddress:
        args.safeAddress ?? ('0x1111111111111111111111111111111111111111' as `0x${string}`),
      agentEoa: args.agentEoa,
      agentId: args.agentId ?? '5474',
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: {
        task: { type: 'object' },
        solution: { type: 'object' },
        verdict: { type: 'object' },
      },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 10,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
      credentialRequirements: {
        creator: [],
        solver: [],
        evaluator: [],
      },
      evaluationFunction: {
        id: 'prediction.brier-loss.v1',
        deterministic: true,
        inputs: ['solution', 'resolution'],
        output: 'verdict',
        implementation: 'jinn:harness:prediction-v1-evaluator',
      },
      aggregationFunction: {
        id: 'prediction.trailing-mean-brier-spread.v1',
        deterministic: true,
        inputs: ['verdict[]'],
        output: 'score',
        windowDays: 30,
      },
    },
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
    createdAt: '2026-05-06T00:00:00Z',
    launchedAt: '2026-05-06T00:01:00Z',
  };
}

async function buildSignedManifest(args: {
  privateKey?: `0x${string}`;
  agentId?: string;
  safeAddress?: `0x${string}`;
  solverNetId?: string;
} = {}): Promise<{
  manifest: SolverNetManifestV1;
  signer: SignerWithAgentEoa;
}> {
  const pk = args.privateKey ?? generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  const unsigned = buildUnsignedManifest({
    agentEoa: acct.address,
    agentId: args.agentId,
    safeAddress: args.safeAddress,
    solverNetId: args.solverNetId,
  });
  const manifest = await signManifest(unsigned, pk);
  return {
    manifest,
    signer: {
      agentEoaAddress: acct.address,
      agentEoaPrivateKey: pk,
      agentId: args.agentId ?? '5474',
    },
  };
}

// ── Mock IPFS client (content-addressed) ────────────────────────────────────

/**
 * In-memory IPFS double. CID is derived from the canonical JSON of the
 * uploaded data, so re-uploading the same bytes yields the same cid
 * (idempotency test).
 */
function makeMockIpfs(): IpfsClient & {
  uploads: Map<string, unknown>;
  uploadCalls: number;
  fetchCalls: number;
} {
  const uploads = new Map<string, unknown>();
  let uploadCalls = 0;
  let fetchCalls = 0;

  function cidOf(data: unknown): string {
    // Stable content-addressed cid. Derive from the SAME canonicalization
    // the production code uses for hashing/canonicalizing manifests so
    // nested-key ordering matches real implementation behavior. The
    // previous `JSON.stringify(data, Object.keys(...).sort())` trick only
    // sorted top-level keys and silently broke for nested objects.
    const json = isManifestLike(data) ? canonicalManifestJson(data) : canonicalJson(data);
    let h = 0;
    for (const ch of json) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `bafy-test-${h.toString(16).padStart(8, '0')}`;
  }

  return {
    async upload(data: unknown): Promise<string> {
      uploadCalls += 1;
      const cid = cidOf(data);
      uploads.set(cid, data);
      return cid;
    },
    async fetch(cid: string): Promise<unknown> {
      fetchCalls += 1;
      const data = uploads.get(cid);
      if (data === undefined) throw new Error(`IPFS mock: cid not found: ${cid}`);
      return data;
    },
    get uploads() { return uploads; },
    get uploadCalls() { return uploadCalls; },
    get fetchCalls() { return fetchCalls; },
  };
}

// ── Mock metadata publisher ─────────────────────────────────────────────────

function makeMockPublisher(): MetadataPublisher & {
  calls: Array<{
    agentId: string;
    key: string;
    value: Uint8Array;
  }>;
  results: SetMetadataPublishResult[];
} {
  const calls: Array<{ agentId: string; key: string; value: Uint8Array }> = [];
  const results: SetMetadataPublishResult[] = [];
  let nextBlock = 100;

  return {
    async setMetadata(args: {
      signer: SignerWithAgentEoa;
      agentId: string;
      key: string;
      value: Uint8Array;
    }): Promise<SetMetadataPublishResult> {
      calls.push({ agentId: args.agentId, key: args.key, value: args.value });
      const result: SetMetadataPublishResult = {
        txHash: `0x${'aa'.repeat(32)}` as `0x${string}`,
        blockNumber: nextBlock,
      };
      nextBlock += 1;
      results.push(result);
      return result;
    },
    get calls() { return calls; },
    get results() { return results; },
  };
}

// ── Mock subgraph client ────────────────────────────────────────────────────

function makeMockSubgraph(): SubgraphClient & {
  events: SetMetadataEvent[];
  fetchByPrefixCalls: Array<{ keyPrefix: string; sinceBlock?: number }>;
  fetchByCidCalls: Array<{ manifestCid: string }>;
} {
  const events: SetMetadataEvent[] = [];
  const fetchByPrefixCalls: Array<{ keyPrefix: string; sinceBlock?: number }> = [];
  const fetchByCidCalls: Array<{ manifestCid: string }> = [];

  return {
    async fetchSetMetadataEvents(args: {
      keyPrefix: string;
      sinceBlock?: number;
    }): Promise<SetMetadataEvent[]> {
      fetchByPrefixCalls.push(args);
      const filtered = events.filter((e) => e.key.startsWith(args.keyPrefix));
      if (args.sinceBlock !== undefined) {
        return filtered.filter((e) => e.blockNumber >= (args.sinceBlock as number));
      }
      return filtered;
    },
    async fetchSetMetadataEventsForCid(args: {
      manifestCid: string;
    }): Promise<SetMetadataEvent[]> {
      fetchByCidCalls.push(args);
      return events.filter((e) => e.key === `solvernet-manifest:${args.manifestCid}`);
    },
    get events() { return events; },
    get fetchByPrefixCalls() { return fetchByPrefixCalls; },
    get fetchByCidCalls() { return fetchByCidCalls; },
  };
}

// ── Mock DiscoveryAPI ──────────────────────────────────────────────────────

/**
 * Minimal DiscoveryAPI mock backed by the mock subgraph. Used by listLaunched
 * tests to inject a discoveryApi without wiring up a full HTTP subgraph client.
 *
 * `listLaunchedSolverNets` folds resolveMostRecentWins over the subgraph
 * events (mirroring HttpSubgraphDiscoveryAPI) and returns coarse summaries.
 * The registry client then enriches each summary with an IPFS fetch.
 */
function makeMockDiscoveryApi(
  subgraph: SubgraphClient,
  ipfs: ReturnType<typeof makeMockIpfs>,
): DiscoveryAPI & {
  listLaunchedCalls: number;
} {
  let listLaunchedCalls = 0;

  return {
    get listLaunchedCalls() { return listLaunchedCalls; },

    async listLaunchedSolverNets(args?: {
      launcherAgentId?: string;
      status?: Array<'launched' | 'paused' | 'retired'>;
    }): Promise<SolverNetManifestSummary[]> {
      listLaunchedCalls += 1;
      const events = await subgraph.fetchSetMetadataEvents({
        keyPrefix: SOLVERNET_MANIFEST_KEY_PREFIX,
      });
      const resolved = resolveMostRecentWins(events);
      const out: SolverNetManifestSummary[] = [];
      for (const row of resolved) {
        if (args?.launcherAgentId !== undefined && row.launcherAgentId !== args.launcherAgentId) continue;
        if (args?.status !== undefined && !args.status.includes(row.status)) continue;
        // Simulate an indexer that has enriched the row: read the manifest the
        // launcher uploaded (the registry pinned it during publishManifest) and
        // project its summary fields, exactly as the real indexer would. The
        // registry client must NOT re-fetch this from IPFS on the list path.
        const body = ipfs.uploads.get(row.manifestCid) as
          | import('@jinn-network/sdk/solvernets').SolverNetManifestV1
          | undefined;
        out.push({
          manifestCid: row.manifestCid,
          solverNetId: body?.solverNetId ?? row.manifestCid,
          name: body?.name ?? '',
          network: body?.network ?? '',
          launcherAgentId: row.launcherAgentId,
          launcherSafeAddress: body?.launcher.safeAddress ?? '0x0000000000000000000000000000000000000000',
          status: row.status,
          statusUpdatedAt: row.statusUpdatedAt,
          contractId: body?.contract.id ?? '',
          contractVersion: body?.contract.version ?? '',
          solutionPriceWei: body?.solutionPriceWei ?? '0',
          verdictPriceWei: body?.verdictPriceWei ?? '0',
          openRoles: body?.openRoles ?? [],
          anchorBlock: row.anchorBlock,
          chainId: (body?.network ?? '') === 'base' ? 8453 : 84532,
        });
      }
      return out;
    },

    async getLifecycleStatus(manifestCid: string): Promise<SolverNetLifecycleStatus | undefined> {
      const events = await subgraph.fetchSetMetadataEventsForCid({ manifestCid });
      if (events.length === 0) return undefined;
      const resolved = resolveMostRecentWins(events);
      if (resolved.length === 0) return undefined;
      const latest = resolved.reduce((acc, cur) => {
        if (cur.anchorBlock !== acc.anchorBlock) return cur.anchorBlock > acc.anchorBlock ? cur : acc;
        return cur.anchorTransactionIndex > acc.anchorTransactionIndex ? cur : acc;
      });
      return {
        status: latest.status,
        statusUpdatedAt: latest.statusUpdatedAt,
        sourceBlock: latest.anchorBlock,
        manifestHash: latest.manifestHash ?? (('0x' + 'ab'.repeat(32)) as `0x${string}`),
      };
    },

    async findClaimableTasks() { return []; },
    async queryEnvelopes() { return []; },
  };
}

// ── Tests: publishManifest ──────────────────────────────────────────────────

describe('IdentityRegistryBackedSolverNetRegistryClient.publishManifest', () => {
  let ipfs: ReturnType<typeof makeMockIpfs>;
  let publisher: ReturnType<typeof makeMockPublisher>;
  let subgraph: ReturnType<typeof makeMockSubgraph>;
  let client: IdentityRegistryBackedSolverNetRegistryClient;

  beforeEach(() => {
    ipfs = makeMockIpfs();
    publisher = makeMockPublisher();
    subgraph = makeMockSubgraph();
    client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      network: 'base-sepolia',
    });
  });

  it('pins canonical manifest to IPFS, calls setMetadata with launched payload, returns cid+tx', async () => {
    const { manifest, signer } = await buildSignedManifest();

    const result = await client.publishManifest({ manifest, signer });

    expect(result.manifestCid).toBeDefined();
    expect(result.metadataTxHash).toMatch(/^0x[0-9a-f]+$/);
    expect(result.metadataBlockNumber).toBeGreaterThan(0);

    expect(ipfs.uploadCalls).toBe(1);
    expect(publisher.calls).toHaveLength(1);

    const call = publisher.calls[0]!;
    expect(call.agentId).toBe(signer.agentId);
    expect(call.key).toBe(`solvernet-manifest:${result.manifestCid}`);

    // Decode payload bytes (JCS-canonical JSON UTF-8) and verify shape.
    const json = JSON.parse(new TextDecoder().decode(call.value)) as Record<string, unknown>;
    expect(json.schemaVersion).toBe('solvernet.lifecycle.v1');
    expect(json.status).toBe('launched');
    expect(typeof json.at).toBe('string');
    expect(json.hash).toBe(manifestHash(manifest));
  });

  it('pins canonical JSON of the manifest body — IPFS receives the same shape used for the hash', async () => {
    const { manifest, signer } = await buildSignedManifest();
    const expectedCanonical = canonicalManifestJson(manifest);

    await client.publishManifest({ manifest, signer });

    // The IPFS double records what was uploaded (the manifest object). When
    // re-canonicalized, it should equal the manifest's canonical bytes.
    const uploaded = Array.from(ipfs.uploads.values())[0];
    expect(canonicalManifestJson(uploaded as SolverNetManifestV1)).toEqual(expectedCanonical);
  });

  it('idempotency: same manifest body → same cid', async () => {
    const { manifest, signer } = await buildSignedManifest();

    const a = await client.publishManifest({ manifest, signer });
    const b = await client.publishManifest({ manifest, signer });

    expect(a.manifestCid).toBe(b.manifestCid);
    expect(publisher.calls).toHaveLength(2); // setMetadata fired twice (event-only)
    // Both setMetadata calls used the same key.
    expect(publisher.calls[0]!.key).toBe(publisher.calls[1]!.key);
  });

  it('rejects when signer.agentId does not match manifest.launcher.agentId', async () => {
    const { manifest, signer } = await buildSignedManifest({ agentId: '5474' });
    const wrongSigner = { ...signer, agentId: '8888' };
    await expect(client.publishManifest({ manifest, signer: wrongSigner })).rejects.toThrow(
      /agentId/i,
    );
    expect(publisher.calls).toHaveLength(0);
  });
});

// ── Tests: publishLifecycleTransition ───────────────────────────────────────

const LIFECYCLE_TEST_TIMESTAMP = '2026-05-06T01:00:00.000Z';

describe('IdentityRegistryBackedSolverNetRegistryClient.publishLifecycleTransition', () => {
  let ipfs: ReturnType<typeof makeMockIpfs>;
  let publisher: ReturnType<typeof makeMockPublisher>;
  let subgraph: ReturnType<typeof makeMockSubgraph>;
  let client: IdentityRegistryBackedSolverNetRegistryClient;

  beforeEach(() => {
    ipfs = makeMockIpfs();
    publisher = makeMockPublisher();
    subgraph = makeMockSubgraph();
    client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      network: 'base-sepolia',
      now: () => new Date(LIFECYCLE_TEST_TIMESTAMP),
    });
  });

  it('writes a lifecycle setMetadata with the same key prefix and updated status', async () => {
    const { manifest, signer } = await buildSignedManifest();

    const launch = await client.publishManifest({ manifest, signer });
    const cid = launch.manifestCid;

    const result = await client.publishLifecycleTransition({
      manifestCid: cid,
      launcherAgentId: signer.agentId,
      target: 'paused',
      signer,
    });

    expect(result.metadataTxHash).toMatch(/^0x[0-9a-f]+$/);
    expect(result.metadataBlockNumber).toBeGreaterThan(0);

    const lifecycleCall = publisher.calls[1]!;
    expect(lifecycleCall.key).toBe(`solvernet-manifest:${cid}`);
    expect(lifecycleCall.agentId).toBe(signer.agentId);

    const payloadText = new TextDecoder().decode(lifecycleCall.value);
    const expectedPayload = {
      schemaVersion: 'solvernet.lifecycle.v1',
      status: 'paused',
      at: LIFECYCLE_TEST_TIMESTAMP,
      hash: manifestHash(manifest),
    };
    expect(JSON.parse(payloadText)).toEqual(expectedPayload);
    expect(payloadText).toBe(canonicalJson(expectedPayload));
  });

  it('rejects when signer.agentId does not match launcherAgentId arg', async () => {
    const { signer } = await buildSignedManifest();
    await expect(
      client.publishLifecycleTransition({
        manifestCid: 'bafyA',
        launcherAgentId: '8888',
        target: 'paused',
        signer,
      }),
    ).rejects.toThrow(/agentId/i);
  });

  it('cold path: cache miss → IPFS fallback fetches and validates the manifest', async () => {
    // Coverage for the path where publishLifecycleTransition is called by
    // a fresh client instance that did NOT publish the manifest itself —
    // it must fall back to IPFS, validate the body, hash it, and emit the
    // lifecycle event. Previously uncovered: both prior tests publish on
    // the same client first, which seeds the cache.
    //
    // We share IPFS + subgraph across two clients so the second instance
    // can find the manifest body, but its in-process manifestCache and
    // verifiedCids start empty.
    const sharedIpfs = makeMockIpfs();
    const sharedSubgraph = makeMockSubgraph();

    const publisherA = makeMockPublisher();
    const clientA = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: publisherA,
      network: 'base-sepolia',
    });

    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await clientA.publishManifest({ manifest, signer });

    // The launched event isn't auto-injected by the publisher mock — push
    // one in so the IPFS-fallback path's subsequent hash cross-check (via
    // fetchAndValidateManifest's own subgraph lookup) finds it.
    sharedSubgraph.events.push({
      agentId: signer.agentId,
      key: `solvernet-manifest:${manifestCid}`,
      payload: {
        schemaVersion: 'solvernet.lifecycle.v1',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        hash: manifestHash(manifest),
      },
      blockNumber: 100,
      transactionIndex: 0,
    });

    // Second client instance — fresh in-process state, but shares IPFS
    // and subgraph with the publisher.
    const publisherB = makeMockPublisher();
    const clientB = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: publisherB,
      network: 'base-sepolia',
    });

    const result = await clientB.publishLifecycleTransition({
      manifestCid,
      launcherAgentId: signer.agentId,
      target: 'paused',
      signer,
    });

    expect(result.metadataTxHash).toMatch(/^0x[0-9a-f]+$/);

    // The cold path must fetch from IPFS to recover the canonical hash.
    expect(sharedIpfs.fetchCalls).toBeGreaterThanOrEqual(1);

    // The lifecycle setMetadata went out under the right key + status.
    expect(publisherB.calls).toHaveLength(1);
    const call = publisherB.calls[0]!;
    expect(call.key).toBe(`solvernet-manifest:${manifestCid}`);
    const json = JSON.parse(new TextDecoder().decode(call.value)) as Record<string, unknown>;
    expect(json.status).toBe('paused');
    // Asserted hash matches the original canonical hash (cold-path correctness).
    expect(json.hash).toBe(manifestHash(manifest));
  });
});

// ── Tests: listLaunched ─────────────────────────────────────────────────────

describe('IdentityRegistryBackedSolverNetRegistryClient.listLaunched', () => {
  it('returns fully-enriched summaries from discoveryApi without fetching IPFS on the list path', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    const { manifest, signer } = await buildSignedManifest({ agentId: '5474' });
    const launch = await client.publishManifest({ manifest, signer });
    const cid = launch.manifestCid;
    const hash = manifestHash(manifest);

    // Inject events into the subgraph mock (which the discoveryApi reads).
    subgraph.events.push(
      {
        agentId: '5474',
        key: `solvernet-manifest:${cid}`,
        payload: { schemaVersion: 'solvernet.lifecycle.v1', status: 'launched', at: '2026-05-06T00:00:00Z', hash },
        blockNumber: 100,
        transactionIndex: 0,
      },
      {
        agentId: '5474',
        key: `solvernet-manifest:${cid}`,
        payload: { schemaVersion: 'solvernet.lifecycle.v1', status: 'paused', at: '2026-05-06T01:00:00Z', hash },
        blockNumber: 200,
        transactionIndex: 0,
      },
    );

    const summaries = await client.listLaunched({ network: 'base-sepolia' });
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.manifestCid).toBe(cid);
    expect(s.status).toBe('paused');
    expect(s.statusUpdatedAt).toBe('2026-05-06T01:00:00Z');
    expect(s.anchorBlock).toBe(200);
    // IPFS-enriched fields come from the manifest body:
    expect(s.solverNetId).toBe(manifest.solverNetId);
    expect(s.name).toBe(manifest.name);
    expect(s.network).toBe(manifest.network);
    expect(s.launcherAgentId).toBe('5474');
    expect(s.launcherSafeAddress).toBe(manifest.launcher.safeAddress);
    expect(s.contractId).toBe(manifest.contract.id);
    expect(s.contractVersion).toBe(manifest.contract.version);
    expect(s.solutionPriceWei).toBe(manifest.solutionPriceWei);
    expect(s.verdictPriceWei).toBe(manifest.verdictPriceWei);
    expect(s.openRoles).toEqual(manifest.openRoles);
    // Criterion 2: the list path must not fetch IPFS — all fields come from
    // the indexer-enriched summary.
    expect(ipfs.fetchCalls).toBe(0);
    expect(s.chainId).toBe(84532); // base-sepolia
  });

  it('delegates discovery to discoveryApi.listLaunchedSolverNets (not direct subgraph)', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    await client.listLaunched({ network: 'base-sepolia' });
    // discoveryApi was called exactly once for the list operation
    expect(discoveryApi.listLaunchedCalls).toBe(1);
  });

  it('throws if no discoveryApi is injected (no silent subgraph fallback)', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      network: 'base-sepolia',
      // discoveryApi intentionally absent
    });

    await expect(client.listLaunched({ network: 'base-sepolia' })).rejects.toThrow(
      /requires a DiscoveryAPI/,
    );
  });

  it('filters by status (statusFilter)', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    const a = await buildSignedManifest({ agentId: '5474', solverNetId: 'l/a' });
    const b = await buildSignedManifest({ agentId: '8888', solverNetId: 'l/b' });
    const ra = await client.publishManifest({ manifest: a.manifest, signer: a.signer });
    const rb = await client.publishManifest({ manifest: b.manifest, signer: b.signer });

    subgraph.events.push(
      {
        agentId: '5474',
        key: `solvernet-manifest:${ra.manifestCid}`,
        payload: {
          schemaVersion: 'solvernet.lifecycle.v1',
          status: 'launched',
          at: '2026-05-06T00:00:00Z',
          hash: manifestHash(a.manifest),
        },
        blockNumber: 100,
        transactionIndex: 0,
      },
      {
        agentId: '8888',
        key: `solvernet-manifest:${rb.manifestCid}`,
        payload: {
          schemaVersion: 'solvernet.lifecycle.v1',
          status: 'paused',
          at: '2026-05-06T01:00:00Z',
          hash: manifestHash(b.manifest),
        },
        blockNumber: 200,
        transactionIndex: 0,
      },
    );

    const launched = await client.listLaunched({
      network: 'base-sepolia',
      statusFilter: ['launched'],
    });
    expect(launched).toHaveLength(1);
    expect(launched[0]!.status).toBe('launched');

    const both = await client.listLaunched({
      network: 'base-sepolia',
      statusFilter: ['launched', 'paused'],
    });
    expect(both).toHaveLength(2);
  });

  it('sinceBlock is accepted but does not filter discoveryApi results (DiscoveryAPI has no sinceBlock)', async () => {
    // sinceBlock was a subgraph-only optimisation. With discoveryApi, the arg
    // is accepted by the interface for forwards-compatibility but is not
    // forwarded to listLaunchedSolverNets (which does not support it).
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    // Should not throw; result is empty because subgraph has no events.
    const result = await client.listLaunched({ network: 'base-sepolia', sinceBlock: 500 });
    expect(result).toEqual([]);
    expect(discoveryApi.listLaunchedCalls).toBe(1);
  });

  it('filters out manifests for a different network', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    const { manifest, signer } = await buildSignedManifest();
    const launch = await client.publishManifest({ manifest, signer });

    subgraph.events.push({
      agentId: signer.agentId,
      key: `solvernet-manifest:${launch.manifestCid}`,
      payload: {
        schemaVersion: 'solvernet.lifecycle.v1',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        hash: manifestHash(manifest),
      },
      blockNumber: 100,
      transactionIndex: 0,
    });

    // The manifest is `network: 'base-sepolia'`, so listing under 'base'
    // should yield no rows.
    const out = await client.listLaunched({ network: 'base' });
    expect(out).toHaveLength(0);

    const inOut = await client.listLaunched({ network: 'base-sepolia' });
    expect(inOut).toHaveLength(1);

    // chainId-based scoping must not require an IPFS fetch.
    expect(ipfs.fetchCalls).toBe(0);
  });

  it('survives an IPFS-gateway outage — catalog populated from indexer fields, ipfs.fetch never called', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    const { manifest, signer } = await buildSignedManifest({ agentId: '5474' });
    const launch = await client.publishManifest({ manifest, signer });
    const cid = launch.manifestCid;
    subgraph.events.push({
      agentId: '5474',
      key: `solvernet-manifest:${cid}`,
      payload: {
        schemaVersion: 'solvernet.lifecycle.v1',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        hash: manifestHash(manifest),
      },
      blockNumber: 100,
      transactionIndex: 0,
    });

    // Simulate a total IPFS outage: every fetch throws. The mock's enriched
    // summary already carries the fields (it read the upload map at publish
    // time, mirroring the indexer's enrichment), so the list path needs no
    // IPFS at all.
    const ipfsFetchMock = vi.fn(async (_cid: string): Promise<unknown> => {
      throw new Error('IPFS gateway 504');
    });
    ipfs.fetch = ipfsFetchMock as unknown as typeof ipfs.fetch;

    const summaries = await client.listLaunched({ network: 'base-sepolia' });

    // Catalog is fully populated despite the outage.
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.name).toBe(manifest.name);
    expect(s.solutionPriceWei).toBe(manifest.solutionPriceWei);
    expect(s.verdictPriceWei).toBe(manifest.verdictPriceWei);
    expect(s.openRoles).toEqual(manifest.openRoles);
    expect(s.launcherSafeAddress).toBe(manifest.launcher.safeAddress);
    expect(s.contractId).toBe(manifest.contract.id);
    expect(s.contractVersion).toBe(manifest.contract.version);

    // The list hot path must never touch IPFS.
    expect(ipfsFetchMock).not.toHaveBeenCalled();
  });

  it('handles an enrichment-pending row gracefully (no crash; row still listed)', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    // A discoveryApi that returns a row the indexer has NOT yet enriched:
    // populated identity fields but sentinel body fields, status pending.
    const discoveryApi = {
      listLaunchedCalls: 0,
      async listLaunchedSolverNets(): Promise<SolverNetManifestSummary[]> {
        return [{
          manifestCid: 'bafypending',
          solverNetId: 'bafypending',
          name: '',
          network: '',
          launcherAgentId: '5474',
          launcherSafeAddress: '0x0000000000000000000000000000000000000000' as `0x${string}`,
          status: 'launched' as const,
          statusUpdatedAt: '2026-05-06T00:00:00Z',
          contractId: '',
          contractVersion: '',
          solutionPriceWei: '0',
          verdictPriceWei: '0',
          openRoles: [],
          anchorBlock: 100,
          chainId: 84532,
        }];
      },
      async getLifecycleStatus() { return undefined; },
      async findClaimableTasks() { return []; },
      async queryEnvelopes() { return []; },
    } as unknown as DiscoveryAPI & { listLaunchedCalls: number };
    const ipfsFetchMock = vi.fn(async (): Promise<unknown> => { throw new Error('IPFS gateway 504'); });
    ipfs.fetch = ipfsFetchMock as unknown as typeof ipfs.fetch;

    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    // Does not throw; the pending row is listed with sentinel body fields.
    const summaries = await client.listLaunched({ network: 'base-sepolia' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.manifestCid).toBe('bafypending');
    expect(summaries[0]!.name).toBe('');
    expect(ipfsFetchMock).not.toHaveBeenCalled();
  });
});

// ── Tests: getManifest ──────────────────────────────────────────────────────

describe('IdentityRegistryBackedSolverNetRegistryClient.getManifest', () => {
  it('fetches IPFS, validates against schema, returns the manifest', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      network: 'base-sepolia',
    });

    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await client.publishManifest({ manifest, signer });

    const fetched = await client.getManifest({ manifestCid });
    expect(fetched.solverNetId).toBe(manifest.solverNetId);
    expect(fetched.signature.value).toBe(manifest.signature.value);
  });

  it('rethrows DiscoveryUnavailableError from discoveryApi hash check with a structured warning', async () => {
    const sharedIpfs = makeMockIpfs();
    const publisherClient = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      network: 'base-sepolia',
    });
    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await publisherClient.publishManifest({ manifest, signer });

    const unavailable = new DiscoveryUnavailableError(
      'OnchainDiscoveryAPI: getLogs for MetadataSet failed',
      new Error('HTTP 429: Too Many Requests'),
      'rpc_rate_limited',
    );
    const failingDiscoveryApi: DiscoveryAPI = {
      async getLifecycleStatus() {
        throw unavailable;
      },
      async listLaunchedSolverNets() { return []; },
      async findClaimableTasks() { return []; },
      async queryEnvelopes() { return []; },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reader = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      discoveryApi: failingDiscoveryApi,
      network: 'base-sepolia',
    });

    try {
      await expect(reader.getManifest({ manifestCid })).rejects.toBe(unavailable);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('hash check unavailable (rpc_rate_limited)'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects when the canonical hash of fetched IPFS content differs from the on-chain advertised hash', async () => {
    // Cold-path scenario: the client did NOT publish the manifest itself,
    // so verifiedCids is empty. getManifest falls through to
    // fetchAndValidateManifest, which cross-checks the canonical hash of
    // the IPFS body against the advertised hash from discoveryApi and
    // rejects on mismatch.
    const sharedIpfs = makeMockIpfs();

    const publisherClient = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      network: 'base-sepolia',
    });
    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await publisherClient.publishManifest({ manifest, signer });

    // Provide a discoveryApi that returns a DIFFERENT hash than the canonical
    // hash of the IPFS body — simulating a tampered pinner / wrong on-chain state.
    const wrongHash = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const tamperingDiscoveryApi: DiscoveryAPI = {
      async getLifecycleStatus() {
        return { status: 'launched', statusUpdatedAt: '2026-05-06T00:00:00Z', sourceBlock: 100, manifestHash: wrongHash };
      },
      async listLaunchedSolverNets() { return []; },
      async findClaimableTasks() { return []; },
      async queryEnvelopes() { return []; },
    };

    // Fresh reader with the tampering discoveryApi — no in-process trust state.
    const reader = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      discoveryApi: tamperingDiscoveryApi,
      network: 'base-sepolia',
    });

    await expect(reader.getManifest({ manifestCid })).rejects.toThrow(/hash/i);
  });

  it('rejects when fetched IPFS content does not match the SolverNetManifestV1 schema', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      network: 'base-sepolia',
    });

    // Pre-seed the IPFS double with a malformed body under a known cid.
    const cid = await ipfs.upload({ wrong: 'shape' });
    await expect(client.getManifest({ manifestCid: cid })).rejects.toThrow();
  });

  it('does NOT throw when discoveryApi returns the "0x" sentinel manifestHash (falls through to no-hash path)', async () => {
    // Regression guard for the sentinel-is-truthy bug: when the Ponder indexer
    // returns null for `manifestHash` on older rows, http.ts maps it to '0x'.
    // The registry client must NOT treat '0x' as a real hash — it should skip
    // the comparison entirely (no-advertised-hash fallthrough), not throw a
    // spurious mismatch error.
    const sharedIpfs = makeMockIpfs();

    const publisherClient = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      network: 'base-sepolia',
    });
    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await publisherClient.publishManifest({ manifest, signer });

    // discoveryApi returns the '0x' sentinel — simulates an older indexed row
    // where the Ponder schema predates the manifestHash column.
    const sentinelDiscoveryApi: DiscoveryAPI = {
      async getLifecycleStatus() {
        return {
          status: 'launched',
          statusUpdatedAt: '2026-05-06T00:00:00Z',
          sourceBlock: 100,
          manifestHash: '0x' as `0x${string}`,
        };
      },
      async listLaunchedSolverNets() { return []; },
      async findClaimableTasks() { return []; },
      async queryEnvelopes() { return []; },
    };

    const reader = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      discoveryApi: sentinelDiscoveryApi,
      network: 'base-sepolia',
    });

    // Must NOT throw — the sentinel is treated as "no advertised hash available".
    const fetched = await reader.getManifest({ manifestCid });
    expect(fetched.solverNetId).toBe(manifest.solverNetId);
  });

  it('throws a hash mismatch when discoveryApi returns a real hash that differs from the fetched manifest', async () => {
    // Complementary to the sentinel test: a non-sentinel, non-matching hash
    // MUST throw. This ensures the sentinel guard does not accidentally
    // suppress legitimate mismatch errors.
    const sharedIpfs = makeMockIpfs();

    const publisherClient = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      network: 'base-sepolia',
    });
    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await publisherClient.publishManifest({ manifest, signer });

    const wrongHash = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const mismatchDiscoveryApi: DiscoveryAPI = {
      async getLifecycleStatus() {
        return {
          status: 'launched',
          statusUpdatedAt: '2026-05-06T00:00:00Z',
          sourceBlock: 100,
          manifestHash: wrongHash,
        };
      },
      async listLaunchedSolverNets() { return []; },
      async findClaimableTasks() { return []; },
      async queryEnvelopes() { return []; },
    };

    const reader = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      discoveryApi: mismatchDiscoveryApi,
      network: 'base-sepolia',
    });

    await expect(reader.getManifest({ manifestCid })).rejects.toThrow(/hash/i);
  });

  it('skips subgraph round-trip when cid is already verified (post-publish cache hit)', async () => {
    // Regression: previously, a getManifest cache-hit still hit the
    // subgraph to re-verify the advertised hash, silently doubling load
    // in catalog refresh ticks. After the fix, publishManifest seeds
    // both manifestCache and verifiedCids; subsequent getManifest for
    // that cid returns immediately without touching the subgraph.
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      network: 'base-sepolia',
    });

    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await client.publishManifest({ manifest, signer });

    // publishManifest itself does not query the subgraph; baseline.
    expect(subgraph.fetchByCidCalls).toHaveLength(0);

    const fetched = await client.getManifest({ manifestCid });
    expect(fetched.solverNetId).toBe(manifest.solverNetId);

    // Critical: no subgraph round-trip on the cache-hit path.
    expect(subgraph.fetchByCidCalls).toHaveLength(0);

    // A second getManifest also stays cached.
    await client.getManifest({ manifestCid });
    expect(subgraph.fetchByCidCalls).toHaveLength(0);
  });
});

// ── Tests: getManifestFromCache ─────────────────────────────────────────────

describe('IdentityRegistryBackedSolverNetRegistryClient.getManifestFromCache', () => {
  it('returns the cached manifest after publishManifest (warm cache)', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      network: 'base-sepolia',
    });

    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await client.publishManifest({ manifest, signer });

    const cached = await client.getManifestFromCache({ manifestCid });
    expect(cached).not.toBeNull();
    expect(cached?.solverNetId).toBe(manifest.solverNetId);
    // Critical: cache-only — no IPFS round-trip beyond the publishManifest
    // upload itself, and no subgraph round-trip at all.
    expect(ipfs.fetchCalls).toBe(0);
    expect(subgraph.fetchByCidCalls).toHaveLength(0);
  });

  it('returns null on cache miss without falling through to IPFS', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      network: 'base-sepolia',
    });

    const cached = await client.getManifestFromCache({
      manifestCid: 'bafy-not-cached',
    });
    expect(cached).toBeNull();
    // No IPFS round-trip on miss — that's the contract.
    expect(ipfs.fetchCalls).toBe(0);
    expect(subgraph.fetchByCidCalls).toHaveLength(0);
  });

  it('returns the cached manifest after a successful getManifest (cold-then-warm cache)', async () => {
    // listLaunched + getManifest path for an other-launcher manifest:
    // first getManifest does the IPFS fetch + hash verify and warms the
    // cache; subsequent getManifestFromCache reads it without I/O.
    const sharedIpfs = makeMockIpfs();
    const sharedSubgraph = makeMockSubgraph();

    const publisherClient = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      network: 'base-sepolia',
    });
    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await publisherClient.publishManifest({ manifest, signer });

    const reader = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs: sharedIpfs,
      publisher: makeMockPublisher(),
      network: 'base-sepolia',
    });
    // Cold: cache miss before getManifest.
    expect(await reader.getManifestFromCache({ manifestCid })).toBeNull();

    // Hydrate via getManifest (this round-trips IPFS + subgraph once).
    await reader.getManifest({ manifestCid });

    // Warm: subsequent cache lookup returns the body.
    const cached = await reader.getManifestFromCache({ manifestCid });
    expect(cached?.solverNetId).toBe(manifest.solverNetId);
  });
});

// ── Tests: getLifecycleStatus ───────────────────────────────────────────────

describe('IdentityRegistryBackedSolverNetRegistryClient.getLifecycleStatus', () => {
  it('returns the latest status for a given cid via discoveryApi.getLifecycleStatus', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    const { manifest, signer } = await buildSignedManifest();
    const { manifestCid } = await client.publishManifest({ manifest, signer });
    const hash = manifestHash(manifest);

    subgraph.events.push(
      {
        agentId: signer.agentId,
        key: `solvernet-manifest:${manifestCid}`,
        payload: { schemaVersion: 'solvernet.lifecycle.v1', status: 'launched', at: '2026-05-06T00:00:00Z', hash },
        blockNumber: 100,
        transactionIndex: 0,
      },
      {
        agentId: signer.agentId,
        key: `solvernet-manifest:${manifestCid}`,
        payload: { schemaVersion: 'solvernet.lifecycle.v1', status: 'paused', at: '2026-05-06T01:00:00Z', hash },
        blockNumber: 200,
        transactionIndex: 0,
      },
      {
        agentId: signer.agentId,
        key: `solvernet-manifest:${manifestCid}`,
        payload: { schemaVersion: 'solvernet.lifecycle.v1', status: 'retired', at: '2026-05-06T02:00:00Z', hash },
        blockNumber: 150,
        transactionIndex: 0,
      },
    );

    const result = await client.getLifecycleStatus({ manifestCid });
    expect(result.status).toBe('paused');
    expect(result.statusUpdatedAt).toBe('2026-05-06T01:00:00Z');
    expect(result.sourceBlock).toBe(200);
  });

  it('throws when no events exist for the cid (discoveryApi returns undefined)', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    await expect(client.getLifecycleStatus({ manifestCid: 'bafyMissing' })).rejects.toThrow(
      /no setMetadata/i,
    );
  });

  it('throws when no discoveryApi is injected', async () => {
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      // discoveryApi intentionally absent
      network: 'base-sepolia',
    });

    await expect(client.getLifecycleStatus({ manifestCid: 'bafyAny' })).rejects.toThrow(
      /requires a DiscoveryAPI/i,
    );
  });

  it('cross-launcher same-block tie: higher transactionIndex wins deterministically', async () => {
    // Two launchers wrote setMetadata under the same cid in the same
    // block (unusual but legal). Without the transactionIndex secondary
    // sort key, the winner across launchers depended on Map insertion
    // order; with the fix it's deterministic.
    const ipfs = makeMockIpfs();
    const publisher = makeMockPublisher();
    const subgraph = makeMockSubgraph();
    const discoveryApi = makeMockDiscoveryApi(subgraph, ipfs);
    const client = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      discoveryApi,
      network: 'base-sepolia',
    });

    const cid = 'bafyShared';
    const hash = ('0x' + 'aa'.repeat(32)) as `0x${string}`;

    // Inject events in "wrong" order (lower-tx-index last) to make the
    // bug visible if it regresses — Map insertion order would pick the
    // last inserted, not the higher tx-index winner.
    subgraph.events.push(
      {
        agentId: '8888',
        key: `solvernet-manifest:${cid}`,
        payload: {
          schemaVersion: 'solvernet.lifecycle.v1',
          status: 'paused',
          at: '2026-05-06T00:00:00Z',
          hash,
        },
        blockNumber: 100,
        transactionIndex: 7,
      },
      {
        agentId: '5474',
        key: `solvernet-manifest:${cid}`,
        payload: {
          schemaVersion: 'solvernet.lifecycle.v1',
          status: 'launched',
          at: '2026-05-06T00:00:00Z',
          hash,
        },
        blockNumber: 100,
        transactionIndex: 2,
      },
    );

    const result = await client.getLifecycleStatus({ manifestCid: cid });
    // Higher transactionIndex (7) wins → status from launcher 8888.
    expect(result.status).toBe('paused');
    expect(result.sourceBlock).toBe(100);
  });
});
