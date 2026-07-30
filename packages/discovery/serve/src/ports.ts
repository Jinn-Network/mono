// Injected ports (design §7): everything `serve` needs from the outside
// world -- blob storage, clock reads, signing, and ping delivery. No
// ambient fs/network in this package (plan Global Constraints, guard-
// enforced).

/** Writes bytes at a serving-plane path (records-by-digest, archive pages, head). */
export interface BlobStore {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
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
