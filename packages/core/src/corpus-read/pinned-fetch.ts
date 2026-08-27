/**
 * A `fetch`-shaped transport that connects to a caller-chosen address (#1901).
 *
 * `globalThis.fetch` resolves the hostname itself, at connect time, with no
 * hook to constrain the result. That is fatal for a destination policy: an
 * attacker who controls the name's DNS can answer a public address to the
 * policy's lookup and a private one to the socket's. Validating the name and
 * then handing the name to `fetch` checks one thing and connects to another.
 *
 * So the production path uses `node:http`/`node:https` with the `lookup`
 * option pinned to the address `origin-guard` already approved. The URL keeps
 * its hostname, so TLS still does SNI and certificate validation against the
 * real name; only address selection is taken away from the resolver.
 *
 * The result is adapted back to a web `Response` so callers — and the tests
 * that inject a plain `fetch` fake — see one shape either way. The body is
 * exposed as a stream, never buffered here, so the caller's byte cap still
 * governs.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { LookupAddress } from 'node:dns';

export interface PinnedFetchInit {
  /** Numeric address the socket must connect to. Omit to use ordinary DNS. */
  readonly pinnedAddress?: string;
  readonly pinnedFamily?: 4 | 6;
  readonly signal?: AbortSignal;
  /** Always `'manual'` here — redirects are the caller's to revalidate. */
  readonly redirect?: 'manual' | 'follow' | 'error';
}

export type PinnedFetch = (url: URL, init?: PinnedFetchInit) => Promise<Response>;

/** Perform one GET, pinned to `init.pinnedAddress` when supplied. */
export const pinnedFetch: PinnedFetch = (url, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error(`pinnedFetch supports http(s) only, got ${url.protocol}`));
      return;
    }
    if (init.signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const pinned = init.pinnedAddress;
    const outgoing = send(url, {
      method: 'GET',
      // Redirects are never followed here; the caller revalidates each hop.
      ...(pinned === undefined ? {} : {
        // Node calls `lookup` with `{ all: true }` from some connect paths
        // and expects the array shape back there; answering the wrong shape
        // throws "Invalid IP address: undefined".
        lookup: (
          _hostname: string,
          options: { all?: boolean } | undefined,
          callback: (
            err: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
            family?: number,
          ) => void,
        ) => {
          const family = init.pinnedFamily ?? 4;
          if (options?.all === true) callback(null, [{ address: pinned, family }]);
          else callback(null, pinned, family);
        },
      }),
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const status = incoming.statusCode ?? 502;
      // 204/304 and the 1xx range must not carry a body per the Response
      // constructor; everything else streams through untouched.
      const bodyless = status === 204 || status === 304 || status < 200;
      if (bodyless) incoming.resume();
      resolve(new Response(
        bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
        { status, headers },
      ));
    });

    outgoing.on('error', reject);
    if (init.signal) {
      const abort = () => { outgoing.destroy(new Error('aborted')); };
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    }
    outgoing.end();
  });
