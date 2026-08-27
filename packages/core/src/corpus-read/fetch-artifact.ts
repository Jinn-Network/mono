/**
 * Free artifact fetch — pulls remote artifact bytes over plain HTTP.
 *
 * Knowledge is a free, opt-in public good (tokenless-OLAS pivot): artifact
 * acquisition is an unauthenticated GET, no payment wrapper. The server
 * returns raw bytes; the consumer hashes them locally to verify integrity
 * against the envelope's `artifact.sha256` field.
 *
 * Keys artifacts by sha256 (not IPFS CID) — artifacts no longer have IPFS
 * CIDs (post jinn-mono-vy37.1.2).
 *
 * The endpoint is manifest-supplied and therefore attacker-controlled (#1901),
 * so this fetch is both destination-restricted and resource-bounded *before*
 * the hash check in `acquire.ts` ever runs:
 *
 * - every destination — the origin and each redirect hop — must pass
 *   `resolvePublicHttpDestination` (see `origin-guard.ts`), and the socket is
 *   pinned to the exact address that check approved, so a name whose DNS
 *   answer flips between validation and connect cannot escape the policy;
 * - redirects are followed manually and capped;
 * - one deadline bounds the whole chain, including the body read, so a
 *   stalled peer cannot hold a worker;
 * - the body is streamed through a byte counter and abandoned the moment it
 *   exceeds the cap, so an oversized response is never fully buffered.
 */

import {
  resolvePublicHttpDestination,
  ProhibitedDestinationError,
  type HostnameResolver,
} from './origin-guard.js';
import { pinnedFetch, type PinnedFetch } from './pinned-fetch.js';

export type AcquireResult =
  | { ok: true; content: Buffer }
  | {
      ok: false;
      /**
       * `blocked` — destination policy refused the origin or a redirect hop.
       * `too_large` — the response exceeded the byte cap.
       * `timeout` — the response stalled past the deadline.
       */
      reason: 'not_found' | 'network_error' | 'blocked' | 'too_large' | 'timeout';
      message?: string;
    };

/** 32 MiB. Artifacts are solution/evidence payloads, not disk images. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchArtifactOptions {
  /**
   * Injection seam for tests. The default connects over `node:http(s)` with
   * the socket pinned to the guard-approved address; a plain `fetch` fake is
   * accepted here but does not pin, so production must not supply one.
   */
  fetchImpl?: PinnedFetch;
  /** Injection seam for tests; defaults to `dns.lookup(..., { all: true })`. */
  resolveHostname?: HostnameResolver;
  /**
   * Permit loopback/private destinations, and skip address pinning with them.
   * Off by default and set nowhere in-repo; it exists for an operator running
   * against a local origin, because `operator.publicEndpoint` falls back to
   * `http://localhost:<apiPort>` when unset. Scheme and credential checks
   * still apply. Env: `JINN_CORPUS_ALLOW_PRIVATE_ORIGINS`.
   */
  allowPrivateDestinations?: boolean;
  /** Byte cap. Env: `JINN_CORPUS_ARTIFACT_MAX_BYTES`. */
  maxBytes?: number;
  /** Whole-operation deadline in ms; `0` disables. Env: `JINN_CORPUS_ARTIFACT_FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Redirect hop cap. Env: `JINN_CORPUS_ARTIFACT_MAX_REDIRECTS`. */
  maxRedirects?: number;
}

class TimeoutError extends Error {}
class TooLargeError extends Error {}

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function buildArtifactUrl(endpoint: string, sha256: string): string {
  return `${endpoint.replace(/\/$/, '')}/v1/artifacts/${sha256}/content`;
}

/** Stream `response` into a Buffer, abandoning it the moment it exceeds `maxBytes`. */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new TooLargeError(`content-length ${declared} exceeds the ${maxBytes}-byte cap`);
  }
  // A null body carries no bytes. We deliberately do not fall back to
  // `arrayBuffer()` here: that materializes the whole response before any
  // size check, which is the exact behavior the byte cap exists to prevent.
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new TooLargeError(`response exceeds the ${maxBytes}-byte cap`);
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks, total);
}

export async function fetchArtifactContent(
  endpoint: string,
  sha256: string,
  options: FetchArtifactOptions = {},
): Promise<AcquireResult> {
  const fetchImpl = options.fetchImpl ?? pinnedFetch;
  const maxBytes = options.maxBytes ?? envInteger('JINN_CORPUS_ARTIFACT_MAX_BYTES', DEFAULT_MAX_BYTES);
  const timeoutMs = options.timeoutMs
    ?? envInteger('JINN_CORPUS_ARTIFACT_FETCH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const maxRedirects = options.maxRedirects
    ?? envInteger('JINN_CORPUS_ARTIFACT_MAX_REDIRECTS', DEFAULT_MAX_REDIRECTS);
  const guard = {
    resolveHostname: options.resolveHostname,
    allowPrivateDestinations:
      options.allowPrivateDestinations ?? envFlag('JINN_CORPUS_ALLOW_PRIVATE_ORIGINS'),
  };

  const raw = buildArtifactUrl(endpoint, sha256);
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { ok: false, reason: 'blocked', message: `artifact endpoint is not a valid URL: ${raw}` };
  }

  // One controller and one timer bound the whole chain — connect, every
  // redirect hop, and the body read. The timeout both aborts the transport
  // and loses the race, so a transport that ignores the signal still cannot
  // leave the caller waiting past the deadline.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = timeoutMs > 0
    ? new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(`artifact fetch timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    : undefined;
  // Attach a sink so the rejection is never unhandled — under Node's default
  // `--unhandled-rejections=throw`, a timer firing before the first `bounded()`
  // call would otherwise kill the process outright.
  expiry?.catch(() => {});

  const bounded = <T>(work: Promise<T>): Promise<T> =>
    expiry === undefined ? work : Promise.race([work, expiry]);

  const chain = async (): Promise<AcquireResult> => {
    for (let hop = 0; ; hop += 1) {
      // Bounded like every other await: the guard resolves DNS for an
      // attacker-supplied name, so a nameserver that simply never answers
      // must not be able to hold the caller past the deadline.
      const pin = await bounded(resolvePublicHttpDestination(target, guard));

      const response = await bounded(fetchImpl(target, {
        redirect: 'manual',
        signal: controller.signal,
        ...(pin === null ? {} : { pinnedAddresses: pin.addresses }),
      }));

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (location === null) {
          return {
            ok: false,
            reason: 'network_error',
            message: `HTTP ${response.status} without a Location header for ${target.href}`,
          };
        }
        if (hop >= maxRedirects) {
          await response.body?.cancel().catch(() => {});
          return {
            ok: false,
            reason: 'blocked',
            message: `artifact fetch exceeded ${maxRedirects} redirects at ${target.href}`,
          };
        }
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          return {
            ok: false,
            reason: 'blocked',
            message: `redirect Location is not a valid URL: ${location}`,
          };
        }
        await response.body?.cancel().catch(() => {});
        target = next;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404) {
          return { ok: false, reason: 'not_found', message: `HTTP 404 for ${target.href}` };
        }
        return {
          ok: false,
          reason: 'network_error',
          message: `HTTP ${response.status} for ${target.href}`,
        };
      }

      return { ok: true, content: await bounded(readBounded(response, maxBytes)) };
    }
  };

  try {
    return await chain();
  } catch (err) {
    if (err instanceof ProhibitedDestinationError) {
      return { ok: false, reason: 'blocked', message: err.message };
    }
    if (err instanceof TimeoutError) {
      return { ok: false, reason: 'timeout', message: err.message };
    }
    if (err instanceof TooLargeError) {
      return { ok: false, reason: 'too_large', message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'network_error', message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
