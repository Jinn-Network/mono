/**
 * Corpus cache helpers.
 *
 * The corpus library reuses the existing `network_artifacts` and `served_artifacts`
 * tables on the daemon's `Store`. There is no separate corpus cache layer — the
 * acquire chain in `acquire.ts` is the only writer/reader. This module exposes
 * thin convenience helpers for higher-level code that wants to inspect or
 * pre-populate the cache without going through `acquireArtifactContent`.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §2.4 (caching semantics).
 */

import type { CorpusStorePort, NetworkArtifactRow } from './types.js';

export function getCachedArtifact(
  store: CorpusStorePort,
  sha256: string,
): NetworkArtifactRow | null {
  return store.getNetworkArtifact(sha256);
}

export function hasCachedArtifact(store: CorpusStorePort, sha256: string): boolean {
  return store.getNetworkArtifact(sha256) !== null;
}
