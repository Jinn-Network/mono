import type { ReadableImmutableBlobStore } from "@jinn-network/record-discovery-serve";

// Injected ports for the HTTP adapter tree. `serve` declares the WRITE
// side of blob storage (`BlobStore.put`) because writing the static
// layout is all a source producer does; serving that layout back needs a
// read side, which is declared here rather than in `serve` (design §7
// pins the layout's properties, not a read interface, and `serve` must
// stay free of any serving-side concern).

/** Reads bytes previously written at a serving-plane path. */
export interface BlobReader {
  get(path: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined>;
}

/** A blob store that both writes (serve's port) and reads (this package's handler). */
export type ReadWriteBlobStore = ReadableImmutableBlobStore & BlobReader;

/**
 * The subset of the Node 22 global `fetch` this package uses, declared as
 * a port so tests can inject a loopback function and so no module has to
 * reach for the global except the three allowlisted transport modules.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;
