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
      const response = await fetchLike(target, { method: "GET", headers });

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
