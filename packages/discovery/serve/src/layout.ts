import { recordDigest, recordPath } from "@jinn-network/record-discovery-protocol";

import type { BlobStore } from "./ports.js";

// Records-by-digest (design §7 item 1): exact sealed bytes at a
// digest-derived path -- immutable, infinitely cacheable, mirror-safe by
// construction (consumers re-hash everything they retrieve). Announcement
// entries live in the same store; they are sealed records too.

/**
 * Writes `bytes` at its digest-derived path. Idempotent: writing the same
 * bytes twice yields the same `{digest, path}` (one digest, one path).
 * `contentType` defaults to an opaque octet stream since `serve` does not
 * know a given record's own kind-specific media type at this layer.
 */
export async function writeRecord(
  store: BlobStore,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): Promise<{ digest: `sha256:${string}`; path: string }> {
  const digest = recordDigest(bytes);
  const path = recordPath(digest);
  await store.put(path, bytes, contentType);
  return { digest, path };
}
