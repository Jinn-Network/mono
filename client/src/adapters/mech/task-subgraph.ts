import { getAddress, keccak256, toBytes, type Address, type Hex } from 'viem';

export interface TaskDiscoverySubgraphConfig {
  url: string;
  solverNetManifestCids: string[];
  operatorAddress: Address;
  nowSeconds?: number;
  pageSize?: number;
  maxPages?: number;
  fetchImpl?: typeof fetch;
}

export interface SubgraphTaskCandidate {
  taskId: string;
  taskCidDigest: Hex;
  manifestDigest: Hex;
  createdAtBlock?: number;
  createdAtTx?: Hex;
  claimWindowEnd?: number;
  maxClaims?: number;
  attemptCount: number;
  operatorAttemptCount: number;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface TaskCandidateRow {
  id?: string;
  taskId?: string;
  taskCidDigest?: string;
  manifestDigest?: string;
  createdAtBlock?: string | number | null;
  createdAtTx?: string | null;
  claimWindowEnd?: string | number | null;
  maxClaims?: number | null;
  attempts?: unknown[] | null;
  operatorAttempts?: unknown[] | null;
}

interface TaskCandidatePage {
  tasks?: TaskCandidateRow[];
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;

const CLAIMABLE_TASKS_QUERY = `
query ClaimableTaskCandidates(
  $now: BigInt!,
  $manifestDigest: Bytes!,
  $operator: Bytes!,
  $first: Int!,
  $skip: Int!
) {
  tasks(
    first: $first,
    skip: $skip,
    orderBy: taskId,
    orderDirection: asc,
    where: {
      manifestDigest: $manifestDigest,
      claimWindowStart_lte: $now,
      claimWindowEnd_gte: $now,
      refunded: false,
      finalized: false
    }
  ) {
    id
    taskId
    taskCidDigest
    manifestDigest
    maxClaims
    claimWindowEnd
    createdAtBlock
    createdAtTx
    attempts(first: 100) {
      id
    }
    operatorAttempts: attempts(first: 10, where: { operator: $operator }) {
      id
    }
  }
}
`;

function isHex(value: string | undefined, byteLength?: number): value is Hex {
  if (!value || !/^0x[0-9a-fA-F]+$/.test(value)) return false;
  return byteLength === undefined || value.length === 2 + byteLength * 2;
}

function parseOptionalNumber(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeCandidate(row: TaskCandidateRow): SubgraphTaskCandidate | undefined {
  const taskId = row.taskId ?? row.id;
  if (!taskId) return undefined;
  if (!isHex(row.taskCidDigest, 32)) return undefined;
  if (!isHex(row.manifestDigest, 32)) return undefined;
  if (row.createdAtTx != null && !isHex(row.createdAtTx, 32)) return undefined;

  const attempts = Array.isArray(row.attempts) ? row.attempts : [];
  const operatorAttempts = Array.isArray(row.operatorAttempts) ? row.operatorAttempts : [];
  const maxClaims = typeof row.maxClaims === 'number' && row.maxClaims > 0
    ? row.maxClaims
    : undefined;

  if (maxClaims !== undefined && attempts.length >= maxClaims) return undefined;
  if (operatorAttempts.length > 0) return undefined;

  const out: SubgraphTaskCandidate = {
    taskId,
    taskCidDigest: row.taskCidDigest as Hex,
    manifestDigest: row.manifestDigest as Hex,
    attemptCount: attempts.length,
    operatorAttemptCount: operatorAttempts.length,
  };
  const createdAtBlock = parseOptionalNumber(row.createdAtBlock);
  if (createdAtBlock !== undefined) out.createdAtBlock = createdAtBlock;
  if (row.createdAtTx) out.createdAtTx = row.createdAtTx as Hex;
  const claimWindowEnd = parseOptionalNumber(row.claimWindowEnd);
  if (claimWindowEnd !== undefined) out.claimWindowEnd = claimWindowEnd;
  if (maxClaims !== undefined) out.maxClaims = maxClaims;
  return out;
}

async function postGraphql<T>(
  url: string,
  fetchImpl: typeof fetch,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`subgraph HTTP ${response.status}`);
  }
  const json = await response.json() as GraphqlResponse<T>;
  if (json.errors?.length) {
    const message = json.errors.map((e) => e.message ?? 'unknown error').join('; ');
    throw new Error(`subgraph GraphQL error: ${message}`);
  }
  if (!json.data) {
    throw new Error('subgraph response missing data');
  }
  return json.data;
}

export function manifestDigestForCid(manifestCid: string): Hex {
  return keccak256(toBytes(manifestCid));
}

export async function queryClaimableTaskCandidates(
  config: TaskDiscoverySubgraphConfig,
): Promise<SubgraphTaskCandidate[]> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('global fetch is unavailable; cannot query task subgraph');
  }

  const manifestCids = Array.from(new Set(config.solverNetManifestCids.filter(Boolean)));
  if (manifestCids.length === 0) return [];

  const first = Math.min(100, Math.max(1, Math.floor(config.pageSize ?? DEFAULT_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.floor(config.maxPages ?? DEFAULT_MAX_PAGES));
  const now = String(config.nowSeconds ?? Math.floor(Date.now() / 1000));
  const operator = getAddress(config.operatorAddress).toLowerCase();
  const seen = new Set<string>();
  const out: SubgraphTaskCandidate[] = [];

  for (const manifestCid of manifestCids) {
    const manifestDigest = manifestDigestForCid(manifestCid).toLowerCase();
    for (let page = 0; page < maxPages; page++) {
      const data = await postGraphql<TaskCandidatePage>(config.url, fetchImpl, {
        query: CLAIMABLE_TASKS_QUERY,
        variables: {
          now,
          manifestDigest,
          operator,
          first,
          skip: page * first,
        },
      });
      const rows = data.tasks ?? [];
      for (const row of rows) {
        const candidate = normalizeCandidate(row);
        if (!candidate || seen.has(candidate.taskId)) continue;
        seen.add(candidate.taskId);
        out.push(candidate);
      }
      if (rows.length < first) break;
    }
  }

  out.sort((a, b) => Number(BigInt(a.taskId) - BigInt(b.taskId)));
  return out;
}
