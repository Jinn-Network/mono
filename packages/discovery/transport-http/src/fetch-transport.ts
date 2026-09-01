import type { Transport, TransportResponse } from "@jinn-network/record-discovery-client";

import type { FetchLike } from "./ports.js";

// The client-side `Transport` plug (spec §6.2). One of the three modules
// the discovery source-boundaries guard allows to name an ambient
// network API (Finding F1).
//
// The primitive is Node 22's global fetch -- undici, stable since Node
// 18, no dependency, no polyfill -- injectable as `fetchLike` so tests
// and hosts can supply a loopback. Conditional requests are §7.3's
// ETag / If-None-Match profile made automatic: the transport remembers
// each URL's entity tag, revalidates on the next request, and on 304
// returns the cached bytes under status 200 so every existing `client`
// consumer (`fetchHead`, `coldSync`, `returningSync`) parses a body
// exactly as it does today. `stats()` exposes the revalidation count so
// a host can see the profile working.

const DEFAULT_MAX_BYTES = 8 << 20; // 8 MiB -- twice the §5.1 archive-page ceiling

export class TransportHttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number) {
    super(`GET ${url} failed with HTTP ${status}.`);
    this.name = "TransportHttpError";
    this.url = url;
    this.status = status;
  }
}

export class TransportOversizeError extends Error {
  readonly url: string;
  readonly declaredLength: number;
  readonly maxBytes: number;

  constructor(url: string, declaredLength: number, maxBytes: number) {
    super(`GET ${url} returned ${declaredLength} bytes, over the ${maxBytes}-byte ceiling.`);
    this.name = "TransportOversizeError";
    this.url = url;
    this.declaredLength = declaredLength;
    this.maxBytes = maxBytes;
  }
}

export class TransportRedirectError extends Error {
  readonly url: string;
  readonly location: string;

  constructor(url: string, location: string, detail: string) {
    super(`GET ${url} was redirected to ${location}: ${detail}`);
    this.name = "TransportRedirectError";
    this.url = url;
    this.location = location;
  }
}

export interface HttpTransportOptions {
  /** Hard ceiling on a single response body. Defaults to 8 MiB. */
  maxBytes?: number;
  /** Headers sent on every request (never includes credentials -- the archive subtree is public). */
  headers?: Record<string, string>;
}

export interface HttpTransport extends Transport {
  stats(): { requests: number; revalidations: number };
}

interface CacheEntry {
  etag: string;
  bytes: Uint8Array;
  contentType?: string;
}

function resolveUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, "")}${url.startsWith("/") ? url : `/${url}`}`;
}

/**
 * Redirect statuses this transport treats as a redirect. 304 sits in the same
 * numeric band and is emphatically NOT one -- it is the §7.3 revalidation hit
 * the caller below turns back into cached bytes.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Enough hops for a peer normalizing its own paths; far short of undici's 20. */
const MAX_REDIRECTS = 5;

/**
 * Performs the request, following only redirects that stay on the origin the
 * caller asked for.
 *
 * A destination guard that inspects the requested URL is worth nothing if the
 * server at that URL can then post a forwarding address (#3411). The serving
 * root is operator-CONFIGURED but peer-OPERATED: with the default
 * `redirect: "follow"` a peer answered a perfectly contained request with
 * `302 Location: http://127.0.0.1:8545/` and undici walked the daemon there,
 * restoring exactly the arbitrary-destination fetch the containment guard in
 * `discovery/client`'s `origin-policy` exists to remove.
 *
 * Same-origin is the invariant enforced here because it is precisely the
 * promise the guard makes: a peer may move a request only within an origin the
 * operator already chose. The path within that origin stays the peer's to
 * choose -- it always was, since the peer serves the archive.
 *
 * Note this is deliberately weaker than the resolver's test, which is origin
 * PLUS the serving root's path prefix. The transport has no serving root to
 * compare against -- the fleet daemon builds it with an empty base and shares
 * one instance across sources -- so a same-origin redirect could move the fetch
 * outside that prefix. Harmless today (a path-bearing serving root has never
 * had a working `.well-known` fetch, so the prefix is always `/`), but a
 * deployment that changes that must move the prefix test in here rather than
 * inherit the asymmetry silently.
 */
async function fetchWithinOrigin(
  fetchLike: FetchLike,
  target: string,
  headers: Record<string, string>,
): Promise<Response> {
  // Carried as a URL, not a string: every hop needs its origin, and re-parsing
  // the spelling each time invites the two forms disagreeing. Parsing here also
  // names the one input this transport cannot work with -- a relative target,
  // which `fetch` would have rejected a line later with a bare TypeError.
  let current: URL;
  try {
    current = new URL(target);
  } catch {
    throw new TypeError(
      `GET ${target} is not an absolute URL; the transport needs one to hold each redirect hop to its origin.`,
    );
  }
  for (let hop = 0; ; hop += 1) {
    // eslint-disable-next-line no-await-in-loop -- a redirect chain is sequential by definition.
    const response = await fetchLike(current.toString(), { method: "GET", headers, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    // A redirect status with no Location is malformed; hand it back so the
    // caller's ordinary non-2xx check reports it as the HTTP error it is.
    if (location === null || location.trim() === "") return response;
    if (hop >= MAX_REDIRECTS) {
      throw new TransportRedirectError(target, location, `more than ${MAX_REDIRECTS} redirects`);
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new TransportRedirectError(target, location, "the redirect target is not a resolvable URL");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new TransportRedirectError(target, location, `scheme ${next.protocol} is not HTTP(S)`);
    }
    if (next.origin !== current.origin) {
      throw new TransportRedirectError(target, location, `origin ${next.origin} is not ${current.origin}`);
    }
    current = next;
  }
}

/**
 * Reads a response body, stopping the moment it crosses `maxBytes`.
 *
 * A `Content-Length` check alone only bounds an honest source: a hostile
 * one omits the header, and buffering the whole body before measuring it
 * hands any remote an unbounded allocation in a long-lived daemon. The
 * ceiling has to hold during the read, so this cancels the stream at the
 * first chunk that crosses it rather than after the last one arrives.
 */
async function readBounded(response: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.length > maxBytes) throw new TransportOversizeError(url, whole.length, maxBytes);
    return whole;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined) {
        total += value.length;
        if (total > maxBytes) throw new TransportOversizeError(url, total, maxBytes);
        chunks.push(value);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function createHttpTransport(
  baseUrl: string,
  fetchLike: FetchLike = globalThis.fetch.bind(globalThis) as FetchLike,
  options: HttpTransportOptions = {},
): HttpTransport {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const cache = new Map<string, CacheEntry>();
  let requests = 0;
  let revalidations = 0;

  return {
    async "fetch"(url: string): Promise<TransportResponse> {
      const target = resolveUrl(baseUrl, url);
      const cached = cache.get(target);
      const headers: Record<string, string> = {
        ...(options.headers ?? {}),
        ...(cached === undefined ? {} : { "if-none-match": cached.etag }),
      };

      requests += 1;
      const response = await fetchWithinOrigin(fetchLike, target, headers);

      if (response.status === 304 && cached !== undefined) {
        revalidations += 1;
        return {
          status: 200,
          ...(cached.contentType === undefined ? {} : { contentType: cached.contentType }),
          declaredLength: cached.bytes.length,
          bytes: cached.bytes,
        };
      }

      if (response.status < 200 || response.status > 299) {
        throw new TransportHttpError(target, response.status);
      }

      const contentLength = response.headers.get("content-length");
      const declaredLength = contentLength === null ? undefined : Number(contentLength);
      if (declaredLength !== undefined && declaredLength > maxBytes) {
        throw new TransportOversizeError(target, declaredLength, maxBytes);
      }

      const bytes = await readBounded(response, target, maxBytes);

      const contentType = response.headers.get("content-type") ?? undefined;
      const etag = response.headers.get("etag");
      if (etag !== null) {
        cache.set(target, {
          etag,
          bytes,
          ...(contentType === undefined ? {} : { contentType }),
        });
      }

      return {
        status: response.status,
        ...(contentType === undefined ? {} : { contentType }),
        ...(declaredLength === undefined ? { declaredLength: bytes.length } : { declaredLength }),
        bytes,
      };
    },

    stats() {
      return { requests, revalidations };
    },
  };
}
