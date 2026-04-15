import { ponder } from "ponder:registry";
import fetch from "cross-fetch";
import axios from "axios";
import { Pool } from "pg";
import { jobDefinition, request, delivery, artifact, message, workstream, jobTemplate, mechServiceMapping, stakedService } from "ponder:schema";

// Local utilities to avoid jinn-node imports in Ponder build
const logger = {
  error: (...args: any[]) => console.error(...args),
  warn: (...args: any[]) => console.warn(...args),
  info: (...args: any[]) => console.log(...args),
  debug: (...args: any[]) => console.log(...args),
};

function serializeError(error: any) {
  return error instanceof Error ? { message: error.message, stack: error.stack } : error;
}

function extractToolName(tool: string | { name: string; required?: boolean }): string | null {
  if (typeof tool === 'string') return tool;
  return tool && typeof tool === 'object' && 'name' in tool ? tool.name : null;
}

// Helpers for safe coercion from unknown shapes
const toStringArray = (value: unknown): string[] => {
  return Array.isArray(value) ? value.map((x) => String(x)) : [];
};

const toBigIntCoercible = (value: unknown): string | number | bigint => {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  return 0;
};

function safeJsonClone<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val)),
  );
}

const NODE_EMBEDDINGS_DB_URL =
  process.env.NODE_EMBEDDINGS_DB_URL ||
  process.env.SITUATION_DB_URL ||
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.SUPABASE_POSTGRES_URL ||
  null;

let vectorDbPool: Pool | null = null;

// ============================================================================
// IPFS metadata cache — Postgres-backed cache to avoid refetching on re-index
// ============================================================================
const IPFS_CACHE_DB_URL = process.env.IPFS_CACHE_DB_URL || process.env.PONDER_DATABASE_URL || null;
let ipfsCachePool: Pool | null = null;
let ipfsCacheReady = false;

function getIpfsCachePool(): Pool | null {
  if (!IPFS_CACHE_DB_URL) return null;
  if (!ipfsCachePool) {
    ipfsCachePool = new Pool({ connectionString: IPFS_CACHE_DB_URL });
  }
  return ipfsCachePool;
}

// ============================================================================
// Jinn mech allowlist — resolved at startup from staking contract events
// Includes all mechs that were EVER staked in Jinn (not just currently active).
// Non-Jinn mechs are skipped entirely (0ms instead of 6s+ IPFS timeout).
// ============================================================================
const JINN_STAKING_CONTRACTS = [
  '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139', // Jinn Staking v1
  '0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488', // Jinn Staking v2
];
const MARKETPLACE_ADDRESS = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const BASE_RPC_URL = process.env.PONDER_RPC_URL || process.env.BASE_RPC_URL || process.env.RPC_URL || 'https://mainnet.base.org';

// Hardcoded Jinn mechs that may not be currently staked but are still ours.
// These are always included in the allowlist regardless of staking state.
const HARDCODED_JINN_MECHS = [
  '0x8c083dfe9bee719a05ba3c75a9b16be4ba52c299', // Service 165 — main Jinn mech
];

// Set of known Jinn mech addresses (lowercase). Populated at startup, then kept
// current by the CreateMech and ServiceStaked handlers as new events arrive.
let jinnMechAddresses: Set<string> | null = null;

// Auxiliary indexes so handlers can cross-reference and update the allowlist.
// jinnStakedServiceIds: service IDs staked in any Jinn staking contract (from ServiceStaked events)
// serviceIdToMech: serviceId → mech address (from CreateMech events)
const jinnStakedServiceIds = new Set<string>();
const serviceIdToMech = new Map<string, string>();

async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetch(BASE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

async function ethGetLogs(address: string, topics: string[], fromBlock: string, toBlock: string): Promise<any[]> {
  const res = await fetch(BASE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address, topics, fromBlock, toBlock }] }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result || [];
}

async function lookupMechForService(serviceId: bigint): Promise<{ mech: string; mechFactory: string } | null> {
  const CREATE_MECH_TOPIC = '0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6';
  const serviceIdTopic = '0x' + serviceId.toString(16).padStart(64, '0');
  const logs = await ethGetLogs(
    MARKETPLACE_ADDRESS,
    [CREATE_MECH_TOPIC, null, serviceIdTopic],
    '0x' + (25_000_000).toString(16),
    'latest'
  );
  if (logs.length === 0) return null;
  // Use the last CreateMech event (most recent mech for this service)
  const last = logs[logs.length - 1];
  return {
    mech: '0x' + (last.topics[1] as string).slice(26).toLowerCase(),
    mechFactory: '0x' + (last.topics[3] as string).slice(26).toLowerCase(),
  };
}

async function buildJinnMechAllowlist(): Promise<Set<string>> {
  const mechs = new Set<string>();
  try {
    // Step 1: Get ALL service IDs that were EVER staked via ServiceStaked events.
    // Using getServiceIds() only returns currently active services — evicted services
    // are excluded, causing their mechs (and all historical data) to be missed.
    // ServiceStaked(uint256 epoch, uint256 indexed serviceId, address indexed owner, address indexed multisig, uint256[] nonces)
    // keccak256("ServiceStaked(uint256,uint256,address,address,uint256[])")
    const SERVICE_STAKED_TOPIC = '0xaa6b005b4958114a0c90492461c24af6525ae0178db7fbf44125ae9217c69ccb';
    const serviceIds = new Set<string>();
    for (const stakingAddr of JINN_STAKING_CONTRACTS) {
      try {
        const logs = await ethGetLogs(
          stakingAddr,
          [SERVICE_STAKED_TOPIC],
          '0x' + (25_000_000).toString(16),
          'latest'
        );
        for (const log of logs) {
          // topics[1] = serviceId (indexed)
          const serviceId = BigInt(log.topics[1] as string).toString();
          serviceIds.add(serviceId);
          // Seed the module-level index so event handlers can cross-reference
          jinnStakedServiceIds.add(serviceId);
        }
        logger.info({ stakingAddr: stakingAddr.slice(0, 10), eventCount: logs.length, ids: [...serviceIds] }, 'ServiceStaked events result');
      } catch (e: any) {
        logger.warn({ stakingAddr, error: e?.message }, 'Failed to query ServiceStaked events');
      }
    }
    logger.info({ serviceIdCount: serviceIds.size, serviceIds: [...serviceIds] }, 'Fetched historically staked service IDs');

    // Step 2: Get all CreateMech events from marketplace to map serviceId → mech
    // keccak256("CreateMech(address,uint256,address)") — all 3 params are indexed (in topics)
    const CREATE_MECH_TOPIC = '0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6';
    const logs = await ethGetLogs(
      MARKETPLACE_ADDRESS,
      [CREATE_MECH_TOPIC],
      '0x' + (25_000_000).toString(16),
      'latest'
    );
    logger.info({ createMechCount: logs.length }, 'Fetched CreateMech events');

    for (const log of logs) {
      // topics[1] = mech (indexed), topics[2] = serviceId (indexed), topics[3] = mechFactory (indexed)
      const mechAddr = '0x' + (log.topics[1] as string).slice(26).toLowerCase();
      const serviceId = BigInt(log.topics[2] as string).toString();
      // Seed the module-level index so event handlers can cross-reference
      serviceIdToMech.set(serviceId, mechAddr);
      if (serviceIds.has(serviceId)) {
        mechs.add(mechAddr);
      }
    }

    // Always include hardcoded mechs (may be unstaked but still ours)
    for (const addr of HARDCODED_JINN_MECHS) {
      mechs.add(addr.toLowerCase());
    }

    logger.info({ mechCount: mechs.size, mechs: [...mechs] }, 'Built Jinn mech allowlist from staking contracts');
  } catch (e: any) {
    logger.error({ error: e?.message, stack: e?.stack }, 'Failed to build Jinn mech allowlist — will allow all mechs');
    return null as any; // Return null to disable filtering (fail open)
  }
  return mechs;
}

// Initialize at module load time (top-level await is supported in Ponder's ESM context)
// The allowlist is kept current by CreateMech and ServiceStaked handlers below.
buildJinnMechAllowlist().then(set => {
  jinnMechAddresses = set;
}).catch(e => {
  logger.error({ error: e?.message }, 'Mech allowlist initialization failed — filtering disabled');
  jinnMechAddresses = null;
});

const IPFS_GATEWAY_BASE = (process.env.IPFS_GATEWAY_URL || "https://gateway.autonolas.tech/ipfs/").replace(/\/+$/, "/");
const IPFS_GATEWAY_FALLBACKS = [
  "https://ipfs.io/ipfs/"
  // cloudflare-ipfs.com is dead (ENOTFOUND as of Feb 2026)
  // dweb.link also unreliable — keep fallbacks minimal to fail fast on unpinned content
];

function getVectorDbPool(): Pool | null {
  if (!NODE_EMBEDDINGS_DB_URL) return null;
  if (!vectorDbPool) {
    vectorDbPool = new Pool({ connectionString: NODE_EMBEDDINGS_DB_URL });
  }
  return vectorDbPool;
}

// ============================================================================
// IPFS cache helpers
// ============================================================================
async function ensureIpfsCacheSchema(): Promise<void> {
  const pool = getIpfsCachePool();
  if (!pool) return;
  try {
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS ipfs_cache;
      CREATE TABLE IF NOT EXISTS ipfs_cache.metadata (
        cache_key TEXT PRIMARY KEY,
        content JSONB NOT NULL,
        fetched_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    ipfsCacheReady = true;
    logger.info('IPFS cache schema ready');
  } catch (e: any) {
    logger.debug({ error: e?.message }, 'Failed to initialize IPFS cache schema — caching disabled');
  }
}

async function ipfsCacheGet(cacheKey: string): Promise<any | null> {
  if (!ipfsCacheReady) return null;
  const pool = getIpfsCachePool();
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT content FROM ipfs_cache.metadata WHERE cache_key = $1', [cacheKey]);
    if (result.rows.length > 0) {
      logger.debug({ cacheKey }, 'IPFS cache hit');
      return result.rows[0].content;
    }
    return null;
  } catch (e: any) {
    logger.debug({ cacheKey, error: e?.message }, 'IPFS cache read error');
    return null;
  }
}

async function ipfsCacheSet(cacheKey: string, content: any): Promise<void> {
  if (!ipfsCacheReady) return;
  const pool = getIpfsCachePool();
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO ipfs_cache.metadata (cache_key, content) VALUES ($1, $2) ON CONFLICT (cache_key) DO NOTHING',
      [cacheKey, JSON.stringify(content)]
    );
    logger.debug({ cacheKey }, 'IPFS cache write');
  } catch (e: any) {
    logger.debug({ cacheKey, error: e?.message }, 'IPFS cache write error');
  }
}

// Initialize IPFS cache schema eagerly (non-blocking)
ensureIpfsCacheSchema().catch(e => {
  logger.debug({ error: e?.message }, 'IPFS cache schema init failed');
});

function truncate(text: unknown, max = 800): string | null {
  if (text === undefined || text === null) return null;
  const str = String(text).trim();
  if (!str) return null;
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function formatVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function hexToBytes(hex: string): number[] {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${hex}`);
  }
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    const byte = parseInt(cleaned.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex byte "${cleaned.slice(i, i + 2)}" in ${hex}`);
    }
    bytes.push(byte);
  }
  return bytes;
}

function encodeBase32LowerNoPadding(bytes: number[]): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | (byte & 0xff);
    bits += 8;
    while (bits >= 5) {
      const index = (buffer >> (bits - 5)) & 0x1f;
      bits -= 5;
      output += alphabet[index];
    }
  }
  if (bits > 0) {
    const index = (buffer << (5 - bits)) & 0x1f;
    output += alphabet[index];
  }
  return output;
}

type CidCandidate = { codec: 'dag-pb' | 'raw'; cidHex: string; cidBase32: string };

function buildCidFromDigest(digestHex: string, codec: CidCandidate['codec']): CidCandidate {
  const normalized = digestHex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Digest must be 32 bytes (64 hex chars). Received "${digestHex}"`);
  }
  const digestBytes = hexToBytes(normalized);
  const codecByte = codec === 'dag-pb' ? 0x70 : 0x55;
  const cidBytes = [0x01, codecByte, 0x12, 0x20, ...digestBytes];
  const codecHex = codecByte.toString(16).padStart(2, '0');
  const cidHex = `f01${codecHex}1220${normalized}`;
  const cidBase32 = `b${encodeBase32LowerNoPadding(cidBytes)}`;
  return { codec, cidHex, cidBase32 };
}

function buildCidCandidatesFromDigest(digestHex: string): CidCandidate[] {
  return [
    buildCidFromDigest(digestHex, 'dag-pb'),
    buildCidFromDigest(digestHex, 'raw'),
  ];
}

async function fetchRequestMetadata(cidBase32: string, timeoutMs = 1_500): Promise<any> {
  const gateways = [IPFS_GATEWAY_BASE, ...IPFS_GATEWAY_FALLBACKS];
  let lastError: Error | null = null;

  for (const gateway of gateways) {
    const url = `${gateway}${cidBase32}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        const msg = `HTTP ${response.status} from ${gateway}`;
        logger.debug({ cidBase32, gateway, status: response.status }, "IPFS gateway failed, trying next");
        lastError = new Error(msg);
        continue;
      }

      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (parseError: any) {
        const contentType = response.headers.get("content-type") || "";
        const bodyPreview = text.replace(/\s+/g, " ").slice(0, 200);
        const msg = `JSON parse error from ${gateway}: ${parseError.message}`;
        logger.warn(
          {
            cidBase32,
            gateway,
            contentType,
            bodyLength: text.length,
            bodyPreview,
            error: parseError.message,
          },
          "IPFS JSON parse failed, trying next"
        );
        lastError = new Error(msg);
        continue;
      }
    } catch (error: any) {
      lastError = error;
      logger.debug({ cidBase32, gateway, error: error.message }, "IPFS fetch network error, trying next");
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Failed to fetch request metadata from any gateway. Last error: ${lastError?.message}`);
}

/**
 * Compute a hash of the blueprint for template deduplication.
 * Normalizes the blueprint by removing variable parts (timestamps, UUIDs, etc.)
 * and hashing the structural content.
 */
function computeBlueprintHash(blueprint: string | undefined): string | null {
  if (!blueprint) return null;

  try {
    // Parse blueprint if it's JSON
    let parsed: any;
    try {
      parsed = JSON.parse(blueprint);
    } catch {
      // If not valid JSON, hash the raw string
      return simpleHash(blueprint);
    }

    // Extract structural elements for hashing:
    // - assertion IDs and text (not examples which may vary)
    // - tool names
    // Ignore: timestamps, UUIDs, context strings, specific values
    const structural: any = {
      assertions: [],
      tools: [],
    };

    if (parsed.assertions && Array.isArray(parsed.assertions)) {
      structural.assertions = parsed.assertions.map((a: any) => ({
        id: a.id,
        assertion: typeof a.assertion === 'string' ? a.assertion.substring(0, 200) : '',
      }));
    }

    // Also consider enabled tools as part of template identity
    if (parsed.enabledTools && Array.isArray(parsed.enabledTools)) {
      structural.tools = parsed.enabledTools.sort();
    }

    return simpleHash(JSON.stringify(structural));
  } catch {
    return simpleHash(blueprint);
  }
}

/**
 * Simple hash function for strings (non-cryptographic, for deduplication only)
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Convert to hex string with prefix
  return 'bph_' + Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Extract a template name from a job name by removing variable suffixes.
 * E.g., "Ethereum Daily Research - 2025-12-15 - abc" -> "Ethereum Daily Research"
 */
function extractTemplateName(jobName: string | undefined): string {
  if (!jobName) return 'Unnamed Template';

  // Remove common variable suffixes:
  // - Dates: "- 2025-12-15", "– Dec 15", etc.
  // - Random suffixes: "- abc", "- xyz123"
  // - UUIDs: "- 550e8400-e29b-..."
  let name = jobName
    .replace(/\s*[-–]\s*\d{4}-\d{2}-\d{2}.*$/i, '') // ISO dates
    .replace(/\s*[-–]\s*[A-Z][a-z]{2}\s+\d{1,2}.*$/i, '') // "Dec 15" style
    .replace(/\s*[-–]\s*[a-z]{3,8}$/i, '') // Short random suffixes
    .replace(/\s*[-–]\s*[0-9a-f]{8}-[0-9a-f]{4}-.*$/i, '') // UUIDs
    .replace(/\s*\(via x402\)$/i, '') // x402 suffix
    .trim();

  return name || 'Unnamed Template';
}

/**
 * Extract tags from job name and blueprint content.
 */
function extractTags(jobName: string | undefined, blueprint: string | undefined): string[] {
  const tags = new Set<string>();

  // Common keywords to extract as tags
  const keywords = [
    'ethereum', 'research', 'analysis', 'trading', 'defi', 'daily',
    'prediction', 'market', 'x402', 'ecosystem', 'agents', 'protocol',
    'audit', 'security', 'optimization', 'scaffold', 'documentation'
  ];

  const searchText = `${jobName || ''} ${blueprint || ''}`.toLowerCase();

  for (const keyword of keywords) {
    if (searchText.includes(keyword)) {
      tags.add(keyword);
    }
  }

  return Array.from(tags).slice(0, 10); // Limit to 10 tags
}

/**
 * Generate a template ID from the name (slug format).
 */
function generateTemplateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50) || 'unnamed-template';
}

/**
 * Derive or update a job template from a job definition.
 * Called when a new job definition is indexed.
 */
async function deriveJobTemplate(
  db: any,
  jobDef: {
    id: string;
    name?: string;
    blueprint?: string;
    enabledTools?: string[];
    blockTimestamp: bigint;
    outputSpec?: Record<string, any>;
    priceWei?: bigint;
    priceUsd?: string;
    inputSchema?: Record<string, any>;
  }
): Promise<void> {
  // Compute blueprint hash for deduplication
  const blueprintHash = computeBlueprintHash(jobDef.blueprint);
  if (!blueprintHash) {
    logger.debug({ jobDefinitionId: jobDef.id }, "Skipping template derivation - no blueprint");
    return;
  }

  // Check if a template with this blueprint hash already exists
  // We use the hash as part of the ID for direct lookup
  const templateName = extractTemplateName(jobDef.name);
  const baseTemplateId = generateTemplateId(templateName);

  // Try to find existing template by blueprint hash
  // Since we can't query by non-PK fields easily, we'll use a hash-based ID
  const templateId = `${baseTemplateId}-${blueprintHash.substring(4, 12)}`;

  const existing = await db.find(jobTemplate, { id: templateId });

  if (existing) {
    // Update existing template metrics — use functional update for atomic increment
    const shouldUpdateInputSchema = !existing.inputSchema && jobDef.inputSchema;
    await db.update(jobTemplate, { id: templateId }).set((row: any) => ({
      runCount: row.runCount + 1,
      lastUsedAt: jobDef.blockTimestamp,
      ...(shouldUpdateInputSchema ? { inputSchema: jobDef.inputSchema } : {}),
    }));
    logger.debug({ templateId, inputSchemaUpdated: !!shouldUpdateInputSchema }, "Updated existing job template metrics");
  } else {
    // Create new template
    const tags = extractTags(jobDef.name, jobDef.blueprint);

    await db.insert(jobTemplate).values({
      id: templateId,
      name: templateName,
      description: `Auto-derived from job: ${jobDef.name || 'Unnamed'}`,
      tags,
      enabledTools: jobDef.enabledTools || [],
      blueprintHash,
      blueprint: jobDef.blueprint,
      inputSchema: jobDef.inputSchema || null,
      outputSpec: jobDef.outputSpec || null,
      priceWei: jobDef.priceWei ?? 0n,
      priceUsd: jobDef.priceUsd || null,
      canonicalJobDefinitionId: jobDef.id,
      runCount: 1,
      successCount: 0,
      createdAt: jobDef.blockTimestamp,
      lastUsedAt: jobDef.blockTimestamp,
      status: 'visible',
    }).onConflictDoNothing();
    logger.info({ templateId, templateName, blueprintHash }, "Created new job template from job definition");
  }
}

/**
 * Traverses up the request chain to find the ultimate root request ID (workstream root).
 * @param startRequestId The ID of the request to start traversal from (the immediate parent).
 * @param requestRepo The Ponder repository for requests.
 * @returns The ID of the root request (workstream ID).
 */
async function findWorkstreamRoot(
  startRequestId: string,
  db: any,
): Promise<string> {
  let currentId = startRequestId;
  const visited = new Set<string>();

  // Limit traversal to prevent infinite loops in case of data cycles
  for (let i = 0; i < 100; i++) {
    // Prevent cycles
    if (visited.has(currentId)) {
      logger.warn({ requestId: currentId }, 'Detected cycle in request chain during workstream root search');
      return currentId;
    }
    visited.add(currentId);

    try {
      const req = await db.find(request, { id: currentId });
      if (!req || !req.sourceRequestId) {
        // We've found the root (no parent) or the trail goes cold.
        return currentId;
      }
      // Move up the chain
      currentId = req.sourceRequestId;
    } catch (e) {
      // If we can't find the parent, treat current as root
      logger.warn({ requestId: currentId, error: serializeError(e) }, 'Failed to fetch parent request during workstream root search');
      return currentId;
    }
  }

  logger.warn({ startRequestId, currentId }, 'Workstream root search exceeded 100 iterations');
  return currentId; // Fallback to last known ID
}

ponder.on(
  "MechMarketplace:MarketplaceRequest",
  async ({ event, context }: { event: any; context: any }) => {
    try {
      const db = context.db;
      if (!db) {
        logger.error("Ponder context.db is not available; cannot index MarketplaceRequest");
        return;
      }

      const mech: string = String(event.args.priorityMech).toLowerCase();
      const sender: string = String(event.args.requester).toLowerCase();
      const requestIds: string[] = toStringArray(event.args.requestIds);
      const requestDatas: string[] = toStringArray(event.args.requestDatas);
      const txHash: string = String(event.transaction.hash);
      const blockNumber: bigint = BigInt(toBigIntCoercible(event.block.number));
      const blockTimestamp: bigint = BigInt(toBigIntCoercible(event.block.timestamp));

      // Fast-path: skip non-Jinn mechs entirely (avoids 6s+ IPFS timeout per request)
      const isKnownJinnMech = jinnMechAddresses?.has(mech) ?? false;
      if (jinnMechAddresses && !isKnownJinnMech) {
        logger.debug({ mech, requestIds }, 'Skipping non-Jinn mech (not in staking allowlist)');
        return;
      }

      // Using native Ponder Store API — no Repository wrapper needed

      for (let i = 0; i < requestIds.length; i++) {
        const id = requestIds[i];
        const dataHex = requestDatas?.[i];
        if (!dataHex) {
          throw new Error(`MarketplaceRequest missing requestDatas entry for request ${id}`);
        }
        const digestHex = String(dataHex).replace(/^0x/, '').toLowerCase();
        // Some gateways only resolve the raw CID, so we try multiple codecs.
        const cidCandidates = buildCidCandidatesFromDigest(digestHex);

        logger.info(
          {
            requestId: id,
            txHash,
            cidCandidates: cidCandidates.map((candidate) => candidate.cidBase32),
          },
          "Processing MarketplaceRequest - fetching IPFS metadata"
        );

        // Fetch IPFS metadata to extract jobName, blueprint, etc.
        // Known Jinn mechs: proceed without metadata on failure (we know they're ours)
        // Unknown mechs: must succeed to verify networkId
        let content: any = null;
        let selectedCandidate: CidCandidate | null = null;
        let lastIpfsError: any = null;
        try {
          // Check IPFS cache first
          const cachedContent = await ipfsCacheGet(digestHex);
          if (cachedContent) {
            content = cachedContent;
            selectedCandidate = cidCandidates[0] || null;
          } else {
            for (const candidate of cidCandidates) {
              try {
                content = await fetchRequestMetadata(candidate.cidBase32);
                selectedCandidate = candidate;
                break;
              } catch (candidateError: any) {
                lastIpfsError = candidateError;
              }
            }
            if (content && selectedCandidate) {
              await ipfsCacheSet(digestHex, content);
            }
          }
          if (!content || !selectedCandidate) {
            throw lastIpfsError || new Error('Unable to resolve IPFS metadata from any CID candidate');
          }
          if (!content || typeof content !== "object") {
            throw new Error(`IPFS payload for request ${id} is empty or malformed`);
          }
          logger.info(
            {
              requestId: id,
              cidBase32: selectedCandidate.cidBase32,
              cidCodec: selectedCandidate.codec,
              hasJobName: !!content.jobName,
              hasJobDefinitionId: !!content.jobDefinitionId,
              networkId: content.networkId,
            },
            "IPFS metadata fetched successfully"
          );
        } catch (ipfsError: any) {
          if (isKnownJinnMech) {
            // Known Jinn mech — index even without metadata (it's definitely ours)
            logger.debug(
              { requestId: id },
              "IPFS fetch failed for known Jinn mech — indexing without metadata"
            );
            // Fall through with content=null, selectedCandidate=null
          } else {
            // Unknown mech — can't verify networkId, skip
            logger.error(
              {
                requestId: id,
                cidCandidates: cidCandidates.map((candidate) => candidate.cidBase32),
                error: serializeError(ipfsError || lastIpfsError),
              },
              "Failed to fetch IPFS metadata for request - skipping (cannot verify networkId)"
            );
            continue;
          }
        }

        // Use selected CID candidate, or fall back to first candidate for known Jinn mechs
        const resolvedCandidate = selectedCandidate || (isKnownJinnMech ? cidCandidates[0] : null);
        if (!resolvedCandidate) {
          logger.error(
            { requestId: id, cidCandidates: cidCandidates.map((candidate) => candidate.cidBase32) },
            "No CID candidate selected after IPFS metadata fetch; skipping"
          );
          continue;
        }

        const { cidHex: ipfsHash, cidBase32 } = resolvedCandidate;

        // GLOBAL JINN EXPLORER: Only index requests with networkId === "jinn" (or missing for legacy)
        // Known Jinn mechs bypass this check (they're definitely ours)
        if (!isKnownJinnMech) {
          const networkId: string | undefined = typeof content?.networkId === "string" ? content.networkId : undefined;
          if (networkId && networkId !== "jinn") {
            logger.debug({ requestId: id, networkId, txHash }, "Skipping non-Jinn request (networkId filtering)");
            continue;
          }
        }

        // Now that we've verified this is a Jinn request, insert into DB
        const networkId: string | undefined = typeof content?.networkId === "string" ? content.networkId : undefined;
        logger.info({ requestId: id, networkId: networkId || 'undefined (legacy)', isKnownJinnMech }, "Request passed filter - creating DB record");

        try {
          // Pre-seed request row — don't overwrite if it already exists
          await db.insert(request).values({
            id,
            mech: mech as `0x${string}`,
            sender: sender as `0x${string}`,
            workstreamId: id, // Temporary: will be recomputed after metadata extraction if sourceRequestId exists
            transactionHash: txHash,
            blockNumber,
            blockTimestamp,
            ipfsHash,
            delivered: false,
          }).onConflictDoNothing();
          logger.info({ requestId: id }, "Initial request insert completed successfully");
        } catch (upsertError: any) {
          logger.error({ requestId: id, error: serializeError(upsertError) }, "Initial request insert failed");
          throw upsertError;
        }

        let jobName: string | undefined;
        let enabledTools: string[] | undefined;
        let jobDefinitionId: string | undefined;
        let blueprint: string | undefined;
        let sourceRequestId: string | undefined;
        let sourceJobDefinitionIdFromContent: string | undefined;
        let additionalContext: any = undefined;
        let messageContent: any = undefined;
        let codeMetadata: any = undefined;
        let dependencies: string[] | undefined;
        jobName = typeof content?.jobName === "string" ? content.jobName : undefined;
        // Extract tool names using shared utility (handles both string and {name, required} formats)
        // Filter out nulls from invalid entries
        // IMPORTANT: Prefer enabledTools (actual runtime tools) over tools (template definition)
        // This matches worker behavior and ensures UI shows what job actually has access to
        enabledTools = Array.isArray(content?.enabledTools)
          ? content.enabledTools.map(extractToolName).filter((name: string | null): name is string => name !== null)
          : Array.isArray(content?.tools)
            ? content.tools.map(extractToolName).filter((name: string | null): name is string => name !== null)
            : undefined;
        jobDefinitionId = typeof content?.jobDefinitionId === "string" ? content.jobDefinitionId : undefined;
        // Support both blueprint (new) and prompt (legacy)
        blueprint = typeof content?.blueprint === "string"
          ? content.blueprint
          : (typeof content?.prompt === "string" ? content.prompt : undefined);
        sourceRequestId = typeof content?.sourceRequestId === "string" ? content.sourceRequestId : undefined;
        sourceJobDefinitionIdFromContent =
          typeof content?.sourceJobDefinitionId === "string"
            ? content.sourceJobDefinitionId
            : undefined;
        additionalContext = content?.additionalContext || undefined;
        if (additionalContext?.message) {
          messageContent = additionalContext.message;
        }
        if (content?.codeMetadata && typeof content.codeMetadata === "object") {
          try {
            codeMetadata = safeJsonClone(content.codeMetadata);
          } catch {
            codeMetadata = content.codeMetadata;
          }
        }
        // Extract template metadata for x402 templates
        const templateOutputSpec = content?.outputSpec && typeof content.outputSpec === 'object'
          ? content.outputSpec
          : undefined;
        const templatePriceWei = typeof content?.priceWei === 'string' || typeof content?.priceWei === 'number'
          ? BigInt(content.priceWei)
          : undefined;
        const templatePriceUsd = typeof content?.priceUsd === 'string'
          ? content.priceUsd
          : undefined;
        const templateInputSchema = content?.inputSchema && typeof content.inputSchema === 'object'
          ? content.inputSchema
          : undefined;

        // Extract venture and template IDs from content
        let ventureId: string | undefined = typeof content?.ventureId === 'string' ? content.ventureId : undefined;
        let templateId: string | undefined = typeof content?.templateId === 'string' ? content.templateId : undefined;

        // Extract dependencies array from content
        dependencies = Array.isArray(content?.dependencies)
          ? content.dependencies.map((dep: any) => String(dep))
          : undefined;

        // Upsert jobDefinition if present
        // NOTE: This happens BEFORE workstreamId is computed, so we can't include it here yet.
        // We'll need to update it after workstreamId is computed.
        if (jobDefinitionId) {
          // Prefer explicit lineage from payload if provided
          const parentJobDefinitionId: string | undefined = sourceJobDefinitionIdFromContent;

          await db.insert(jobDefinition).values({
            id: jobDefinitionId,
            name: jobName || 'Unnamed Job',
            enabledTools,
            blueprint,
            dependencies,
            ventureId,
            templateId,
            sourceJobDefinitionId: parentJobDefinitionId,
            sourceRequestId: sourceRequestId,
            codeMetadata,
            createdAt: blockTimestamp,
            lastInteraction: blockTimestamp,
            lastStatus: 'PENDING',
          }).onConflictDoUpdate({
            name: jobName || 'Unnamed Job',
            enabledTools,
            blueprint,
            codeMetadata: codeMetadata || undefined,
            lastInteraction: blockTimestamp,
            lastStatus: 'PENDING',
            // Do NOT re-attribute lineage on updates; preserve original creator
            // Do NOT update dependencies - immutable per job definition
            // Do NOT update ventureId/templateId - preserve original association
          });

          // Derive job template from this job definition
          // This creates or updates a template based on blueprint similarity
          try {
            await deriveJobTemplate(db, {
              id: jobDefinitionId,
              name: jobName,
              blueprint,
              enabledTools,
              blockTimestamp,
              outputSpec: templateOutputSpec,
              priceWei: templatePriceWei,
              priceUsd: templatePriceUsd,
              inputSchema: templateInputSchema,
            });
          } catch (templateError: any) {
            // Don't fail the main indexing if template derivation fails
            logger.warn({ jobDefinitionId, error: serializeError(templateError) }, "Template derivation failed (non-fatal)");
          }
        }

        // jobDefinitionId = target job being dispatched (what this request is FOR)
        // sourceJobDefinitionIdFromContent = parent job that created this request (lineage tracking)

        // Ensure additionalContext is properly structured with message preserved
        // The message should remain in additionalContext even after being extracted
        // for the messages table, so that request.additionalContext is complete
        //
        // IMPORTANT: Ponder's p.json() type expects serializable objects.
        // Deep clone through JSON to ensure no circular references.
        let contextToStore: any = undefined;
        if (additionalContext && typeof additionalContext === 'object') {
          try {
            // Deep clone to ensure serializability - this preserves ALL fields including
            // hierarchy, summary, and message
            contextToStore = safeJsonClone(additionalContext);
          } catch (e) {
            contextToStore = undefined;
          }
        }

        // --- COMPUTE WORKSTREAM ID ---
        // The workstream ID is the root request ID of the entire job chain.
        // Priority: 1) Explicit workstreamId in IPFS metadata (for parent re-dispatches)
        //           2) Traverse sourceRequestId chain to find root (for child jobs)
        //           3) Use own request ID (for root jobs)
        let workstreamId: string;
        const explicitWorkstreamId = typeof content?.workstreamId === 'string' ? content.workstreamId : undefined;
        if (explicitWorkstreamId) {
          // Parent re-dispatch preserving workstream
          workstreamId = explicitWorkstreamId;
          logger.debug({ requestId: id, workstreamId }, 'Using explicit workstream ID from metadata');
        } else if (sourceRequestId) {
          // This is a child job, find its ultimate root
          workstreamId = await findWorkstreamRoot(sourceRequestId, db);
        } else {
          // This is a root job, its workstream ID is its own ID
          workstreamId = id;
        }

        // --- INHERIT VENTURE/TEMPLATE ID FROM WORKSTREAM ROOT ---
        // If this is a child request without ventureId/templateId in its IPFS content,
        // inherit from the workstream root. Try two sources:
        // 1. Workstream record (created when root is indexed)
        // 2. Root request row directly (fallback for same-batch processing where workstream
        //    record may not be committed yet)
        if ((!ventureId || !templateId) && sourceRequestId) {
          try {
            // Try workstream record first
            const ws = await db.find(workstream, { id: workstreamId });
            if (ws) {
              if (!ventureId && ws.ventureId) {
                ventureId = ws.ventureId;
                logger.info({ requestId: id, workstreamId, ventureId }, 'Inherited ventureId from workstream record');
              }
              if (!templateId && ws.templateId) {
                templateId = ws.templateId;
                logger.info({ requestId: id, workstreamId, templateId }, 'Inherited templateId from workstream record');
              }
            }
            // Fallback: read directly from the root request row
            if (!ventureId || !templateId) {
              const rootReq = await db.find(request, { id: workstreamId });
              if (rootReq) {
                if (!ventureId && rootReq.ventureId) {
                  ventureId = rootReq.ventureId;
                  logger.info({ requestId: id, workstreamId, ventureId }, 'Inherited ventureId from root request');
                }
                if (!templateId && rootReq.templateId) {
                  templateId = rootReq.templateId;
                  logger.info({ requestId: id, workstreamId, templateId }, 'Inherited templateId from root request');
                }
              }
            }
          } catch (e: any) {
            logger.warn({ requestId: id, workstreamId, error: e?.message }, 'Failed to inherit venture/template from workstream');
          }
        }

        // Update the pre-seeded request row with enriched metadata
        // The create path should never execute here since we pre-seeded above,
        // but include it as a safety fallback
        try {
          // Update the pre-seeded request row with enriched metadata from IPFS
          // Only update enriched fields; preserve pre-seeded base fields (mech, sender, block*, delivered)
          logger.info({ requestId: id, jobName, jobDefinitionId, workstreamId, ventureId, templateId }, "Updating request row with enriched metadata");
          await db.update(request, { id }).set({
            workstreamId,
            ventureId,
            templateId,
            jobDefinitionId: jobDefinitionId,
            sourceRequestId: sourceRequestId,
            sourceJobDefinitionId: sourceJobDefinitionIdFromContent,
            requestData: dataHex || undefined,
            jobName,
            enabledTools,
            additionalContext: contextToStore,
            dependencies,
          });
          logger.info({ requestId: id }, "Enriched update completed successfully");
        } catch (enrichError: any) {
          logger.error({ requestId: id, error: serializeError(enrichError) }, "Enriched update failed");
          throw enrichError;
        }

        // Backfill workstreamId on jobDefinition if it was just created (no-op if already set)
        // Do NOT update workstreamId — a job definition can participate in multiple workstreams
        // The workstreamId field only stores the first workstream the job was created in
        if (jobDefinitionId) {
          try {
            const existingJobDef = await db.find(jobDefinition, { id: jobDefinitionId });
            if (existingJobDef && !existingJobDef.workstreamId) {
              await db.update(jobDefinition, { id: jobDefinitionId }).set({ workstreamId });
            }
            logger.debug({ jobDefinitionId, workstreamId }, "Job definition workstream ID preserved (not updated)");
          } catch (jobDefError: any) {
            logger.error({ jobDefinitionId, error: serializeError(jobDefError) }, "Failed to update job definition");
            // Don't throw - this is not critical enough to fail the entire indexing
          }
        }

        // Index message if present
        if (messageContent) {
          const msgTo = typeof messageContent === 'object' && messageContent.to ? messageContent.to : jobDefinitionId;
          const msgFrom = typeof messageContent === 'object' && messageContent.from ? messageContent.from : sourceJobDefinitionIdFromContent;
          const msgText = typeof messageContent === 'string' ? messageContent : messageContent.content;

          if (msgText) {
            await db.insert(message).values({
              id,
              requestId: id,
              sourceRequestId: sourceRequestId,
              sourceJobDefinitionId: msgFrom,
              to: msgTo,
              content: msgText,
              blockTimestamp,
            }).onConflictDoUpdate({
              content: msgText,
              to: msgTo,
              sourceJobDefinitionId: msgFrom,
            });
          }
        }

        // Update workstream table

        // Extract ventureId and templateId from content if available
        const contentVentureId = typeof content?.ventureId === 'string' ? content.ventureId
          : (additionalContext && typeof additionalContext.ventureId === 'string' ? additionalContext.ventureId : undefined);
        const contentTemplateId = typeof content?.templateId === 'string' ? content.templateId
          : (additionalContext && typeof additionalContext.templateId === 'string' ? additionalContext.templateId : undefined);

        // If this is a root request (sourceRequestId is null), create a workstream entry
        if (!sourceRequestId) {
          await db.insert(workstream).values({
            id: workstreamId,
            rootRequestId: id,
            jobName,
            mech: mech as `0x${string}`,
            sender: sender as `0x${string}`,
            blockTimestamp,
            lastActivity: blockTimestamp,
            childRequestCount: 0,
            hasLauncherBriefing: false,
            delivered: false,
            ventureId: contentVentureId,
            templateId: contentTemplateId,
          }).onConflictDoUpdate({
            lastActivity: blockTimestamp,
            ...(jobName ? { jobName } : {}),
            ...(contentVentureId ? { ventureId: contentVentureId } : {}),
            ...(contentTemplateId ? { templateId: contentTemplateId } : {}),
          });
          logger.debug({ workstreamId, requestId: id }, "Created/updated workstream entry for root request");
        } else {
          // This is a child request, increment the child count in the workstream
          // Use functional update for atomic increment
          const workstreamRecord = await db.find(workstream, { id: workstreamId });
          if (workstreamRecord) {
            await db.update(workstream, { id: workstreamId }).set((row: any) => ({
              childRequestCount: row.childRequestCount + 1,
              lastActivity: blockTimestamp,
            }));
            logger.debug({ workstreamId, requestId: id }, "Incremented child request count for workstream");
          }
        }
      }

      logger.info({ mech, sender, requestIds }, "Indexed MarketplaceRequest");
    } catch (e: any) {
      logger.error({ err: e?.message || String(e), stack: e?.stack }, "Failed to index MarketplaceRequest");
    }
  });

// MarketplaceDelivery handler: marketplace-level delivery event that fires for ALL deliveries
// regardless of which mech delivers. This is the authoritative delivery signal — it sets
// delivered:true for cross-mech deliveries that OlasMech:Deliver may miss (non-Jinn mechs,
// mechs created before factory start block, different Deliver event signatures, etc.)
ponder.on(
  "MechMarketplace:MarketplaceDelivery",
  async ({ event, context }: { event: any; context: any }) => {
    try {
      const db = context.db;
      if (!db) {
        logger.error("Ponder context.db is not available; cannot index MarketplaceDelivery");
        return;
      }

      // MarketplaceDelivery is a batch event: requestIds[] and deliveredRequests[] are arrays
      const requestIds: string[] = (event.args.requestIds as any[]).map((id: any) => String(id));
      const deliveredRequests: boolean[] = event.args.deliveredRequests as boolean[];
      const deliveryMech: string = String(event.args.deliveryMech).toLowerCase();
      const txHash: string = String(event.transaction.hash);
      const blockNumber: bigint = BigInt(toBigIntCoercible(event.block.number));
      const blockTimestamp: bigint = BigInt(toBigIntCoercible(event.block.timestamp));

      let indexedCount = 0;

      for (let i = 0; i < requestIds.length; i++) {
        const requestId = requestIds[i];
        const wasDelivered = deliveredRequests?.[i] ?? true; // default true if array missing

        // Check if this request exists and is a Jinn request
        let existingRequest: any = null;
        try {
          existingRequest = await db.find(request, { id: requestId });
          if (!existingRequest) {
            logger.debug(
              { requestId, deliveryMech, txHash },
              'MarketplaceDelivery for non-Jinn request (not in DB). Skipping.'
            );
            continue;
          }
        } catch (e: any) {
          logger.error({ requestId, error: serializeError(e) }, 'Failed to check request existence before MarketplaceDelivery');
          continue;
        }

        // Update delivery record with marketplace-level delivery mech
        // Include create payload for when OlasMech:Deliver hasn't fired yet
        await db.insert(delivery).values({
          id: requestId,
          requestId,
          mech: existingRequest.mech || '0x0000000000000000000000000000000000000000' as `0x${string}`,
          mechServiceMultisig: '0x0000000000000000000000000000000000000000' as `0x${string}`,
          deliveryMech: deliveryMech as `0x${string}`,
          deliveryRate: 0n,
          transactionHash: txHash,
          blockNumber,
          blockTimestamp,
        }).onConflictDoUpdate({
          deliveryMech: deliveryMech as `0x${string}`,
        });

        // Update request: set delivered:true if the marketplace confirms delivery
        await db.update(request, { id: requestId }).set({
          deliveryMech: deliveryMech as `0x${string}`,
          ...(wasDelivered ? { delivered: true } : {}),
        });

        // If delivered and this is a root request, mark workstream as delivered
        if (wasDelivered && existingRequest.workstreamId && !existingRequest.sourceRequestId) {
          await db.insert(workstream).values({
            id: existingRequest.workstreamId,
            rootRequestId: requestId,
            jobName: existingRequest.jobName || null,
            mech: existingRequest.mech,
            sender: existingRequest.sender,
            blockTimestamp,
            lastActivity: blockTimestamp,
            childRequestCount: 0,
            hasLauncherBriefing: false,
            delivered: true,
          }).onConflictDoUpdate({
            delivered: true,
            lastActivity: blockTimestamp,
          });
          logger.debug({ workstreamId: existingRequest.workstreamId, requestId }, "Marked workstream as delivered via MarketplaceDelivery");
        } else if (wasDelivered && existingRequest.workstreamId) {
          await db.insert(workstream).values({
            id: existingRequest.workstreamId,
            rootRequestId: existingRequest.workstreamId,
            jobName: existingRequest.jobName || null,
            mech: existingRequest.mech,
            sender: existingRequest.sender,
            blockTimestamp,
            lastActivity: blockTimestamp,
            childRequestCount: 0,
            hasLauncherBriefing: false,
            delivered: false,
          }).onConflictDoUpdate({
            lastActivity: blockTimestamp,
          });
        }

        indexedCount++;
      }

      logger.info({ requestIds: requestIds.length, indexedCount, deliveryMech, txHash }, "Indexed MarketplaceDelivery batch");
    } catch (e: any) {
      logger.error({ err: e?.message || String(e), stack: e?.stack }, "Failed to index MarketplaceDelivery");
    }
  });


// OlasMech:Deliver handler: mech-level delivery event with IPFS data
ponder.on(
  "OlasMech:Deliver",
  async ({ event, context }: { event: any; context: any }) => {
    try {
      const db = context.db;
      if (!db) {
        logger.error("Ponder context.db is not available; cannot index OlasMech Deliver");
        return;
      }
      const requestId: string = String(event.args.requestId);
      const dataBytes: string | undefined = event.args.data ? String(event.args.data) : undefined;
      const txHash: string = String(event.transaction.hash);
      const blockNumber: bigint = BigInt(toBigIntCoercible(event.block.number));
      const blockTimestamp: bigint = BigInt(toBigIntCoercible(event.block.timestamp));

      // Check if request exists - it should have been pre-seeded by MarketplaceRequest handler.
      // If indexing from a later start block, we may see Deliver events for requests that were
      // created before our indexing window. Skip these gracefully.
      let existingRequest: any = null;
      try {
        existingRequest = await db.find(request, { id: requestId });
        if (!existingRequest) {
          logger.warn(
            { requestId, txHash },
            'Deliver event received for request that does not exist in database (likely created before indexing start block). Skipping.'
          );
          return;
        }
      } catch (e: any) {
        logger.error({ requestId, error: serializeError(e) }, 'Failed to check request existence before Deliver');
        throw e;
      }

      // Convert raw digest bytes to gateway-compatible CIDv1 (raw codec) hex multibase
      const ipfsHash = dataBytes ? `f01551220${String(dataBytes).replace(/^0x/, '')}` : undefined;

      const mechAddr = String(event.args.mech || "0x0000000000000000000000000000000000000000").toLowerCase() as `0x${string}`;
      const mechMultisig = String(event.args.mechServiceMultisig || "0x0000000000000000000000000000000000000000").toLowerCase() as `0x${string}`;

      await db.insert(delivery).values({
        id: requestId,
        requestId,
        mech: mechAddr,
        mechServiceMultisig: mechMultisig,
        deliveryRate: BigInt(toBigIntCoercible(event.args.deliveryRate ?? 0)),
        ipfsHash,
        transactionHash: txHash,
        blockNumber,
        blockTimestamp,
      }).onConflictDoUpdate({
        mech: mechAddr,
        mechServiceMultisig: mechMultisig,
        deliveryRate: BigInt(toBigIntCoercible(event.args.deliveryRate ?? 0)),
        ipfsHash,
        transactionHash: txHash,
        blockNumber,
        blockTimestamp,
      });

      // Update request with delivery info — only delivery-specific fields
      // Do not overwrite mech, sender, transactionHash, blockNumber, blockTimestamp
      // as they come from MarketplaceRequest event
      await db.update(request, { id: requestId }).set({
        delivered: true,
        deliveryIpfsHash: ipfsHash,
      });

      // If this is a root request (no sourceRequestId), mark the workstream as delivered
      const requestWorkstreamId = existingRequest?.workstreamId;
      const requestSourceRequestId = existingRequest?.sourceRequestId;

      if (requestWorkstreamId && !requestSourceRequestId) {
        // This is a root request, mark workstream as delivered
        await db.insert(workstream).values({
          id: requestWorkstreamId,
          rootRequestId: requestId,
          jobName: existingRequest.jobName || null,
          mech: existingRequest.mech,
          sender: existingRequest.sender,
          blockTimestamp,
          lastActivity: blockTimestamp,
          childRequestCount: 0,
          hasLauncherBriefing: false,
          delivered: true,
        }).onConflictDoUpdate({
          delivered: true,
          lastActivity: blockTimestamp,
        });
        logger.debug({ workstreamId: requestWorkstreamId, requestId }, "Marked workstream as delivered");
      } else if (requestWorkstreamId) {
        // Child request delivered, update lastActivity
        await db.insert(workstream).values({
          id: requestWorkstreamId,
          rootRequestId: requestWorkstreamId,
          jobName: existingRequest.jobName || null,
          mech: existingRequest.mech,
          sender: existingRequest.sender,
          blockTimestamp,
          lastActivity: blockTimestamp,
          childRequestCount: 0,
          hasLauncherBriefing: false,
          delivered: false,
        }).onConflictDoUpdate({
          lastActivity: blockTimestamp,
        });
      }

      // Attempt to resolve artifacts from delivery JSON
      try {
        if (ipfsHash) {
          // Reconstruct directory CID (dag-pb) from digest and fetch the named file (requestId)
          // ipfsHash is 'f01551220' + 64-hex digest (raw codec). Extract digest and build CIDv1 dag-pb.
          const digestHex = String(ipfsHash).replace(/^f01551220/i, '');
          const deliveryCacheKey = `delivery:${digestHex}:${requestId}`;
          const cachedDelivery = await ipfsCacheGet(deliveryCacheKey);
          let res: any = null;
          if (cachedDelivery) {
            res = { status: 200, data: cachedDelivery };
          } else {
            let url = `${IPFS_GATEWAY_BASE}${ipfsHash}`; // fallback
            try {
              const dagPbCid = buildCidFromDigest(digestHex, 'dag-pb');
              url = `${IPFS_GATEWAY_BASE}${dagPbCid.cidBase32}/${requestId}`;
            } catch { }
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                res = await axios.get(url, { timeout: 2000 });
                if (res && res.status === 200 && res.data) break;
              } catch (e) {
                if (attempt < 1) await new Promise(r => setTimeout(r, 500));
              }
            }
            if (res && res.status === 200 && res.data) {
              await ipfsCacheSet(deliveryCacheKey, typeof res.data === 'string' ? res.data : res.data);
            }
          }
          if (res && res.status === 200 && res.data) {
            // Ensure data is parsed if it came back as string (e.g. wrong content-type)
            if (typeof res.data === 'string') {
              try { res.data = JSON.parse(res.data); } catch { }
            }

            // Try to extract jobDefinitionId from delivery payload
            const deliveryJobDefinitionId = typeof res.data.jobDefinitionId === 'string' ? res.data.jobDefinitionId : undefined;
            const jobName = typeof res.data.jobName === 'string' ? res.data.jobName : undefined;
            // Use shared extractToolName utility (handles both string and {name, required} formats)
            const enabledTools = Array.isArray(res.data.enabledTools)
              ? res.data.enabledTools.map(extractToolName).filter((name: string | null): name is string => name !== null)
              : undefined;
            // Support both blueprint (new) and prompt (legacy)
            const blueprint = typeof res.data.blueprint === 'string'
              ? res.data.blueprint
              : (typeof res.data.prompt === 'string' ? res.data.prompt : undefined);
            // Extract actual job status from delivery payload (COMPLETED, FAILED, DELEGATING, WAITING)
            const deliveryStatus = typeof res.data.status === 'string' ? res.data.status : 'COMPLETED';

            // Extract job instance status update (if available)
            const jobInstanceStatusUpdate = typeof res.data.jobInstanceStatusUpdate === 'string'
              ? res.data.jobInstanceStatusUpdate
              : undefined;

            // Write lastStatus (and backfill jobName if missing) to workstream for root requests
            if (requestWorkstreamId && !requestSourceRequestId) {
              try {
                await db.update(workstream, { id: requestWorkstreamId }).set({
                  lastStatus: deliveryStatus,
                  ...(jobInstanceStatusUpdate ? { latestStatusUpdate: jobInstanceStatusUpdate } : {}),
                  ...(jobName ? { jobName } : {}),
                });
                logger.debug({ workstreamId: requestWorkstreamId, deliveryStatus, jobName }, "Updated workstream lastStatus");
              } catch (wsErr: any) {
                logger.error({ workstreamId: requestWorkstreamId, error: serializeError(wsErr) }, "Failed to update workstream lastStatus");
              }
            }

            // Backfill job definition on delivery if available
            // Note: deliveryJobDefinitionId from delivery JSON is the job that was executed (target job)
            if (deliveryJobDefinitionId) {
              try {
                // Inherit workstreamId from the request (or default to requestId if root)
                const workstreamId = existingRequest?.workstreamId || requestId;

                // LIMITATION: lastStatus reflects the status of the most recent run only.
                // Consumers should query child requests directly via sourceJobDefinitionId
                // to determine true job-level completion status across all runs.

                await db.insert(jobDefinition).values({
                  id: deliveryJobDefinitionId,
                  name: jobName || 'Unnamed Job',
                  enabledTools,
                  blueprint,
                  workstreamId,
                  sourceRequestId: requestId,
                  createdAt: blockTimestamp,
                  lastInteraction: blockTimestamp,
                  lastStatus: deliveryStatus,
                  latestStatusUpdate: jobInstanceStatusUpdate,
                  ...(jobInstanceStatusUpdate ? { latestStatusUpdateAt: blockTimestamp } : {}),
                }).onConflictDoUpdate({
                  name: jobName || 'Unnamed Job',
                  enabledTools,
                  blueprint,
                  // Don't overwrite workstreamId on update
                  sourceRequestId: requestId,
                  lastInteraction: blockTimestamp,
                  lastStatus: deliveryStatus,
                  // Only update status fields if we have a new status update
                  ...(jobInstanceStatusUpdate ? {
                    latestStatusUpdate: jobInstanceStatusUpdate,
                    latestStatusUpdateAt: blockTimestamp,
                  } : {}),
                });
              } catch (jdErr: any) {
                logger.error({ jobDefinitionId: deliveryJobDefinitionId, error: serializeError(jdErr) }, "Failed to backfill job definition in Deliver handler");
              }
              // Backfill jobDefinitionId (target job) on delivery and request, including status update
              await db.update(delivery, { id: requestId }).set({
                sourceJobDefinitionId: deliveryJobDefinitionId,
                sourceRequestId: requestId,
                jobInstanceStatusUpdate
              });
              await db.update(request, { id: requestId }).set({
                jobDefinitionId: deliveryJobDefinitionId,
                ...(jobName ? { jobName } : {}),
              });
            } else {
              // Fallback: if request has a jobDefinitionId already, propagate it to delivery as sourceJobDefinitionId
              try {
                const req = await db.find(request, { id: requestId });
                if (req && typeof req.jobDefinitionId === 'string') {
                  await db.update(delivery, { id: requestId }).set({
                    sourceJobDefinitionId: req.jobDefinitionId,
                    sourceRequestId: requestId,
                    jobInstanceStatusUpdate
                  });
                }
              } catch { }
            }

            if (Array.isArray(res.data.artifacts)) {
              // Fetch the request to get its sourceRequestId and venture/workstream/template IDs for proper attribution
              let requestSourceRequestId: string | undefined = undefined;
              let requestVentureId: string | undefined = undefined;
              let requestWorkstreamId: string | undefined = undefined;
              let requestTemplateId: string | undefined = undefined;
              try {
                const req = await db.find(request, { id: requestId });
                requestSourceRequestId = req && typeof req.sourceRequestId === 'string' ? req.sourceRequestId : undefined;
                requestVentureId = req && typeof req.ventureId === 'string' ? req.ventureId : undefined;
                requestWorkstreamId = req && typeof req.workstreamId === 'string' ? req.workstreamId : undefined;
                requestTemplateId = req && typeof req.templateId === 'string' ? req.templateId : undefined;
              } catch { }

              for (let idx = 0; idx < res.data.artifacts.length; idx++) {
                const a = res.data.artifacts[idx] || {};
                const id = `${requestId}:${idx}`;
                const name = typeof a.name === 'string' ? a.name : `artifact-${idx}`;
                const cid = String(a.cid || '');
                const topic = String(a.topic || '');
                const contentPreview = typeof a.contentPreview === 'string' ? a.contentPreview : undefined;
                const type = typeof a.type === 'string' ? a.type : undefined;
                const contentCid = typeof a.contentCid === 'string' ? a.contentCid : undefined;
                const documentType = typeof a.documentType === 'string' ? a.documentType : undefined;
                const tags = Array.isArray(a.tags) ? a.tags.map((t: any) => String(t)) : undefined;
                if (!cid || !topic) continue;
                // Use the request's sourceRequestId if it exists (for child jobs), otherwise use requestId itself (for root jobs)
                const artifactSourceRequestId = requestSourceRequestId || requestId;
                // Derive workstreamId: use request's workstreamId if available, otherwise the sourceRequestId (root request = workstream)
                const artifactWorkstreamId = requestWorkstreamId || artifactSourceRequestId;
                const artifactPayload: any = {
                  requestId, name, cid, contentCid, topic, contentPreview, type, documentType, tags,
                  sourceRequestId: artifactSourceRequestId,
                  ventureId: requestVentureId,
                  workstreamId: artifactWorkstreamId,
                  templateId: requestTemplateId,
                  blockTimestamp: event.block.timestamp,
                };
                // Prefer delivery sourceJobDefinitionId; fallback to request.sourceJobDefinitionId if not present
                if (deliveryJobDefinitionId) {
                  artifactPayload.sourceJobDefinitionId = deliveryJobDefinitionId;
                } else {
                  try {
                    const req = await db.find(request, { id: requestId });
                    if (req && typeof req.sourceJobDefinitionId === 'string') {
                      artifactPayload.sourceJobDefinitionId = req.sourceJobDefinitionId;
                    }
                  } catch { }
                }
                await db.insert(artifact).values({ id, ...artifactPayload })
                  .onConflictDoUpdate(artifactPayload);

                // If this is a launcher_briefing artifact, update the workstream
                if (topic === 'launcher_briefing') {
                  const workstreamId = artifactSourceRequestId; // The sourceRequestId is the root workstream ID
                  const workstreamRecord = await db.find(workstream, { id: workstreamId });
                  if (workstreamRecord) {
                    await db.update(workstream, { id: workstreamId }).set({
                      hasLauncherBriefing: true,
                      lastActivity: blockTimestamp,
                    });
                    logger.debug({ workstreamId, artifactId: id }, "Marked workstream as having launcher briefing");
                  }
                }

                if (type === 'SITUATION') {
                  const pool = getVectorDbPool();
                  if (!pool) {
                    logger.warn('node_embeddings database not configured; skipping situation indexing');
                    continue;
                  }

                  try {
                    const situationUrl = `${IPFS_GATEWAY_BASE}${cid}`;
                    const situationRes = await axios.get(situationUrl, { timeout: 3000 });
                    let situationData = situationRes?.data || {};

                    // IPFS artifact may be wrapped with metadata (name, topic, content fields)
                    // If so, parse the content field which contains the actual situation JSON
                    if (situationData.content && typeof situationData.content === 'string') {
                      try {
                        situationData = JSON.parse(situationData.content);
                      } catch (parseError) {
                        logger.warn({ requestId, cid }, 'Failed to parse artifact content field');
                      }
                    }

                    const situation = situationData;
                    const embedding = situation?.embedding;
                    const vector: number[] | undefined = Array.isArray(embedding?.vector) ? embedding.vector : undefined;
                    const model: string | undefined = typeof embedding?.model === 'string' ? embedding.model : undefined;
                    const dim: number | undefined = typeof embedding?.dim === 'number' ? embedding.dim : Array.isArray(embedding?.vector) ? embedding.vector.length : undefined;
                    const nodeId = typeof situation?.job?.requestId === 'string' ? situation.job.requestId : requestId;

                    if (!vector || vector.length === 0 || !model || !dim) {
                      logger.warn({ requestId, cid }, 'Situation artifact missing embedding payload');
                      continue;
                    }

                    const summary =
                      truncate(situation?.meta?.summaryText) ||
                      truncate(situation?.execution?.finalOutputSummary) ||
                      truncate(situation?.job?.objective) ||
                      truncate(situation?.job?.jobName);

                    const metaPayload = {
                      version: situation?.version,
                      artifactCid: cid,
                      artifactId: id,
                      job: situation?.job,
                      context: situation?.context,
                      artifacts: situation?.artifacts,
                      recognition: situation?.meta?.recognition,
                    };

                    // Use test table when running under Vitest to isolate test data
                    const tableName = process.env.VITEST === 'true' ? 'node_embeddings_test' : 'node_embeddings';

                    const sql = `
                    INSERT INTO ${tableName} (node_id, model, dim, vec, summary, meta)
                    VALUES ($1, $2, $3, $4::vector, $5, $6)
                    ON CONFLICT (node_id)
                    DO UPDATE SET
                      model = EXCLUDED.model,
                      dim = EXCLUDED.dim,
                      vec = EXCLUDED.vec,
                      summary = EXCLUDED.summary,
                      meta = EXCLUDED.meta,
                      updated_at = NOW();
                  `;

                    await pool.query(sql, [
                      nodeId,
                      model,
                      dim,
                      formatVectorLiteral(vector),
                      summary,
                      metaPayload,
                    ]);
                    logger.info({ requestId: nodeId, cid }, 'Indexed situation embedding');
                  } catch (indexError: any) {
                    logger.error({ requestId, cid, error: serializeError(indexError) }, 'Failed to index situation embedding');
                  }
                }
              }
            }
          }
        }
      } catch (e: any) {
        logger.error({ requestId, err: e?.message || String(e) }, 'Failed to resolve delivery artifacts (OlasMech)');
      }

      logger.info({ requestId, ipfsHash }, "Indexed OlasMech Deliver");
    } catch (e: any) {
      logger.error({ err: e?.message || String(e), stack: e?.stack }, "Failed to index OlasMech Deliver");
    }
  });

// ============================================================================
// CreateMech handler: Maps service IDs to mech addresses
// This enables looking up which mech belongs to which service
// ============================================================================
ponder.on(
  "MechMarketplace:CreateMech",
  async ({ event, context }: { event: any; context: any }) => {
    try {
      const db = context.db;
      if (!db) {
        logger.error("Ponder context.db is not available; cannot index CreateMech");
        return;
      }

      const mech: string = String(event.args.mech).toLowerCase();
      const serviceId: bigint = BigInt(toBigIntCoercible(event.args.serviceId));
      const mechFactory: string = String(event.args.mechFactory).toLowerCase();
      const blockTimestamp: bigint = BigInt(toBigIntCoercible(event.block.timestamp));

      // Don't update — first seen is authoritative
      await db.insert(mechServiceMapping).values({
        id: mech,
        mech: mech as `0x${string}`,
        serviceId,
        mechFactory: mechFactory as `0x${string}`,
        blockTimestamp,
      }).onConflictDoNothing();

      // Keep the in-memory allowlist current: if this service is staked in a
      // Jinn staking contract, add its mech to the allowlist immediately.
      serviceIdToMech.set(serviceId.toString(), mech);
      if (jinnStakedServiceIds.has(serviceId.toString())) {
        if (jinnMechAddresses) {
          jinnMechAddresses.add(mech);
          logger.info({ mech, serviceId: serviceId.toString() }, 'Added new mech to Jinn allowlist via CreateMech');
        }
      }

      logger.info({ mech, serviceId: serviceId.toString(), mechFactory }, "Indexed CreateMech (service-to-mech mapping)");
    } catch (e: any) {
      logger.error({ err: e?.message || String(e), stack: e?.stack }, "Failed to index CreateMech");
    }
  }
);

// ============================================================================
// ServiceStaked handler: Track when services are staked in staking contracts
// ============================================================================
// Factory creates a handler bound to a specific staking contract address.
// Ponder 0.15.x event objects don't expose event.log.address — only
// event.args, event.block, event.transaction — so we pass address explicitly.
const createServiceStakedHandler = (contractAddress: string) =>
  async ({ event, context }: { event: any; context: any }) => {
    try {
      const db = context.db;
      if (!db) {
        logger.error("Ponder context.db is not available; cannot index ServiceStaked");
        return;
      }

      const serviceId: bigint = BigInt(toBigIntCoercible(event.args.serviceId));
      const owner: string = String(event.args.owner).toLowerCase();
      const multisig: string = String(event.args.multisig).toLowerCase();
      const blockTimestamp: bigint = BigInt(toBigIntCoercible(event.block.timestamp));
      const stakingContract: string = contractAddress.toLowerCase();

      const id = `${serviceId.toString()}:${stakingContract}`;

      await db.insert(stakedService).values({
        id,
        serviceId,
        stakingContract: stakingContract as `0x${string}`,
        owner: owner as `0x${string}`,
        multisig: multisig as `0x${string}`,
        stakedAt: blockTimestamp,
        isStaked: true,
      }).onConflictDoUpdate({
        owner: owner as `0x${string}`,
        multisig: multisig as `0x${string}`,
        stakedAt: blockTimestamp,
        unstakedAt: null,
        isStaked: true,
      });

      // Keep the in-memory allowlist current: if this service already has a
      // known mech (from CreateMech), add it to the allowlist immediately.
      jinnStakedServiceIds.add(serviceId.toString());
      const knownMech = serviceIdToMech.get(serviceId.toString());
      if (knownMech && jinnMechAddresses) {
        jinnMechAddresses.add(knownMech);
        logger.info({ mech: knownMech, serviceId: serviceId.toString() }, 'Added new mech to Jinn allowlist via ServiceStaked');
      }

      logger.info({
        serviceId: serviceId.toString(),
        stakingContract,
        owner,
        multisig
      }, "Indexed ServiceStaked");
    } catch (e: any) {
      logger.error({ err: e?.message || String(e), stack: e?.stack }, "Failed to index ServiceStaked");
    }
  };
ponder.on("JinnStaking:ServiceStaked", createServiceStakedHandler('0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139'));
ponder.on("JinnStakingV2:ServiceStaked", createServiceStakedHandler('0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488'));

// ============================================================================
// ServiceUnstaked handler: Track when services are unstaked from staking contracts
// ============================================================================
const createServiceUnstakedHandler = (contractAddress: string) =>
  async ({ event, context }: { event: any; context: any }) => {
    try {
      const db = context.db;
      if (!db) {
        logger.error("Ponder context.db is not available; cannot index ServiceUnstaked");
        return;
      }

      const serviceId: bigint = BigInt(toBigIntCoercible(event.args.serviceId));
      const blockTimestamp: bigint = BigInt(toBigIntCoercible(event.block.timestamp));
      const stakingContract: string = contractAddress.toLowerCase();

      const id = `${serviceId.toString()}:${stakingContract}`;

      // Check if record exists before updating
      const existing = await db.find(stakedService, { id });
      if (!existing) {
        logger.warn({
          serviceId: serviceId.toString(),
          stakingContract
        }, "ServiceUnstaked event for unknown staked service");
        return;
      }

      await db.update(stakedService, { id }).set({
        unstakedAt: blockTimestamp,
        isStaked: false,
      });

      logger.info({
        serviceId: serviceId.toString(),
        stakingContract
      }, "Indexed ServiceUnstaked");
    } catch (e: any) {
      logger.error({ err: e?.message || String(e), stack: e?.stack }, "Failed to index ServiceUnstaked");
    }
  };
ponder.on("JinnStaking:ServiceUnstaked", createServiceUnstakedHandler('0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139'));
ponder.on("JinnStakingV2:ServiceUnstaked", createServiceUnstakedHandler('0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488'));
