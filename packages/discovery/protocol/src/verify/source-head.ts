import type { DsseEnvelope } from "@jinn-network/trust-core";
import type { SourceHead } from "../head.js";
import { splitOrigin } from "../grammar.js";
import { MEDIA_HEAD } from "../identifiers.js";
import { dssePreAuthEncoding, parseWireDsseEnvelope } from "../dsse.js";
import { sealJson } from "../sealing.js";
import type { SourceIdentity } from "../item.js";
import { MAX_REFRESH_BY_AHEAD_MS, refreshByWithinCeiling } from "./refresh-bound.js";
import type { FreshnessPolicy, KeyResolver, SignatureVerifier } from "./ports.js";
import type { SourceHeadOutcome } from "./outcomes.js";

// Named verification: `source-head-revalidation`. Steps 1-3 of
// `source-chain-verification` (design §10.3) with the chain removed:
//   1. resolve the source's working keys under the discovery signing scope;
//   2. verify the head's DSSE signature against a key currently valid at
//      `now`;
//   3. verify the `refreshBy` ceiling and `refreshBy` freshness.
//
// It exists for the ONE case the seven-step procedure cannot express: a
// source re-serving a head byte-identical to the one this consumer already
// accepted. §5.2 requires `issuedAt` to strictly increase on every
// re-signing, so `verifySourceChain` refuses an unchanged head as
// `issued-at-monotonicity` -- correct for a chain walk, wrong for a poll that
// simply outran the archive's re-signing.
//
// The caller is responsible for establishing that the presented head names
// EXACTLY the chain position it already holds before calling this; a head
// that names any other position is a chain claim and must go through
// `verifySourceChain`. This procedure deliberately neither reads nor advances
// the high-water mark: a revalidated head adopts nothing, and leaving the
// persisted `issuedAt` in place keeps it the monotonicity floor for the next
// head that does move.
//
// What it is NOT is a cached acceptance. Signature, currently-valid-key and
// freshness are re-checked on every call, so a rotated-out or revoked signer,
// a tampered envelope, a head whose `refreshBy` exceeds the profile ceiling,
// or a head that has crossed `refreshBy` still refuses even though the bytes
// are ones this consumer once accepted.

export async function verifySourceHead(opts: {
  /**
   * The source the caller is following. The head's own `origin` must name it:
   * keys are resolved from the head, so accepting a head that claims another
   * agent would let any agent's valid signature satisfy this source's poll.
   * `verifySourceChain` leaves that binding to its callers; this procedure,
   * which has no chain to catch it downstream, makes it explicit.
   */
  source: SourceIdentity;
  head: SourceHead;
  headSignature: DsseEnvelope;
  ports: {
    keys: KeyResolver;
    sigs: SignatureVerifier;
    fresh: FreshnessPolicy;
    now: Date;
    /**
     * The verifying profile's `refreshBy` ceiling (§5.2), in milliseconds
     * ahead of the head's own `issuedAt`. Defaults to the published-source
     * profile's bound; a deployment profile that pins a tighter one (the
     * marketplace profile does) passes it here. A profile may only tighten.
     */
    maxRefreshByAheadMs?: number;
  };
}): Promise<SourceHeadOutcome> {
  const { head, headSignature, source } = opts;
  const { keys, sigs, fresh, now } = opts.ports;
  const maxRefreshByAheadMs = opts.ports.maxRefreshByAheadMs ?? MAX_REFRESH_BY_AHEAD_MS;

  let origin;
  try {
    origin = splitOrigin(head.origin);
  } catch {
    return { status: "head-origin-mismatch" };
  }
  if (origin.agent !== source.agent || origin.name !== source.name) {
    return { status: "head-origin-mismatch" };
  }

  let parsed;
  try {
    parsed = parseWireDsseEnvelope(headSignature);
  } catch {
    return { status: "invalid-head-envelope" };
  }

  const expected = sealJson(head).bytes;
  if (
    parsed.envelope.payloadType !== MEDIA_HEAD ||
    parsed.payloadBytes.length !== expected.length ||
    !parsed.payloadBytes.every((byte, index) => byte === expected[index])
  ) {
    return { status: "head-payload-mismatch" };
  }

  // A key VALID AT `now`, not merely ever-bound: an old-key head is
  // `unauthorized-signer` here for the same reason it is in step 2 of the
  // chain procedure (§10.1).
  const currentKeys = await keys.resolve(origin.agent, now);
  const pae = dssePreAuthEncoding(MEDIA_HEAD, parsed.payloadBytes);
  for (const signature of parsed.signatures) {
    const key = currentKeys.find((candidate) => candidate.keyid === signature.keyid);
    if (key === undefined) continue;
    if (await sigs.verify(pae, signature.signatureBytes, key)) {
      // The ceiling is checked BEFORE freshness for the same reason the chain
      // procedure checks it first: a head whose `refreshBy` runs past the
      // profile bound is always fresh, so the clock can never catch it.
      if (!refreshByWithinCeiling(head, maxRefreshByAheadMs)) return { status: "refresh-by-ceiling" };
      return fresh.isFresh(head.refreshBy, now) ? { status: "ok" } : { status: "stale" };
    }
  }
  return { status: "unauthorized-signer" };
}
