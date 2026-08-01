// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { fromDigestSet, type ResourceDescriptor } from "./digests.js";
import type { ArtifactStore, ResolvedResource } from "./ports.js";

export interface ResolutionRequest {
  readonly name: string;
  readonly descriptor: ResourceDescriptor;
}

export type ResolutionResult =
  | {
    readonly ok: true;
    readonly resolved: readonly ResolvedResource[];
    readonly bytes: ReadonlyMap<string, Uint8Array>;
  }
  | {
    readonly ok: false;
    readonly reason: "resource-unresolvable" | "resource-digest-mismatch";
    readonly detail: string;
    readonly resolved: readonly ResolvedResource[];
    readonly bytes: ReadonlyMap<string, Uint8Array>;
  };

/**
 * Design §5.1 step 1. Every resource -- record, runtime image, binary, state artifact,
 * fixtures, probe suite, comparator -- is resolved by digest and re-digested before use, and
 * the resolution log is what step 9 checks the instance's loaded set against. The store is
 * injected, so "no network retrieval" is a property of the call graph and not of a promise.
 */
export async function resolveMaterials(
  store: ArtifactStore,
  requests: readonly ResolutionRequest[],
  signal?: AbortSignal,
): Promise<ResolutionResult> {
  const resolved: ResolvedResource[] = [];
  const bytes = new Map<string, Uint8Array>();

  for (const request of requests) {
    const expected = fromDigestSet(request.descriptor.digest);
    let payload: Uint8Array;
    try {
      payload = await store.getArtifact(
        request.descriptor,
        signal === undefined ? undefined : { signal },
      );
    } catch (cause) {
      return {
        ok: false,
        reason: "resource-unresolvable",
        detail: `${request.name} (${expected}): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        resolved,
        bytes,
      };
    }
    const actual = recordDigest(payload);
    if (actual !== expected) {
      return {
        ok: false,
        reason: "resource-digest-mismatch",
        detail: `${request.name} resolved to ${actual}, not ${expected}`,
        resolved,
        bytes,
      };
    }
    resolved.push({
      name: request.name,
      descriptor: request.descriptor,
      digest: actual,
      size: payload.length,
    });
    bytes.set(actual, payload);
  }

  return { ok: true, resolved, bytes };
}

/** RFC 8785 bytes of the resolution log, sorted by digest so the log's identity does not
 * depend on the order the verifier happened to resolve in. */
export function canonicalResolutionLogBytes(
  resolved: readonly ResolvedResource[],
): Uint8Array {
  const entries = [...resolved]
    .map((entry) => ({ name: entry.name, digest: entry.digest, size: entry.size }))
    .sort((left, right) => compareCodeUnitStrings(left.digest, right.digest));
  return canonicalJsonBytes({ entries });
}

export function resolutionLogDigest(resolved: readonly ResolvedResource[]): Sha256Digest {
  return recordDigest(canonicalResolutionLogBytes(resolved));
}
