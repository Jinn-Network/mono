/**
 * Gate Registry — defines all integration validation gates.
 *
 * Each gate has a tier (when it runs), failure hints (where to look),
 * and optional estimated runtime. The agent reads this to know what to
 * run and where to investigate failures.
 */

export type Tier = 'unit' | 'inspect' | 'tenderly' | 'canary' | 'smoke';

export interface Gate {
  /** Unique gate identifier (e.g. "P1", "W1", "CANARY_DEPLOY") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Which tier this gate belongs to */
  tier: Tier;
  /** Dependencies — gate IDs that must pass before this one runs */
  depends?: string[];
  /** Estimated seconds to run (for timing optimization) */
  estimatedSeconds?: number;
  /** Can the agent fix failures and retry? */
  retryable?: boolean;
  /** Files to read when diagnosing failures */
  failureHints: string[];
  /** For tenderly/canary: which phase within the tier */
  phase?: number;
  /** Description of what this gate proves */
  description: string;
  /** Gate has been retired — skip during runs */
  retired?: boolean;
  /** When this gate was added (ISO date string) */
  addedAt?: string;
  /** What prompted adding this gate */
  addedReason?: string;
}

// ---------------------------------------------------------------------------
// Ponder gates (inspect tier)
// ---------------------------------------------------------------------------

const ponderGates: Gate[] = [
  {
    id: 'P1',
    name: 'Ponder schema has ventureId/templateId',
    tier: 'inspect',
    retryable: true,
    failureHints: ['ponder/ponder.schema.ts', 'ponder/src/index.ts'],
    description: 'Requests store ventureId + templateId from IPFS metadata',
  },
  {
    id: 'P2',
    name: 'Workstream lastStatus populated on delivery',
    tier: 'inspect',
    retryable: true,
    failureHints: ['ponder/ponder.schema.ts', 'ponder/src/index.ts'],
    description: 'Workstream lastStatus + latestStatusUpdate populated on Deliver event',
  },
  {
    id: 'P3',
    name: 'Mech allowlist built at startup',
    tier: 'inspect',
    retryable: true,
    failureHints: ['ponder/src/index.ts'],
    description: 'Mech allowlist at startup, non-Jinn requests skipped',
  },
  {
    id: 'P4',
    name: 'IPFS gateway fallback correct',
    tier: 'inspect',
    retryable: true,
    failureHints: ['ponder/src/index.ts'],
    description: 'No cloudflare-ipfs refs; timeout 1500ms; ipfs.io as fallback',
  },
  {
    id: 'P5',
    name: 'Ponder build has no jinn-node compilation',
    tier: 'inspect',
    retryable: true,
    failureHints: ['ponder/nixpacks.toml', 'deploy/ponder/nixpacks.toml'],
    description: 'ponder/nixpacks.toml no-compile build; no jinn-node imports in ponder/',
  },
  {
    id: 'P6',
    name: 'PONDER_VIEWS_SCHEMA configurable via env',
    tier: 'inspect',
    retryable: true,
    failureHints: ['deploy/ponder/nixpacks.toml'],
    description: 'deploy/ponder/nixpacks.toml uses ${PONDER_VIEWS_SCHEMA:-jinn_gemini_public}',
  },
  {
    id: 'P7',
    name: 'Ponder deployed on correct branch',
    tier: 'inspect',
    retryable: false,
    failureHints: [],
    description: 'Railway Ponder service source branch matches integration branch',
  },
];

// ---------------------------------------------------------------------------
// Worker pipeline gates (tenderly tier)
// ---------------------------------------------------------------------------

const workerTenderlyGates: Gate[] = [
  {
    id: 'W1',
    name: 'On-chain service resolver',
    tier: 'tenderly',
    phase: 1,
    estimatedSeconds: 30,
    retryable: true,
    failureHints: ['jinn-node/src/worker/onchain/serviceResolver.ts', 'jinn-node/src/worker/mech_worker.ts'],
    description: 'On-chain service resolver derives serviceId/multisig/marketplace at startup',
  },
  {
    id: 'W2',
    name: 'VENTURE_FILTER restricts queries',
    tier: 'tenderly',
    phase: 1,
    depends: ['W1'],
    retryable: true,
    failureHints: ['jinn-node/src/worker/mech_worker.ts'],
    description: 'VENTURE_FILTER restricts Ponder queries to matching ventureId',
  },
  {
    id: 'W3',
    name: 'Poll query returns newest first',
    tier: 'tenderly',
    phase: 1,
    depends: ['W1'],
    retryable: true,
    failureHints: ['jinn-node/src/worker/mech_worker.ts'],
    description: 'Poll query returns newest requests first (desc ordering)',
  },
  {
    id: 'W4',
    name: 'WORKSTREAM_FILTER=none handled',
    tier: 'tenderly',
    phase: 1,
    retryable: true,
    failureHints: ['jinn-node/src/worker/mech_worker.ts'],
    description: 'WORKSTREAM_FILTER=none handled as "no filter"',
  },
  {
    id: 'W5',
    name: 'Cross-mech delivery works',
    tier: 'tenderly',
    phase: 3,
    depends: ['W1'],
    estimatedSeconds: 420,
    retryable: true,
    failureHints: ['jinn-node/src/worker/mech_worker.ts', 'jinn-node/src/worker/delivery/'],
    description: 'Cross-mech delivery works after priority window expires',
  },
  {
    id: 'W6',
    name: 'Delivery revert diagnostics',
    tier: 'tenderly',
    phase: 3,
    retryable: true,
    failureHints: ['jinn-node/src/worker/delivery/'],
    description: 'Delivery captures lightweight revert diagnostics on tx failure',
  },
  {
    id: 'W7',
    name: 'Undelivered verification checks mech',
    tier: 'tenderly',
    phase: 3,
    retryable: true,
    failureHints: ['jinn-node/src/worker/mech_worker.ts'],
    description: 'Undelivered verification checks the mech performing delivery',
  },
  {
    id: 'W8',
    name: 'Epoch gate uses on-chain nonces',
    tier: 'tenderly',
    phase: 3,
    retryable: true,
    failureHints: ['jinn-node/src/worker/staking/epochGate.ts'],
    description: 'Epoch gate uses on-chain nonces as baseline (restart-proof)',
  },
  {
    id: 'W9',
    name: 'Heartbeat targets 60 requests/epoch',
    tier: 'tenderly',
    phase: 3,
    retryable: true,
    failureHints: ['jinn-node/src/worker/staking/heartbeat.ts'],
    description: 'Heartbeat submits 1 request/call, target 60/epoch, multisig from on-chain',
  },
  {
    id: 'W13',
    name: 'Dispatch routes through proxy',
    tier: 'tenderly',
    phase: 3,
    retryable: true,
    failureHints: [
      'jinn-node/src/worker/dispatch/dispatch-core.ts',
      'gemini-agent/mcp/tools/dispatch_new_job.ts',
    ],
    description: 'dispatch_new_job routes through proxy-only dispatch-core',
  },
];

// ---------------------------------------------------------------------------
// Credential gates (tenderly tier)
// ---------------------------------------------------------------------------

const credentialTenderlyGates: Gate[] = [
  {
    id: 'CR1',
    name: 'Credential bridge probe',
    tier: 'tenderly',
    phase: 4,
    retryable: true,
    failureHints: ['jinn-node/src/worker/credentialFilter.ts'],
    description: 'Credential filter probes bridge with ERC-8128 signed request, caches result',
  },
  {
    id: 'CR2',
    name: 'Worker skips credential-required jobs',
    tier: 'tenderly',
    phase: 4,
    depends: ['CR1'],
    retryable: true,
    failureHints: ['jinn-node/src/worker/credentialFilter.ts', 'jinn-node/src/worker/tool-credential-requirements.ts'],
    description: 'Worker skips jobs requiring credentials it doesn\'t have',
  },
  {
    id: 'CR3',
    name: 'Signing proxy is proxy-only',
    tier: 'tenderly',
    phase: 4,
    retryable: true,
    failureHints: ['jinn-node/src/worker/dispatch/dispatch-core.ts'],
    description: 'dispatch-core throws if AGENT_SIGNING_PROXY_URL unset',
  },
  {
    id: 'CR4',
    name: 'Signer cache flush on rotation',
    tier: 'tenderly',
    phase: 4,
    retryable: true,
    failureHints: ['jinn-node/src/worker/mech_worker.ts', 'jinn-node/src/worker/control_api_client.ts'],
    description: 'Service rotation flushes signer caches (resetControlApiSigner + resetCachedAddress)',
  },
  {
    id: 'CR5',
    name: 'Post-rotation credential bridge validation',
    tier: 'tenderly',
    phase: 4,
    depends: ['CR4'],
    retryable: true,
    failureHints: ['jinn-node/src/worker/credentialFilter.ts'],
    description: 'Service B identity accepted by bridge and Control API post-rotation',
  },
];

// ---------------------------------------------------------------------------
// Credential code inspection gates (inspect tier)
// ---------------------------------------------------------------------------

const credentialInspectGates: Gate[] = [
  {
    id: 'CR9',
    name: 'tool-credential-requirements maps 8 providers',
    tier: 'inspect',
    retryable: true,
    failureHints: ['jinn-node/src/worker/tool-credential-requirements.ts'],
    description: 'Maps tools to credential providers: telegram, twitter, umami, openai, civitai, supabase, fireflies, railway',
  },
  {
    id: 'CR10',
    name: 'credentialFilter reprobes with requestId',
    tier: 'inspect',
    retryable: true,
    failureHints: ['jinn-node/src/worker/credentialFilter.ts'],
    description: 'credentialFilter.ts reprobeWithRequestId() for venture-scoped credentials',
  },
  {
    id: 'CR11',
    name: 'GitHub operator capability via API',
    tier: 'inspect',
    retryable: true,
    failureHints: ['jinn-node/src/worker/credentialFilter.ts'],
    description: 'GitHub operator capability validated via /user endpoint',
  },
  {
    id: 'CR12',
    name: 'ERC-8128 nonce store prevents replay',
    tier: 'inspect',
    retryable: true,
    failureHints: ['control-api/server.ts', 'jinn-node/src/http/erc8128.ts'],
    description: 'InMemoryNonceStore with TTL-based GC in control-api',
  },
];

// ---------------------------------------------------------------------------
// Feature spot-check gates (inspect tier)
// ---------------------------------------------------------------------------

const featureInspectGates: Gate[] = [
  {
    id: 'W10',
    name: 'ENABLE_VENTURE_WATCHER triggers schedule checks',
    tier: 'inspect',
    retryable: true,
    failureHints: ['jinn-node/src/worker/mech_worker.ts', 'jinn-node/src/worker/ventures/ventureWatcher.ts'],
    description: 'ENABLE_VENTURE_WATCHER=1 triggers schedule checks in worker loop',
  },
  {
    id: 'W11',
    name: 'Venture watcher respects VENTURE_FILTER',
    tier: 'inspect',
    retryable: true,
    failureHints: ['jinn-node/src/worker/ventures/ventureWatcher.ts', 'jinn-node/src/worker/ventures/ventureDispatch.ts'],
    description: 'Venture watcher respects VENTURE_FILTER, uses claimVentureDispatch',
  },
  {
    id: 'W12',
    name: 'MAX_PARENT_DISPATCHES prevents cascade',
    tier: 'inspect',
    retryable: true,
    failureHints: ['jinn-node/src/worker/status/autoDispatch.ts'],
    description: 'MAX_PARENT_DISPATCHES=5 prevents cascade storms',
  },
  {
    id: 'C1',
    name: 'claimVentureDispatch deduplicates',
    tier: 'inspect',
    retryable: true,
    failureHints: ['control-api/server.ts'],
    description: 'claimVentureDispatch mutation with 10-min TTL, unique constraint',
  },
  {
    id: 'E1',
    name: 'All new MCP tools registered',
    tier: 'inspect',
    retryable: true,
    failureHints: ['gemini-agent/mcp/server.ts', 'gemini-agent/mcp/tools/'],
    description: 'moltbook(10), telegram_get_updates, read/update_dispatch_schedule, twitter tools',
  },
  {
    id: 'N1',
    name: 'Blueprint files exist',
    tier: 'inspect',
    retryable: true,
    failureHints: ['blueprints/'],
    description: '41+ blueprint files in blueprints/ directory',
  },
  {
    id: 'N2',
    name: 'VentureContextProvider compiles',
    tier: 'inspect',
    retryable: true,
    failureHints: [
      'jinn-node/src/worker/prompt/providers/context/VentureContextProvider.ts',
      'jinn-node/src/worker/prompt/BlueprintBuilder.ts',
    ],
    description: 'VentureContextProvider exports provider; BlueprintBuilder registers it',
  },
  {
    id: 'N3',
    name: 'serviceResolver exports + called at startup',
    tier: 'inspect',
    retryable: true,
    failureHints: ['jinn-node/src/worker/onchain/serviceResolver.ts', 'jinn-node/src/worker/mech_worker.ts'],
    description: 'serviceResolver.ts exports resolveServiceConfig; mech_worker.ts calls at startup',
  },
  {
    id: 'N4',
    name: 'Random staked mech selection',
    tier: 'inspect',
    retryable: true,
    failureHints: ['jinn-node/src/worker/filters/stakingFilter.ts', 'jinn-node/src/worker/ventures/ventureDispatch.ts'],
    description: 'stakingFilter.ts has Math.random(); ventureDispatch.ts calls getRandomStakedMech',
  },
  {
    id: 'F1',
    name: 'Venture page route exists',
    tier: 'inspect',
    retryable: true,
    failureHints: ['frontend/explorer/src/app/ventures/[id]/page.tsx'],
    description: 'Venture page renders for UUIDs and workstream IDs',
  },
  {
    id: 'F2',
    name: 'Schedule timeline component exists',
    tier: 'inspect',
    retryable: true,
    failureHints: ['frontend/explorer/src/components/ventures/schedule-timeline.tsx', 'frontend/explorer/src/lib/ventures/'],
    description: 'schedule-timeline.tsx with day grouping + Now marker',
  },
  {
    id: 'F3',
    name: 'venture-queries filters by ventureId',
    tier: 'inspect',
    retryable: true,
    failureHints: ['frontend/explorer/src/lib/ventures/venture-queries.ts'],
    description: 'venture-queries.ts where: { ventureId }',
  },
  {
    id: 'F4',
    name: 'subgraph.ts handles schema mismatches',
    tier: 'inspect',
    retryable: true,
    failureHints: ['frontend/explorer/src/lib/subgraph.ts'],
    description: 'try/catch for GRAPHQL_VALIDATION_FAILED',
  },
  {
    id: 'F5',
    name: 'staking/rpc.ts throws on missing RPC_URL',
    tier: 'inspect',
    retryable: true,
    failureHints: ['frontend/explorer/src/lib/staking/rpc.ts'],
    description: 'Throws on missing RPC_URL, no silent fallback to public RPC',
  },
];

// ---------------------------------------------------------------------------
// Canary gates (canary + smoke tiers)
// ---------------------------------------------------------------------------

const canaryGates: Gate[] = [
  {
    id: 'CANARY_DEPLOY',
    name: 'Canary services deployed on correct branch',
    tier: 'canary',
    phase: 0,
    estimatedSeconds: 300,
    retryable: true,
    failureHints: ['scripts/test/railway/canary-deploy-assert.ts'],
    description: 'Worker + gateway healthy on correct repo/branch with required env vars',
  },
  {
    id: 'CANARY_BASELINE',
    name: 'Baseline dispatch delivered',
    tier: 'canary',
    phase: 1,
    depends: ['CANARY_DEPLOY'],
    estimatedSeconds: 600,
    retryable: true,
    failureHints: ['scripts/test/railway/canary-dispatch.ts', 'jinn-node/src/worker/mech_worker.ts'],
    description: 'Claim/execute/deliver loop with successful delivery txs on mainnet',
  },
  {
    id: 'CANARY_CRED_TRUSTED',
    name: 'Trusted operator credential job delivered',
    tier: 'canary',
    phase: 2,
    depends: ['CANARY_BASELINE'],
    estimatedSeconds: 600,
    retryable: true,
    failureHints: ['scripts/test/railway/canary-credential-matrix.ts', 'services/x402-gateway/credentials/'],
    description: 'Trusted operator processes and delivers credential-required jobs',
  },
  {
    id: 'CANARY_CRED_UNTRUSTED',
    name: 'Untrusted operator credential job denied',
    tier: 'canary',
    phase: 2,
    depends: ['CANARY_BASELINE'],
    estimatedSeconds: 600,
    retryable: true,
    failureHints: ['scripts/test/railway/canary-credential-matrix.ts', 'jinn-node/src/worker/credentialFilter.ts'],
    description: 'Untrusted operator skips credential-required jobs',
  },
  {
    id: 'CANARY_FILTERING',
    name: 'Credential filtering matrix passes',
    tier: 'canary',
    phase: 3,
    depends: ['CANARY_BASELINE'],
    estimatedSeconds: 900,
    retryable: true,
    failureHints: ['scripts/test/railway/canary-credential-matrix.ts'],
    description: 'Credential jobs skipped when unavailable; non-credential jobs still processed',
  },
  {
    id: 'CANARY_FAILCLOSED',
    name: 'Blocked operator denied from capabilities',
    tier: 'canary',
    phase: 3,
    depends: ['CANARY_BASELINE'],
    estimatedSeconds: 30,
    retryable: true,
    failureHints: [
      'scripts/test/railway/canary-credential-matrix.ts',
      'services/x402-gateway/index.ts',
      'services/x402-gateway/credentials/venture-resolver.ts',
    ],
    description: 'venture_only blocked operator correctly absent from capabilities response',
  },
  {
    id: 'CANARY_SECURITY',
    name: 'No secret leaks in logs',
    tier: 'canary',
    phase: 4,
    depends: ['CANARY_BASELINE'],
    estimatedSeconds: 30,
    retryable: false,
    failureHints: ['scripts/test/railway/canary-log-gates.ts'],
    description: 'No secret leakage, auth decision logs present, request IDs traced',
  },
  {
    id: 'CANARY_DELIVERY_RATE',
    name: 'Delivery rate meets threshold',
    tier: 'canary',
    phase: 4,
    depends: ['CANARY_BASELINE'],
    estimatedSeconds: 30,
    retryable: false,
    failureHints: ['jinn-node/scripts/mech/assert-delivery-rates.ts'],
    description: 'assert-delivery-rates --expected 99 passes for deployed mechs',
  },
];

const smokeGates: Gate[] = [
  {
    id: 'CANARY_SMOKE',
    name: '30-minute stability window',
    tier: 'smoke',
    depends: ['CANARY_BASELINE'],
    estimatedSeconds: 1800,
    retryable: false,
    failureHints: ['scripts/test/railway/canary-log-gates.ts'],
    description: 'No mech-resolution regressions, no repeated credential errors, healthy loop for 30 min',
  },
];

// ---------------------------------------------------------------------------
// Full registry
// ---------------------------------------------------------------------------

export const gates: Gate[] = [
  ...ponderGates,
  ...workerTenderlyGates,
  ...credentialTenderlyGates,
  ...credentialInspectGates,
  ...featureInspectGates,
  ...canaryGates,
  ...smokeGates,
];

/** Map from gate ID to its tier */
export const gateTiers: Record<string, Tier> = Object.fromEntries(
  gates.map((g) => [g.id, g.tier]),
);

/** Get all active (non-retired) gates for a given tier */
export function gatesForTier(tier: Tier): Gate[] {
  return gates.filter((g) => g.tier === tier && !g.retired);
}

/** Get a gate by ID */
export function getGate(id: string): Gate | undefined {
  return gates.find((g) => g.id === id);
}

/** Get all active gate IDs (excludes retired) */
export function allGateIds(): string[] {
  return gates.filter((g) => !g.retired).map((g) => g.id);
}

/** Get active gate IDs for tiers included in a profile (excludes retired) */
export function gateIdsForProfile(profile: 'quick' | 'standard' | 'full'): string[] {
  const tiers: Record<string, Tier[]> = {
    quick: ['unit', 'inspect'],
    standard: ['unit', 'inspect', 'tenderly'],
    full: ['unit', 'inspect', 'tenderly', 'canary', 'smoke'],
  };
  const activeTiers = new Set(tiers[profile]);
  return gates.filter((g) => activeTiers.has(g.tier) && !g.retired).map((g) => g.id);
}
