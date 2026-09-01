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
 *
 * One deliberate difference from `fetch`: there is no transparent content
 * decoding. We send no `Accept-Encoding`, so a compliant origin answers with
 * identity bytes — and the bytes the byte cap counts are then exactly the
 * bytes the caller hashes. An origin that compresses anyway delivers bytes
 * that fail the SHA-256 check, which is the safe direction: nothing
 * unverified is ever admitted.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isIPv4, isIPv6 } from 'node:net';
import type { LookupAddress } from 'node:dns';

/** Statuses the `Response` constructor refuses to pair with a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PinnedFetchInit {
  /**
   * Addresses the socket may connect to, in preference order. Every one has
   * already passed the destination policy, so Node is free to fail over
   * between them. Omit to use ordinary DNS.
   */
  readonly pinnedAddresses?: readonly PinnedAddress[];
  readonly signal?: AbortSignal;
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
    // `undefined` means "no pin requested"; an empty list means "pin requested,
    // nothing permitted". Letting the latter fall through to ordinary DNS would
    // turn an empty allowlist into no restriction at all — the wrong default
    // for a security primitive, and invisible at the call site.
    if (init.pinnedAddresses !== undefined && init.pinnedAddresses.length === 0) {
      reject(new Error('pinnedAddresses must not be empty; omit it to use ordinary DNS'));
      return;
    }
    for (const entry of init.pinnedAddresses ?? []) {
      const matches = entry.family === 4 ? isIPv4(entry.address) : isIPv6(entry.address);
      if (!matches) {
        reject(new Error(
          `pinned address ${entry.address} is not a numeric IPv${entry.family} address`));
        return;
      }
    }

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const pinned = init.pinnedAddresses;
    const outgoing = send(url, {
      method: 'GET',
      // A pooled keep-alive socket is keyed on host:port and ignores `lookup`,
      // so a reused connection would skip the pin entirely. Opting out of the
      // shared agent keeps "we connect to the address we validated" literally
      // true, at the cost of a handshake per artifact fetch.
      ...(pinned === undefined ? {} : { agent: false as const }),
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
          if (options?.all === true) callback(null, pinned.map((entry) => ({ ...entry })));
          else callback(null, pinned[0].address, pinned[0].family);
        },
      }),
    }, (incoming) => {
      // Everything here runs inside http.request's response callback, where a
      // throw is an UNCAUGHT EXCEPTION — no promise rejection, nothing the
      // caller's try/catch can see, process dead. The response is
      // attacker-shaped, so the whole callback is guarded and every failure
      // is converted into a rejection this function's caller can handle.
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        // Node's parser accepts any status up to 999, but `Response` throws
        // outside 200-599. Check it explicitly rather than leaning on the
        // catch below, so a hostile `HTTP/1.1 999 Nope` reads as a bad
        // response instead of an internal error.
        const status = incoming.statusCode ?? 502;
        if (status < 200 || status > 599) {
          incoming.resume();
          reject(new Error(`origin returned an out-of-range HTTP status ${status}`));
          return;
        }
        const bodyless = NULL_BODY_STATUSES.has(status);
        if (bodyless) incoming.resume();
        resolve(new Response(
          bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
          { status, headers },
        ));
      } catch (err) {
        incoming.resume();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    outgoing.on('error', reject);
    if (init.signal) {
      const abort = () => { outgoing.destroy(new Error('aborted')); };
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    }
    outgoing.end();
  });
