/**
 * Free artifact fetch — pulls remote artifact bytes over plain HTTP.
 *
 * Knowledge is a free, opt-in public good (tokenless-OLAS pivot): artifact
 * acquisition is an unauthenticated GET, no payment wrapper. The server
 * returns raw bytes; the consumer hashes them locally to verify integrity
 * against the envelope's `artifact.sha256` field.
 *
 * Keys artifacts by sha256 (not IPFS CID) — artifacts no longer have IPFS
 * CIDs (post jinn-mono-vy37.1.2).
 */

export type AcquireResult =
  | { ok: true; content: Buffer }
  | { ok: false; reason: 'not_found' | 'network_error'; message?: string };

export function buildArtifactUrl(endpoint: string, sha256: string): string {
  return `${endpoint.replace(/\/$/, '')}/v1/artifacts/${sha256}/content`;
}

export async function fetchArtifactContent(
  endpoint: string,
  sha256: string,
): Promise<AcquireResult> {
  const url = buildArtifactUrl(endpoint, sha256);
  try {
    const response = await globalThis.fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        return { ok: false, reason: 'not_found', message: `HTTP 404 for ${url}` };
      }
      return { ok: false, reason: 'network_error', message: `HTTP ${response.status} for ${url}` };
    }
    const buf = Buffer.from(await response.arrayBuffer());
    return { ok: true, content: buf };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'network_error', message };
  }
}
