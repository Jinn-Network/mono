import type { SourceHead, SourceIdentity } from "@jinn-network/record-discovery-protocol";
import {
  MAX_REFRESH_BY_AHEAD_MS,
  MEDIA_HEAD,
  dssePreAuthEncoding,
  formatOrigin,
  headPath,
  parseHeadTimestamp,
  refreshByWithinCeiling,
  sealJson,
} from "@jinn-network/record-discovery-protocol";

import type { BlobStore, Clock, DsseSigner } from "./ports.js";

// Head maintenance (design §7 item 3, §5.2, §5.5). The Source Head is the
// one mutable, DSSE-signed document per source: a live source re-signs it
// before `refreshBy` expires even when nothing new was announced (an
// expired head is a withholding signal, not silence, §5.2).
//
// This module defines its own DsseEnvelope-shaped type rather than
// depending on `@jinn-network/trust-core` for it (the plan's dependency
// edge table names `serve -> protocol` only): the shape is structurally
// identical to trust-core's own `DsseEnvelope` (base64 `payload`, base64
// `sig` per signature) so a real trust-core-based verifier can consume it
// without translation, but `serve` never imports trust-core's type.

export interface DsseEnvelopeSignature {
  keyid?: string;
  sig: string;
}

export interface DsseEnvelope {
  payloadType: string;
  payload: string;
  signatures: DsseEnvelopeSignature[];
}

// The §5.2 ceiling itself lives in `protocol` (`verify/refresh-bound.ts`), so
// the two named verification procedures and this writing side compare against
// one definition rather than two. Re-exported here because it is part of
// `serve`'s published surface.
export { MAX_REFRESH_BY_AHEAD_MS };

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Signs the sealed head bytes under the head payload type (§5.5), producing a wire-shaped DSSE envelope. */
export async function signHead(head: SourceHead, signer: DsseSigner): Promise<DsseEnvelope> {
  const { bytes } = sealJson(head);
  const pae = dssePreAuthEncoding(MEDIA_HEAD, bytes);
  const signatures = await signer.sign(pae);
  return {
    payloadType: MEDIA_HEAD,
    payload: encodeBase64(bytes),
    signatures: signatures.map((signature) => ({
      ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
      sig: encodeBase64(signature.sig),
    })),
  };
}

/**
 * Produces the next head for the same source position (`sequence`/`entry`
 * unchanged): `issuedAt` strictly increases past `prev.issuedAt` regardless
 * of clock precision, and `refreshBy` never exceeds the published-source
 * profile's bound (`MAX_REFRESH_BY_AHEAD_MS`) ahead of the new `issuedAt`,
 * regardless of the requested `refreshWithinMs`.
 *
 * Throws on a `prev.issuedAt` that is not an offset-bearing RFC 3339 date-time
 * (§5.2, #3482): an offset-less one is read as host-LOCAL time, so the
 * successor's `issuedAt` -- and with it whether it is monotonic at all --
 * would depend on where the source happens to be maintained.
 *
 * A non-positive or non-finite `refreshWithinMs` falls back to the profile
 * bound rather than collapsing the window: a head with `refreshBy` equal to
 * its own `issuedAt` is one both named verification procedures refuse (§5.2 --
 * the window has to be non-empty), and `writeSourceAppend` already rejects a
 * non-positive request outright, so producing one here would only mint a head
 * no consumer can accept.
 */
export function refreshHead(prev: SourceHead, clock: Clock, refreshWithinMs: number = MAX_REFRESH_BY_AHEAD_MS): SourceHead {
  const prevIssuedAtMs = parseHeadTimestamp(prev.issuedAt);
  if (Number.isNaN(prevIssuedAtMs)) {
    throw new Error(`refreshHead: previous head's issuedAt "${prev.issuedAt}" is not an offset-bearing RFC 3339 date-time.`);
  }
  const nowMs = clock.now().getTime();
  const issuedAtMs = Math.max(nowMs, prevIssuedAtMs + 1);
  const requestedAheadMs = Number.isFinite(refreshWithinMs) && refreshWithinMs > 0
    ? refreshWithinMs
    : MAX_REFRESH_BY_AHEAD_MS;
  const boundedAheadMs = Math.min(requestedAheadMs, MAX_REFRESH_BY_AHEAD_MS);
  return {
    ...prev,
    issuedAt: new Date(issuedAtMs).toISOString(),
    refreshBy: new Date(issuedAtMs + boundedAheadMs).toISOString(),
  };
}

/**
 * Re-signs and writes the head at `headPath(source.name)`, even when
 * nothing new was announced (§7 item 3) -- the live-source obligation that
 * makes an expired `refreshBy` a meaningful withholding signal. Passing
 * `signer` publishes a DSSE-signed head (§5.5 published profile); omitting
 * it writes the bare, unsigned-conformant head (§5.5 unpublished profile).
 * Rejects a `prevHead` whose `origin` does not match `source` -- a
 * misconfiguration guard against maintaining the wrong source's head.
 */
export async function maintainHead(
  store: BlobStore,
  signer: DsseSigner | undefined,
  clock: Clock,
  source: SourceIdentity,
  prevHead: SourceHead,
  refreshWithinMs: number = MAX_REFRESH_BY_AHEAD_MS,
): Promise<{ head: SourceHead; envelope?: DsseEnvelope }> {
  const expectedOrigin = formatOrigin(source.agent, source.name);
  if (prevHead.origin !== expectedOrigin) {
    throw new Error(
      `maintainHead: head origin "${prevHead.origin}" does not match the maintained source "${expectedOrigin}".`,
    );
  }

  const head = refreshHead(prevHead, clock, refreshWithinMs);
  const envelope = signer === undefined ? undefined : await signHead(head, signer);
  const body = envelope === undefined ? sealJson(head).bytes : sealJson(envelope).bytes;
  await store.put(headPath(source.name), body, MEDIA_HEAD);

  return envelope === undefined ? { head } : { head, envelope };
}

/**
 * Whether `head.refreshBy` is at most `maxAheadHours` ahead of `head.issuedAt`
 * (§5.2). The hours-shaped conformance-kit signature over the protocol's own
 * millisecond-shaped comparison -- one ceiling, two callers' units.
 */
export function refreshByWithinBound(head: { issuedAt: string; refreshBy: string }, maxAheadHours: number): boolean {
  return refreshByWithinCeiling(head, maxAheadHours * 60 * 60 * 1000);
}

/**
 * Decodes a head envelope's `payload` field into its `{issuedAt, refreshBy}`
 * pair. Accepts either the real DSSE wire format (base64-encoded canonical
 * bytes) or raw canonical-JSON text, since callers may hand this either a
 * genuine signed envelope or a bare sealed head.
 */
function decodeHeadTimestamps(payload: string): { issuedAt: string; refreshBy: string } {
  try {
    return JSON.parse(payload) as { issuedAt: string; refreshBy: string };
  } catch {
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as { issuedAt: string; refreshBy: string };
  }
}

/**
 * Whether a sequence of successive head envelopes maintains freshness
 * (§7 item 3): `issuedAt` strictly increases across the sequence, and each
 * head's `refreshBy` stays ahead of its own `issuedAt`.
 *
 * The timestamps are read strictly (§5.2, #3482) -- these envelopes are
 * decoded straight off the wire, never through `parseSourceHead`, so a head
 * whose timestamps are not offset-bearing would otherwise be judged against
 * the kit runner's own zone and hand the same bytes opposite verdicts on two
 * machines. An unreadable timestamp fails the conformance check.
 */
export function maintainsFreshness(headEnvelopes: Array<{ payload: string }>): boolean {
  const heads = headEnvelopes.map((envelope) => decodeHeadTimestamps(envelope.payload));
  for (let index = 1; index < heads.length; index += 1) {
    if (!(parseHeadTimestamp(heads[index]!.issuedAt) > parseHeadTimestamp(heads[index - 1]!.issuedAt))) return false;
  }
  return heads.every((head) => parseHeadTimestamp(head.refreshBy) > parseHeadTimestamp(head.issuedAt));
}
