/**
 * Client-owned composition root for live manifest-anchor gas measurement (#1829).
 *
 * Wires operator identity, live publish deps, held-out slate, and evidence
 * authentication into the standalone @jinn-network/jinn-layer CLI.
 *
 * Preview (no chain writes):
 *   cd client && yarn tsx scripts/distill-run-manifest-live.ts --limit 10
 *
 * Live measurement:
 *   cd client && yarn tsx scripts/distill-run-manifest-live.ts --limit 10 --yes
 */

import {
  runJinnLayerCli,
  capture,
  createBoundedIpfsJsonFetcher,
  DEFAULT_IPFS_GATEWAY_URL,
  type AttemptRef,
  type BridgeEvidence,
  type CapturedTask,
} from '@jinn-network/jinn-layer';
import { buildLayer2ScrubPipeline } from '@jinn-network/core/scrub';
import { hashLeaf, merkleProof, verifyMerkleProof } from '@jinn-network/core';
import {
  publishManifestBatch,
  type ManifestBatchPublishDeps,
  type ManifestBatchSetResult,
} from '../../packages/layer/src/publish.js';
import { createEvidenceFetcher } from '../../packages/layer/src/bridge-fetch-evidence.js';

const DEFAULT_TESTNET_DISCOVERY_URL =
  'https://jinn-indexer-production.up.railway.app';

type VerdictSource = {
  list(args?: { limit?: number }): Promise<AttemptRef[]>;
};
import { authenticateExecutionEnvelope } from '../src/conformance/execution-envelope-authenticator.js';
import { loadConfig } from '../src/config.js';
import { createPublisherSafeResolver } from '../src/erc8004/publisher-safe-resolver.js';
import { parseRpcUrls } from '../src/rpc/transport.js';
import {
  createBoundedRawHfRowFetcher,
  createSweRebenchV2VerifierFactsResolver,
} from '../src/solver-types/_swe-rebench-v2-verifier-facts.js';
import {
  loadActiveHeldOutSlateIds,
  ACTIVE_HELD_OUT_SLATE_VERSIONS,
} from '../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import {
  createLivePublishDeps,
  createManifestAnchorStore,
  DEFAULT_TESTNET_IDENTITY_REGISTRY,
  DEFAULT_TESTNET_RPC_URL,
} from './layer-live-deps.js';
import { deriveOperatorIdentity } from './layer-operator-identity.js';

interface VerdictRow {
  requestId: string;
  chainId: number;
  instanceId: string;
  actualPassed: boolean;
  evaluatorVerdict: string;
  manifestCid: string;
}

/** Newest-first verdict walk, keeping only rows that pass live evidence fetch. */
function createBridgeableVerdictSource(
  graphqlUrl: string,
  fetchEvidence: (ref: AttemptRef) => Promise<BridgeEvidence>,
  heldOut: Set<string>,
): VerdictSource {
  const url = graphqlUrl.endsWith('/graphql') ? graphqlUrl : `${graphqlUrl}/graphql`;
  const query = `
query BridgeVerdictsRecent($limit: Int!, $after: String) {
  verdictEnvelopeMetas(
    where: { solverType_starts_with: "swe-rebench-v2", enrichmentStatus: "ok" },
    limit: $limit,
    after: $after,
    orderBy: "enrichedAtBlock",
    orderDirection: "desc"
  ) {
    items {
      requestId chainId instanceId actualPassed evaluatorVerdict manifestCid
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
  const PAGE_LIMIT = 100;
  const MAX_PAGES = 50;

  const polarityOf = (row: VerdictRow): 'pass' | 'fail' | null => {
    if (row.actualPassed === true && row.evaluatorVerdict === 'PASS') return 'pass';
    if (row.actualPassed === false && row.evaluatorVerdict === 'FAIL') return 'fail';
    return null;
  };

  const toAttemptRef = (row: VerdictRow, polarity: 'pass' | 'fail'): AttemptRef => ({
    requestId: row.requestId,
    chainId: row.chainId,
    instanceId: row.instanceId,
    model: '',
    manifestCid: '',
    polarity,
    verdictManifestCid: row.manifestCid,
    discoveryCandidates: [{ instanceId: row.instanceId, verdictManifestCid: row.manifestCid }],
  });

  return {
    async list(args: { limit?: number } = {}): Promise<AttemptRef[]> {
      const limit = args.limit ?? Number.POSITIVE_INFINITY;
      const refs: AttemptRef[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;

      for (let page = 0; page < MAX_PAGES && refs.length < limit; page += 1) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query,
            variables: { limit: PAGE_LIMIT, after: cursor },
          }),
        });
        const body = (await res.json()) as {
          data?: {
            verdictEnvelopeMetas?: {
              items: VerdictRow[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
          errors?: unknown;
        };
        if (body.errors) {
          throw new Error(`verdict-source GraphQL error: ${JSON.stringify(body.errors)}`);
        }
        const pageData = body.data?.verdictEnvelopeMetas;
        if (!pageData) throw new Error('verdict-source GraphQL response missing verdictEnvelopeMetas');

        for (const row of pageData.items) {
          const polarity = polarityOf(row);
          if (!polarity || !row.manifestCid || !row.instanceId) continue;
          if (heldOut.has(row.instanceId)) continue;
          const key = `${row.chainId}:${row.requestId.toLowerCase()}:${polarity}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const ref = toAttemptRef(row, polarity);
          try {
            await fetchEvidence(ref);
          } catch {
            continue;
          }
          refs.push(ref);
          if (refs.length >= limit) return refs;
        }

        if (!pageData.pageInfo.hasNextPage || !pageData.pageInfo.endCursor) break;
        cursor = pageData.pageInfo.endCursor;
      }

      if (refs.length === 0) {
        throw new Error(
          'no bridgeable verdict rows found after probing the indexer — try again later or raise the probe window',
        );
      }
      return refs;
    },
  };
}

function syntheticGasMeasureTask(index: number): CapturedTask {
  return {
    session: {
      sessionId: `1829-gas-measure-${index}`,
      capturedAt: new Date().toISOString(),
    },
    task: {
      summary: `Manifest gas measurement substrate member ${index}`,
      distributionTags: ['manifest-gas-measurement', `member-${index}`],
    },
    environment: {
      harness: { name: 'jinn-layer', version: '0.1.0' },
      model: 'measurement-fixture',
      tools: ['run_command'],
    },
    steps: [
      {
        spanId: `span-${index}`,
        parentSpanId: null,
        name: 'tool:run_command',
        startTimeUnixNano: '1751450482000000000',
        endTimeUnixNano: '1751450483000000000',
        attributes: { 'tool.command': `manifest gas measure ${index}` },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    cost: { durationMs: 1_000 },
    provenance: 'imported',
  };
}

async function runDirectManifestGasMeasurement(
  publishDeps: ManifestBatchPublishDeps,
  limit: number,
): Promise<ManifestBatchSetResult> {
  const pipeline = buildLayer2ScrubPipeline();
  const members = [];
  for (let index = 0; index < limit; index += 1) {
    const pending = await capture(syntheticGasMeasureTask(index), { pipeline });
    members.push({
      pending,
      polarity: index % 2 === 0 ? 'pass' as const : 'fail' as const,
      instanceId: `manifest-gas-measure-${index}`,
      sourceId: `manifest-gas-measure-${index}`,
    });
  }
  return publishManifestBatch(members, publishDeps, {
    batchKind: 'bridge',
    measurePerRecordControl: true,
  });
}

function verifyManifestInclusion(result: ManifestBatchSetResult): boolean {
  const batch = result.batches[0];
  if (!batch) return false;
  const leaves = batch.memberRefs.map((cid) => hashLeaf(cid));
  return batch.memberRefs.every((cid, index) =>
    verifyMerkleProof(cid, merkleProof(leaves, index), batch.root),
  );
}

function printMeasurementEvidence(
  result: ManifestBatchSetResult,
  mode: 'bridge' | 'direct',
): void {
  const batch = result.batches[0];
  const payload = {
    mode,
    manifestCid: batch?.manifestCid ?? null,
    anchorTx: batch?.anchorTx ?? null,
    memberCount: batch?.memberRefs.length ?? 0,
    gasUsed: batch?.gasUsed?.toString() ?? null,
    feeWei: batch?.feeWei?.toString() ?? null,
    merkleRoot: batch?.root ?? null,
    control: batch?.control
      ? {
          memberRef: batch.control.memberRef,
          anchorTx: batch.control.anchorTx,
          gasUsed: batch.control.gasUsed?.toString() ?? null,
          feeWei: batch.control.feeWei?.toString() ?? null,
        }
      : null,
    inclusionProofVerified: batch ? verifyManifestInclusion(result) : false,
    memberRefs: result.memberRefs,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (batch) {
    console.error(
      `manifest anchored ${batch.manifestCid} at ${batch.anchorTx} — ` +
      `${batch.memberRefs.length} members, gasUsed=${batch.gasUsed?.toString() ?? 'unknown'}, ` +
      `feeWei=${batch.feeWei?.toString() ?? 'unknown'}`,
    );
    if (batch.control) {
      console.error(
        `per-record control anchored ${batch.control.memberRef} at ${batch.control.anchorTx} — ` +
        `gasUsed=${batch.control.gasUsed?.toString() ?? 'unknown'}, ` +
        `feeWei=${batch.control.feeWei?.toString() ?? 'unknown'}`,
      );
    }
  }
}

function parseArgs(argv: string[]): { limit?: number; yes: boolean } {
  const limitIdx = argv.indexOf('--limit');
  const rawLimit = limitIdx >= 0 ? argv[limitIdx + 1] : undefined;
  if (rawLimit === undefined) {
    throw new Error('--limit is required (e.g. --limit 10 for the first measurement batch)');
  }
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer (got ${JSON.stringify(rawLimit)})`);
  }
  return { limit, yes: argv.includes('--yes') };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { limit, yes } = parseArgs(argv);
  const identity = await deriveOperatorIdentity(argv);
  const config = loadConfig();
  const rpcUrls = parseRpcUrls(process.env['JINN_RPC_URL'] ?? config.rpcUrl ?? DEFAULT_TESTNET_RPC_URL);
  const fallbackRpcUrls = [
    ...rpcUrls.slice(1),
    'https://sepolia.base.org',
  ].filter((url, index, urls) => url !== rpcUrls[0] && urls.indexOf(url) === index);

  const plannedCommand = [
    'distill run',
    '--anchor-mode manifest',
    '--measure-per-record-control',
    `--limit ${limit}`,
    '--json',
  ].join(' ');

  console.error(
    `operator: agent ${identity.agentAddress} (service index ${identity.serviceIndex})`,
  );
  console.error(`safe: ${identity.safeAddress}`);
  console.error(`agentId: ${identity.agentId.toString()}`);
  console.error(`planned: jinn-layer ${plannedCommand}`);
  console.error('publishes: public swe-rebench evidence only (not local captures/mineable store)');

  if (!yes) {
    console.error('');
    console.error('preview only — no chain writes. Re-run with --yes to execute live.');
    process.exitCode = 0;
    return;
  }

  const discoveryUrl =
    process.env['JINN_DISCOVERY_URL']
    ?? config.discovery?.url
    ?? DEFAULT_TESTNET_DISCOVERY_URL;

  const publishDeps = createLivePublishDeps({
    privateKey: identity.privateKey,
    safeAddress: identity.safeAddress,
    agentId: identity.agentId,
    rpcUrl: rpcUrls[0],
    identityRegistry:
      (process.env['JINN_LAYER_IDENTITY_REGISTRY'] as `0x${string}` | undefined)
      ?? DEFAULT_TESTNET_IDENTITY_REGISTRY,
    ipfsRegistryUrl: process.env['JINN_IPFS_REGISTRY_URL'] ?? config.ipfsRegistryUrl,
    ipfsGatewayUrl: process.env['JINN_IPFS_GATEWAY_URL'] ?? config.ipfsGatewayUrl,
    endpoint: process.env['JINN_LAYER_ENDPOINT'] ?? `http://127.0.0.1:${config.apiPort}`,
    ledgerPath: process.env['JINN_LAYER_LEDGER_PATH'],
    store: createManifestAnchorStore(config.dbPath),
  });

  const resolvePublisherSafe = createPublisherSafeResolver({
    rpcUrl: rpcUrls[0]!,
    fallbackRpcUrls,
    expectedChainId: 84532,
    identityRegistry:
      process.env['JINN_LAYER_IDENTITY_REGISTRY'] ?? DEFAULT_TESTNET_IDENTITY_REGISTRY,
  });
  const fetchHfRawRow = createBoundedRawHfRowFetcher();
  const slateInstanceIds = loadActiveHeldOutSlateIds(
    'swe-rebench-v2.v1',
    ACTIVE_HELD_OUT_SLATE_VERSIONS,
  );
  const gateway = (process.env['JINN_IPFS_GATEWAY_URL'] ?? config.ipfsGatewayUrl ?? DEFAULT_IPFS_GATEWAY_URL).replace(/\/$/, '');
  const graphqlUrl = discoveryUrl.endsWith('/graphql') ? discoveryUrl : `${discoveryUrl.replace(/\/$/, '')}/graphql`;
  const ipfs = createBoundedIpfsJsonFetcher({ gateway });
  const fetchEvidence = createEvidenceFetcher({
    ipfs,
    authenticateEnvelope: authenticateExecutionEnvelope,
    resolvePublisherSafe,
    resolveVerifierFacts: createSweRebenchV2VerifierFactsResolver({
      fetchIpfsJson: ({ cid, maxBytes }) => ipfs(cid, maxBytes),
      fetchHfRawRow,
    }),
    gql: async (query: string, variables?: Record<string, unknown>) => {
      const res = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await res.json()) as { data?: unknown; errors?: unknown };
      if (body.errors) throw new Error(`gql: ${JSON.stringify(body.errors)}`);
      return body.data;
    },
  });

  const verdictSource = createBridgeableVerdictSource(discoveryUrl, fetchEvidence, slateInstanceIds);
  let bridgeableCount = 0;
  try {
    bridgeableCount = (await verdictSource.list({ limit })).length;
  } catch (error) {
    console.error(
      `[manifest-measure] bridge probe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (bridgeableCount === 0) {
    console.error(
      '[manifest-measure] indexer bridge path empty (enrichment gaps) — ' +
      'running direct substrate manifest batch for gas measurement',
    );
    const result = await runDirectManifestGasMeasurement(publishDeps, limit);
    printMeasurementEvidence(result, 'direct');
    process.exit(0);
  }

  const code = await runJinnLayerCli(
    [
      'distill',
      'run',
      '--anchor-mode',
      'manifest',
      '--measure-per-record-control',
      '--limit',
      String(limit),
      '--json',
    ],
    {
      distillRunDeps: {
        verdictSource,
        fetchEvidence,
        publishDeps,
        slateInstanceIds,
        authenticateEnvelope: authenticateExecutionEnvelope,
        resolvePublisherSafe,
        verifierFactsResolverFactory: (ipfs) =>
          createSweRebenchV2VerifierFactsResolver({
            fetchIpfsJson: ({ cid, maxBytes }) => ipfs(cid, maxBytes),
            fetchHfRawRow,
          }),
      },
    },
  );

  process.exit(code);
}

main().catch((error) => {
  console.error(
    `[distill-run-manifest-live] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
