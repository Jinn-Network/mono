/**
 * Sealed-store method ports (BP-13 deliverable 1): adapts this workspace's digest-addressed
 * sealed-record store (`../workspace/sealed-store.ts`) to `@jinn-network/benchmarking-aggregate`'s
 * `MethodPorts` — the resolver bundle `produceReport`/`verifyReport` and the method registry's own
 * `compute` functions call to resolve a referenced Verdict, Run, or Task record's exact bytes by
 * digest.
 *
 * The aggregate package's own `resolved-inputs.ts` (`requireResolvedBytes`) already turns a
 * resolver returning `undefined` into its own typed `MethodInputError` — these ports never throw
 * for a missing digest, only return `undefined`, so the aggregate boundary's own fail-closed
 * handling is the single place that failure is diagnosed.
 */

import { BENCHMARKING_METHOD_REGISTRY } from "@jinn-network/benchmarking-aggregate";
import type { MethodPorts } from "@jinn-network/benchmarking-aggregate";
import { getSealedBytes, hasSealedBytes } from "../workspace/sealed-store.js";

const SHA256_PREFIX = "sha256:";

function stripSha256Prefix(digest: string): string {
  return digest.startsWith(SHA256_PREFIX) ? digest.slice(SHA256_PREFIX.length) : digest;
}

function resolveSealedBytes(workspaceDir: string, digest: string): Uint8Array | undefined {
  const sha256 = stripSha256Prefix(digest);
  return hasSealedBytes(workspaceDir, sha256) ? getSealedBytes(workspaceDir, sha256) : undefined;
}

/** Builds the aggregate `MethodPorts` bundle for `workspaceDir`: the shared §9.2 method registry
 * plus three digest resolvers over this workspace's sealed-record store. */
export function buildMethodPorts(workspaceDir: string): MethodPorts {
  return buildMethodPortsFromResolver((digest) => resolveSealedBytes(workspaceDir, digest));
}

/** Shared report recomputation seam for workspace and portable-bundle verification. */
export function buildMethodPortsFromResolver(
  resolveBytes: (digest: string) => Uint8Array | undefined,
): MethodPorts {
  return {
    registry: BENCHMARKING_METHOD_REGISTRY,
    resolveVerdictBytes: resolveBytes,
    resolveRunBytes: resolveBytes,
    resolveTaskBytes: resolveBytes,
    resolveRecordBytes: resolveBytes,
  };
}
