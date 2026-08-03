// Injected ports (design §7): everything `serve` needs from the outside
// world -- blob storage, clock reads, signing, and ping delivery. No
// ambient fs/network in this package (plan Global Constraints, guard-
// enforced).

/** Writes bytes at a serving-plane path (records-by-digest, archive pages, head). */
export interface BlobStore {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** Exact bytes and media type read back from a serving-plane path. */
export interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Readable store used by the durable source writer.
 *
 * `putImmutable` is an atomic create-or-confirm operation: it succeeds when
 * the path is absent or already contains the exact same bytes and content
 * type, and rejects a different value at the same path. `put` remains the
 * atomic mutable write used only for the source head.
 */
export interface ReadableImmutableBlobStore extends BlobStore {
  get(path: string): Promise<StoredBlob | undefined>;
  putImmutable(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/** Produces DSSE signatures over a pre-auth-encoded payload (§5.5). */
export interface DsseSigner {
  sign(pae: Uint8Array): Promise<{ keyid?: string; sig: Uint8Array }[]>;
}

/** Optional unauthenticated "head moved" hint transport (§7.4). */
export interface PingTransport {
  announce(headUrl: string): Promise<void>;
}
