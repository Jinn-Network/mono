/**
 * Per-artifact resolution chain: cache → self-store → routeResolver → origin.
 *
 * Always hash-verifies before persisting to cache.
 *
 * The two *network* legs — the donated IPFS mirror and the operator origin —
 * are not implemented here: they are `fetchVerifiedArtifact`, the keyless
 * retrieval primitive (#4179). What remains in this file is the store-aware
 * composition around it: the cache read, the self-store mirror, the route
 * resolver, and the cache writes whose ordering the daemon owns.
 *
 * Spec §2.3 step 4-6.
 */

import { fetchArtifactContent, type AcquireResult } from './fetch-artifact.js';
import { fetchVerifiedArtifact, verifyArtifactDigest } from './artifact-retrieval.js';
import type {
  ArtifactContent,
  ArtifactSource,
  CorpusStorePort,
  RouteResolver,
} from './types.js';
import { AcquireError, HashMismatchError } from './types.js';

/**
 * Origin acquire function. Historically returned `Buffer | null`; the
 * discriminated union lets callers distinguish not_found vs network_error.
 * We accept either shape so test fakes that still return `Buffer | null`
 * keep working. `privateKey` is accepted for signature compatibility with
 * older fakes but is unused — acquisition is a free fetch now.
 */
type AcquireFn = (
  endpoint: string,
  sha256: string,
  privateKey?: string,
) => Promise<Buffer | null | AcquireResult>;
type FetchFromIpfsFn = (gatewayUrl: string, cid: string) => Promise<unknown>;

export interface AcquireArtifactArgs {
  sha256: string;
  artifactType: string;
  access: { endpoint: string; priceUsdc: string };
  store: CorpusStorePort;
  selfSafeAddress: string;
  privateKey: string;
  routeResolver?: RouteResolver;
  envelopeCid?: string;
  sources?: ArtifactSource[];
  ipfsGatewayUrl?: string;
  /** Safe address that produced this artifact, when known (from envelope.participant). */
  ownerSafe?: string;
  acquireFn?: AcquireFn;
  fetchFromIpfs?: FetchFromIpfsFn;
}

/**
 * Adapt a legacy `AcquireFn` to the primitive's clean seam. The legacy shape —
 * a third `privateKey` parameter and a `Buffer | null` return — exists for
 * older test fakes and stays confined to this file.
 */
function toAcquireResultFn(
  acquireFn: AcquireFn,
  privateKey: string,
): (endpoint: string, sha256: string) => Promise<AcquireResult> {
  return async (endpoint, sha256) => {
    const raw = await acquireFn(endpoint, sha256, privateKey);
    if (raw === null) return { ok: false, reason: 'not_found', message: 'origin returned null (404 / not found)' };
    if (Buffer.isBuffer(raw)) return { ok: true, content: raw };
    return raw;
  };
}

export async function acquireArtifactContent(args: AcquireArtifactArgs): Promise<ArtifactContent> {
  const {
    sha256,
    artifactType,
    access,
    store,
    selfSafeAddress,
    privateKey,
    routeResolver,
    envelopeCid,
    sources = [],
    ipfsGatewayUrl,
    ownerSafe,
    acquireFn = (endpoint, sha256) => fetchArtifactContent(endpoint, sha256),
    fetchFromIpfs,
  } = args;

  const now = () => new Date().toISOString();

  // 1. Cache hit. network_artifacts is a cache, not authoritative local state:
  // a row that does not hash to its own key is a MISS, and every leg below
  // re-saves through INSERT OR REPLACE, so falling through repairs it. (The
  // self-store path at step 3 throws instead, and rightly — there is no
  // upstream to re-fetch a corrupt served_artifacts row from.)
  const cached = store.getNetworkArtifact(sha256);
  if (cached) {
    // Verified before the usage bump: a row we are about to discard must not
    // have its last_used_at refreshed.
    const verifiedCache = verifyArtifactDigest(sha256, cached.content);
    if (verifiedCache.ok) {
      store.touchNetworkArtifactUsage(sha256, now());
      return {
        sha256,
        bytes: cached.content,
        artifactType: cached.artifactType,
        source: 'cache',
        paidAmountUsdc: '0',
        fetchedAt: cached.fetchedAt,
        sourceOperator: cached.sourceOperator ?? undefined,
      };
    }
    console.warn(
      `[corpus-read] cached artifact ${sha256} hashed to ${verifiedCache.actualSha256}; `
        + 'treating the row as a miss and re-fetching',
    );
  }

  // 2. Public IPFS donation source. The primitive owns the fetch, the decode,
  // the verification, and the #3441 fall-through warning; the cache write and
  // the mismatch-is-fatal decision stay here, where the store lives.
  const ipfsSource = sources.find((source) => source.kind === 'ipfs');
  if (ipfsSource && ipfsGatewayUrl) {
    const retrieved = await fetchVerifiedArtifact(
      { sha256, artifactType },
      { sources, ipfsGatewayUrl, ownerSafe, envelopeCid },
      { deps: { fetchFromIpfs } },
    );
    if (retrieved.ok) {
      const bytes = retrieved.artifact.bytes;
      const ts = now();
      store.saveNetworkArtifact({
        sha256,
        artifactType,
        envelopeCid: envelopeCid ?? null,
        content: bytes,
        source: 'origin',
        sourceOperator: ownerSafe ?? null,
        sourceEndpoint: `ipfs://${ipfsSource.cid}`,
        paidAmountUsdc: '0',
        fetchedAt: ts,
      });
      return {
        sha256,
        bytes,
        artifactType,
        source: 'ipfs',
        paidAmountUsdc: '0',
        fetchedAt: ts,
        sourceOperator: ownerSafe,
      };
    }
    if (retrieved.reason === 'digest_mismatch') {
      throw new HashMismatchError(sha256, retrieved.mismatch.actualSha256, 'ipfs', ownerSafe);
    }
    // Donated IPFS is an opportunistic fast path: gateway failures and
    // malformed donation payloads fall through to the next source. Anything
    // that was not proven absence has already reached the operator as a
    // warning from inside the primitive (#3441).
  }

  // 3. Self-store fast path
  if (ownerSafe && ownerSafe.toLowerCase() === selfSafeAddress.toLowerCase()) {
    const own = store.getServedArtifact(sha256);
    if (own) {
      // Re-verify before mirroring. If served_artifacts has been corrupted
      // (disk error, manual edit, future migration bug, etc.) we must NOT
      // propagate the bad bytes into network_artifacts where peers can
      // fetch them. Throwing closes the cache-poisoning gap; the self-store
      // path is now hash-equivalent to origin / route-resolver.
      const verified = verifyArtifactDigest(sha256, own.content);
      if (!verified.ok) {
        throw new HashMismatchError(sha256, verified.actualSha256, 'self-store', selfSafeAddress);
      }
      // Mirror into cache so peer asks for the same content can hit cache (provenance: self-store-mirror).
      const ts = now();
      store.saveNetworkArtifact({
        sha256,
        artifactType: own.artifactType,
        envelopeCid: own.envelopeCid,
        content: own.content,
        source: 'self-store-mirror',
        paidAmountUsdc: '0',
        fetchedAt: ts,
      });
      return {
        sha256,
        bytes: own.content,
        artifactType: own.artifactType,
        source: 'self-store',
        paidAmountUsdc: '0',
        fetchedAt: ts,
      };
    }
  }

  // 4. Route resolver
  if (routeResolver) {
    try {
      const out = await routeResolver.resolve({ sha256, access, requesterSafe: selfSafeAddress });
      if (out) {
        const verified = verifyArtifactDigest(sha256, out.bytes);
        if (!verified.ok) {
          throw new HashMismatchError(sha256, verified.actualSha256, 'route-resolver', out.sourceOperator);
        }
        const ts = now();
        store.saveNetworkArtifact({
          sha256,
          artifactType,
          envelopeCid: envelopeCid ?? null,
          content: out.bytes,
          source: 'route-resolver',
          sourceOperator: out.sourceOperator ?? null,
          paidAmountUsdc: out.pricePaidUsdc,
          fetchedAt: ts,
        });
        return {
          sha256,
          bytes: out.bytes,
          artifactType,
          source: 'route-resolver',
          paidAmountUsdc: out.pricePaidUsdc,
          fetchedAt: ts,
          sourceOperator: out.sourceOperator,
        };
      }
    } catch (err) {
      if (err instanceof HashMismatchError) throw err;
      throw new AcquireError(sha256, 'routeResolver failed', err);
    }
  }

  // 5. Origin fetch
  const retrieved = await fetchVerifiedArtifact(
    { sha256, artifactType },
    { endpoint: access.endpoint, ownerSafe, envelopeCid },
    { deps: { fetchArtifact: toAcquireResultFn(acquireFn, privateKey) } },
  );
  if (!retrieved.ok) {
    if (retrieved.reason === 'digest_mismatch') {
      throw new HashMismatchError(sha256, retrieved.mismatch.actualSha256, 'origin', ownerSafe);
    }
    // Preserve the reason token in the message so callers and the daemon route
    // can surface which failure this was.
    const attempt = retrieved.attempts.find((entry) => entry.leg === 'origin');
    throw new AcquireError(
      sha256,
      `origin fetch failed: ${retrieved.reason}${attempt?.message ? ` (${attempt.message})` : ''}`,
      retrieved,
    );
  }
  const bytes = retrieved.artifact.bytes;
  const ts = now();
  store.saveNetworkArtifact({
    sha256,
    artifactType,
    envelopeCid: envelopeCid ?? null,
    content: bytes,
    source: 'origin',
    sourceOperator: ownerSafe ?? null,
    sourceEndpoint: access.endpoint,
    paidAmountUsdc: access.priceUsdc,
    fetchedAt: ts,
  });
  return {
    sha256,
    bytes,
    artifactType,
    source: 'origin',
    paidAmountUsdc: access.priceUsdc,
    fetchedAt: ts,
    sourceOperator: ownerSafe,
  };
}
