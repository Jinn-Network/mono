const IPFS_FETCH_TIMEOUT_MS = 15_000;
/**
 * Bound on the whole `fetchFromIpfs` call. The per-attempt timer above is
 * re-armed for every gateway x CID candidate, so without this a single call
 * could legitimately run for the product of the two.
 */
const IPFS_TOTAL_FETCH_TIMEOUT_MS = 45_000;
/**
 * Corpus manifests and donation artifacts are JSON envelopes orders of
 * magnitude smaller than this; a response above it is hostile or broken, and
 * buffering it would exhaust memory (#3410).
 */
const MAX_IPFS_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_IPFS_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FALLBACK_IPFS_GATEWAY_BASE = 'https://ipfs.io/ipfs/';

export function normalizeIpfsGatewayBase(gatewayUrl: string): string {
  let normalized = gatewayUrl.trim();
  if (normalized === '') normalized = 'https://gateway.autonolas.tech';
  normalized = normalized.replace(/\/+$/, '');
  if (!normalized.toLowerCase().endsWith('/ipfs')) normalized = `${normalized}/ipfs`;
  return `${normalized}/`;
}

export function buildIpfsHexCidCandidatesFromPartialHex(hex: string): string[] {
  const normalized = (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return [hex];
  return [`f01551220${normalized}`, `f01701220${normalized}`];
}

export function buildIpfsFetchCidPathCandidates(cidOrPath: string): string[] {
  const value = cidOrPath.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('f01551220') && lower.length > 9) {
    return buildIpfsHexCidCandidatesFromPartialHex(lower.slice(9));
  }
  if (lower.startsWith('f01701220') && lower.length > 9) {
    return buildIpfsHexCidCandidatesFromPartialHex(lower.slice(9));
  }
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return buildIpfsHexCidCandidatesFromPartialHex(value);
  }
  return [value];
}

function isHostInGatewayFamily(host: string, gatewayHost: string): boolean {
  const candidate = host.toLowerCase();
  const gateway = gatewayHost.toLowerCase();
  return candidate === gateway || candidate.endsWith(`.${gateway}`);
}

/**
 * A gateway may legitimately redirect the path form of a CID to its subdomain
 * form, so hops are allowed inside the configured gateway's host family. They
 * are never allowed to leave it, to downgrade the transport, or to smuggle
 * credentials.
 */
function assertRedirectAllowed(next: URL, current: URL, gatewayHost: string): void {
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new Error(`IPFS redirect uses an unsupported scheme (${next.protocol})`);
  }
  if (current.protocol === 'https:' && next.protocol === 'http:') {
    throw new Error('IPFS redirect downgrades https to http');
  }
  if (next.username !== '' || next.password !== '') {
    throw new Error('IPFS redirect carries embedded credentials');
  }
  if (!isHostInGatewayFamily(next.hostname, gatewayHost)) {
    throw new Error(`IPFS redirect leaves the configured gateway (${next.hostname})`);
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that refuses to cancel is not worth failing the request over.
  }
}

/** Read a response body as text, refusing anything past the byte cap. */
async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IPFS_RESPONSE_BYTES) {
    await discardBody(response);
    throw new Error(
      `IPFS response exceeds the ${MAX_IPFS_RESPONSE_BYTES}-byte cap ` +
        `(content-length ${declared})`,
    );
  }
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_IPFS_RESPONSE_BYTES) {
        throw new Error(`IPFS response exceeds the ${MAX_IPFS_RESPONSE_BYTES}-byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already terminal; the read result (or throw) above is what matters.
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const gatewayHost = new URL(url).hostname;
  let current = new URL(url);
  for (let hop = 0; ; hop += 1) {
    // Redirects are resolved here rather than by `fetch`, so every hop is
    // revalidated against the configured gateway before it is requested.
    const response = await fetch(current, { method: 'GET', redirect: 'manual', signal });
    if (REDIRECT_STATUSES.has(response.status)) {
      await discardBody(response);
      if (hop >= MAX_IPFS_REDIRECT_HOPS) {
        throw new Error(`IPFS fetch exceeded ${MAX_IPFS_REDIRECT_HOPS} redirects`);
      }
      const location = response.headers.get('location');
      if (location === null || location.trim() === '') {
        throw new Error(`IPFS gateway returned ${response.status} without a Location header`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('IPFS redirect Location is not a valid URL');
      }
      assertRedirectAllowed(next, current, gatewayHost);
      current = next;
      continue;
    }
    if (!response.ok) {
      await discardBody(response);
      throw new Error(
        `IPFS fetch failed: ${response.status} ${response.statusText} ` +
          `(${current.toString().slice(0, 80)}…)`,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    const text = await readBoundedText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`IPFS response is not JSON (content-type: ${contentType || 'none'})`);
    }
  }
}

export type FetchFromIpfsOptions = {
  /**
   * Extra gateway base after the primary fails.
   * - omit / undefined → production default `https://ipfs.io/ipfs/`
   * - false → primary gateway only (hermetic / pinned rigs)
   * - string → alternate fallback (normalized via `normalizeIpfsGatewayBase`)
   */
  fallbackGatewayBase?: string | false;
};

function resolveFallbackGatewayBases(
  opts?: FetchFromIpfsOptions,
): Array<readonly [string, string]> {
  if (opts?.fallbackGatewayBase === false) return [];
  if (typeof opts?.fallbackGatewayBase === 'string') {
    return [['fallback', normalizeIpfsGatewayBase(opts.fallbackGatewayBase)] as const];
  }
  return [['fallback', FALLBACK_IPFS_GATEWAY_BASE] as const];
}

/** Read-only multi-codec, primary-plus-fallback IPFS JSON fetch. */
export async function fetchFromIpfs(
  gatewayUrl: string,
  cid: string,
  opts?: FetchFromIpfsOptions,
): Promise<unknown> {
  const primary = normalizeIpfsGatewayBase(gatewayUrl);
  const gateways: Array<readonly [string, string]> = [
    ['primary', primary] as const,
    ...resolveFallbackGatewayBases(opts),
  ];
  const errors: string[] = [];
  const deadline = Date.now() + IPFS_TOTAL_FETCH_TIMEOUT_MS;
  outer: for (const cidPath of buildIpfsFetchCidPathCandidates(cid)) {
    for (const [name, baseUrl] of gateways) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        errors.push(`whole-operation timeout after ${IPFS_TOTAL_FETCH_TIMEOUT_MS}ms`);
        break outer;
      }
      const url = `${baseUrl}${cidPath}`;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(IPFS_FETCH_TIMEOUT_MS, remainingMs),
      );
      try {
        return await fetchJson(url, controller.signal);
      } catch (error) {
        errors.push(
          `${name}:${url.slice(0, 100)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`IPFS JSON fetch failed after all candidates: ${errors.join(' | ')}`);
}
