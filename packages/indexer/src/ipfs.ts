/**
 * Minimal IPFS-gateway fetch helper for the indexer's envelope-enrichment pass.
 * Mirrors the gateway-base normalization in operator/src/adapters/mech/ipfs.ts.
 */

export const DEFAULT_IPFS_GATEWAY = 'https://gateway.autonolas.tech';

/**
 * Minimal fetch-compatible signature accepted by fetchIpfsJson.
 * Narrower than the full `typeof fetch` overloads so test stubs can accept
 * `string` without TypeScript complaining about URL | RequestInfo incompatibility.
 */
export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'> & Partial<Pick<Response, 'headers' | 'text'>>>;

const CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_SAFE_RE = /^b[A-Za-z0-9-]{3,}$/;
const MAX_IPFS_JSON_BYTES = 1_000_000;

export function isLikelyIpfsCid(cid: string): boolean {
  return CID_V0_RE.test(cid) || CID_V1_SAFE_RE.test(cid);
}

/** Normalize a gateway base to end with `/ipfs/`. Empty → DEFAULT_IPFS_GATEWAY. */
export function normalizeIpfsGatewayBase(base: string | undefined): string {
  let t = (base ?? '').trim();
  if (t === '') t = DEFAULT_IPFS_GATEWAY;
  t = t.replace(/\/+$/, '');
  if (!t.endsWith('/ipfs')) t = `${t}/ipfs`;
  return `${t}/`;
}

/** Fetch and JSON-parse an IPFS object. Throws on timeout, non-2xx, or non-JSON. */
export async function fetchIpfsJson(
  gatewayBase: string,
  cid: string,
  opts?: { timeoutMs?: number; fetchImpl?: FetchLike },
): Promise<unknown> {
  if (!isLikelyIpfsCid(cid)) throw new Error(`invalid IPFS CID: ${cid}`);
  const f: FetchLike = opts?.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = `${normalizeIpfsGatewayBase(gatewayBase)}${encodeURIComponent(cid)}`;
  const res = await f(url, { signal: AbortSignal.timeout(opts?.timeoutMs ?? 5000) });
  if (!res.ok) throw new Error(`IPFS gateway ${res.status} for ${cid}`);
  const contentLength = res.headers?.get?.('content-length');
  if (contentLength !== undefined && contentLength !== null && Number(contentLength) > MAX_IPFS_JSON_BYTES) {
    throw new Error(`IPFS JSON too large for ${cid}`);
  }
  if (typeof res.text === 'function') {
    const text = await res.text();
    if (text.length > MAX_IPFS_JSON_BYTES) throw new Error(`IPFS JSON too large for ${cid}`);
    return JSON.parse(text);
  }
  return res.json();
}
