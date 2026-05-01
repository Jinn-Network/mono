/**
 * Per-artifact resolution chain: cache → self-store → routeResolver → origin.
 *
 * Always hash-verifies before persisting to cache.
 *
 * Spec §2.3 step 4-6.
 */

import { createHash } from 'node:crypto';
import type { Store } from '../store/store.js';
import { acquireArtifactWithPayment } from '../x402/acquire.js';
import type { ArtifactContent, RouteResolver } from './types.js';
import { AcquireError, HashMismatchError } from './types.js';

type AcquireFn = (endpoint: string, sha256: string, privateKey: string) => Promise<Buffer | null>;

export interface AcquireArtifactArgs {
  sha256: string;
  artifactType: string;
  access: { endpoint: string; priceUsdc: string };
  store: Store;
  selfSafeAddress: string;
  privateKey: string;
  routeResolver?: RouteResolver;
  envelopeCid?: string;
  /** Safe address that produced this artifact, when known (from envelope.participant). */
  ownerSafe?: string;
  acquireFn?: AcquireFn;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
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
    ownerSafe,
    acquireFn = acquireArtifactWithPayment,
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

  // 2. Self-store fast path
  if (ownerSafe && ownerSafe.toLowerCase() === selfSafeAddress.toLowerCase()) {
    const own = store.getServedArtifact(sha256);
    if (own) {
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

  // 3. Route resolver
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

  // 4. Origin fetch
  let bytes: Buffer | null;
  try {
    bytes = await acquireFn(access.endpoint, sha256, privateKey);
  } catch (err) {
    throw new AcquireError(sha256, 'origin fetch failed', err);
  }
  if (!bytes) {
    throw new AcquireError(sha256, 'origin returned null (404 / payment failed)');
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
