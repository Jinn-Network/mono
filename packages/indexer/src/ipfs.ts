/**
 * Minimal IPFS-gateway fetch helper for the indexer's envelope-enrichment pass.
 * Mirrors the gateway-base normalization in client/src/adapters/mech/ipfs.ts.
 */

export const DEFAULT_IPFS_GATEWAY = 'https://gateway.autonolas.tech';

/**
 * Minimal fetch-compatible signature accepted by fetchIpfsJson.
 * Narrower than the full `typeof fetch` overloads so test stubs can accept
 * `string` without TypeScript complaining about URL | RequestInfo incompatibility.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

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
  const f: FetchLike = opts?.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = `${normalizeIpfsGatewayBase(gatewayBase)}${cid}`;
  const res = await f(url, { signal: AbortSignal.timeout(opts?.timeoutMs ?? 5000) });
  if (!res.ok) throw new Error(`IPFS gateway ${res.status} for ${cid}`);
  return res.json();
}
