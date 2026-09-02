/**
 * Per-artifact resolution chain: cache → self-store → routeResolver → origin.
 *
 * Always hash-verifies before persisting to cache.
 *
 * Spec §2.3 step 4-6.
 */

import { createHash } from 'node:crypto';
import { fetchArtifactContent, type AcquireResult } from './fetch-artifact.js';
import type {
  ArtifactContent,
  ArtifactSource,
  CorpusStorePort,
  RouteResolver,
} from './types.js';
import { AcquireError, HashMismatchError } from './types.js';
import { classifyIpfsFetchFailure, fetchFromIpfs as defaultFetchFromIpfs } from './ipfs.js';

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

const DONATION_ARTIFACT_ENCODING = 'jinn.artifact.donation.v1';

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

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Log an IPFS read that the acquisition chain is about to fall through, unless
 * the gateway actually answered "not there" (#3441). A cap refusal is positive
 * evidence the content exists, so it must not read like an ordinary miss.
 */
function warnIpfsFallThrough(subject: string, error: unknown): void {
  const classification = classifyIpfsFetchFailure(error);
  if (classification === 'not-found') return;
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(
    `[corpus-read] IPFS source for ${subject} was refused (${classification}), `
      + `falling through to the next source: ${detail}`,
  );
}

function decodeDonationArtifact(raw: unknown, expectedSha256: string): Buffer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('donation artifact payload is not an object');
  }
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== DONATION_ARTIFACT_ENCODING || record['encoding'] !== DONATION_ARTIFACT_ENCODING) {
    throw new Error('donation artifact payload has unexpected encoding');
  }
  if (record['sha256'] !== expectedSha256) {
    throw new Error('donation artifact sha256 does not match requested artifact');
  }
  if (typeof record['data'] !== 'string') {
    throw new Error('donation artifact payload is missing base64 data');
  }
  return Buffer.from(record['data'], 'base64');
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
    fetchFromIpfs = defaultFetchFromIpfs,
  } = args;

  const now = () => new Date().toISOString();

  // 1. Cache hit
  const cached = store.getNetworkArtifact(sha256);
  if (cached) {
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

  // 2. Public IPFS donation source.
  const ipfsSource = sources.find((source) => source.kind === 'ipfs');
  if (ipfsSource && ipfsGatewayUrl) {
    try {
      const raw = await fetchFromIpfs(ipfsGatewayUrl, ipfsSource.cid);
      const bytes = decodeDonationArtifact(raw, sha256);
      const actualSha = sha256Hex(bytes);
      if (actualSha !== sha256) {
        throw new HashMismatchError(sha256, actualSha, 'ipfs', ownerSafe);
      }
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
    } catch (err) {
      if (err instanceof HashMismatchError) throw err;
      // Donated IPFS is an opportunistic fast path. Gateway failures and
      // malformed donation payloads should not block the acquisition chain;
      // only verified byte hash mismatches remain fatal.
      //
      // Swallowing the failure silently, though, turns a size-policy refusal or
      // a blocked redirect into an invisible data gap (#3441). Classify before
      // swallowing so anything that is not proven absence reaches the operator.
      warnIpfsFallThrough(`donation artifact ${sha256}`, err);
    }
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
      const actualSha = sha256Hex(own.content);
      if (actualSha !== sha256) {
        throw new HashMismatchError(sha256, actualSha, 'self-store', selfSafeAddress);
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
        const actualSha = sha256Hex(out.bytes);
        if (actualSha !== sha256) {
          throw new HashMismatchError(sha256, actualSha, 'route-resolver', out.sourceOperator);
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
  let bytes: Buffer | null;
  try {
    const raw = await acquireFn(access.endpoint, sha256, privateKey);
    // Accept both the legacy `Buffer | null` shape and the discriminated
    // union from fetchArtifactContent. Buffer.isBuffer guards before we
    // duck-type into the union.
    if (raw === null || Buffer.isBuffer(raw)) {
      bytes = raw;
    } else if (raw.ok === true) {
      bytes = raw.content;
    } else {
      // ok: false — preserve the reason so the caller / daemon route can
      // surface it via AcquireError.cause.
      throw new AcquireError(
        sha256,
        `origin fetch failed: ${raw.reason}${raw.message ? ` (${raw.message})` : ''}`,
        raw,
      );
    }
  } catch (err) {
    if (err instanceof AcquireError) throw err;
    throw new AcquireError(sha256, 'origin fetch failed', err);
  }
  if (!bytes) {
    throw new AcquireError(sha256, 'origin returned null (404 / not found)');
  }
  const actualSha = sha256Hex(bytes);
  if (actualSha !== sha256) {
    throw new HashMismatchError(sha256, actualSha, 'origin', ownerSafe);
  }
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
