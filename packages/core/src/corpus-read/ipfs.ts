const IPFS_FETCH_TIMEOUT_MS = 15_000;
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

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { method: 'GET', signal });
  if (!response.ok) {
    throw new Error(
      `IPFS fetch failed: ${response.status} ${response.statusText} (${url.slice(0, 80)}…)`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return response.json();
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`IPFS response is not JSON (content-type: ${contentType || 'none'})`);
  }
}

/** Read-only multi-codec, primary-plus-fallback IPFS JSON fetch. */
export async function fetchFromIpfs(gatewayUrl: string, cid: string): Promise<unknown> {
  const primary = normalizeIpfsGatewayBase(gatewayUrl);
  const errors: string[] = [];
  for (const cidPath of buildIpfsFetchCidPathCandidates(cid)) {
    for (const [name, baseUrl] of [
      ['primary', primary] as const,
      ['fallback', FALLBACK_IPFS_GATEWAY_BASE] as const,
    ]) {
      const url = `${baseUrl}${cidPath}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IPFS_FETCH_TIMEOUT_MS);
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
