import type { DsseEnvelope } from "@jinn-network/trust-core";
import type { AnnouncementEntry } from "../entry.js";
import type { SourceHead } from "../head.js";
import { splitOrigin } from "../grammar.js";
import { MEDIA_ENTRY, MEDIA_HEAD } from "../identifiers.js";
import { dssePreAuthEncoding } from "../dsse.js";
import { parseWireDsseEnvelope } from "../dsse.js";
import { sealJson } from "../sealing.js";
import { checkGlobalChainRules, digestEntries, walkLinkage, type DigestedEntry } from "./chain-rules.js";
import type { FreshnessPolicy, HighWaterMark, HighWaterMarkStore, KeyResolver, ResolvedKey, SignatureVerifier } from "./ports.js";
import type { SourceChainOutcome } from "./outcomes.js";

// Named verification: `source-chain-verification` (design §10.3). The
// seven-step procedure, in order:
//   1. resolve the source's working keys under the discovery signing scope;
//   2. verify the head's DSSE signature against a key currently valid at
//      `now` (a rotated-out/expired/revoked signer is unauthorized-signer,
//      regardless of any embedded timestamp -- entries, by contrast, are
//      accepted through the head's chain commitment, §10.1);
//   3. verify `refreshBy` freshness and `issuedAt` monotonicity;
//   4. verify linkage from the head's entry back to the high-water mark (or
//      genesis on first adoption);
//   5. verify entry signatures as corroboration (a key that held the scope
//      at any time -- rotation never orphans history);
//   6. check sequence contiguity and fork-absence;
//   7. advance the high-water mark.
//
// The chain's *structural* rules (§5.3) -- fork-absence, duplicate-genesis,
// source-wide announcementId uniqueness, withdrawal validity, sequence
// contiguity, published-source ceilings -- live in chain-rules.ts; this
// module is the I/O-adjacent orchestration (keys, signatures, freshness,
// the high-water mark).

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function verifySignedBy(
  envelope: DsseEnvelope,
  expectedPayload: Uint8Array,
  expectedPayloadType: string,
  candidates: readonly ResolvedKey[],
  sigs: SignatureVerifier,
): Promise<boolean> {
  let parsed;
  try {
    parsed = parseWireDsseEnvelope(envelope);
  } catch {
    return false;
  }
  if (parsed.envelope.payloadType !== expectedPayloadType || !sameBytes(parsed.payloadBytes, expectedPayload)) return false;
  const pae = dssePreAuthEncoding(parsed.envelope.payloadType, parsed.payloadBytes);
  for (const signature of parsed.signatures) {
    const key = candidates.find((candidate) => candidate.keyid === signature.keyid);
    if (key === undefined) continue;
    if (await sigs.verify(pae, signature.signatureBytes, key)) return true;
  }
  return false;
}

export async function verifySourceChain(opts: {
  head: SourceHead;
  headSignature: DsseEnvelope;
  entries: AsyncIterable<{ entry: AnnouncementEntry; signature: DsseEnvelope }>;
  ports: {
    keys: KeyResolver;
    sigs: SignatureVerifier;
    fresh: FreshnessPolicy;
    hwm: HighWaterMarkStore;
    now: Date;
    firstAdoption: boolean;
  };
}): Promise<SourceChainOutcome> {
  const { head, headSignature } = opts;
  const { keys, sigs, fresh, hwm, now, firstAdoption } = opts.ports;
  const source = splitOrigin(head.origin);

  // Step 1 + 2: resolve working keys under the discovery scope, verify the
  // head's DSSE signature against a key currently valid at `now`.
  const currentKeys = await keys.resolve(source.agent, now);
  if (!(await verifySignedBy(headSignature, sealJson(head).bytes, MEDIA_HEAD, currentKeys, sigs))) {
    return { status: "unauthorized-signer" };
  }

  // Step 3: refreshBy freshness.
  if (!fresh.isFresh(head.refreshBy, now)) {
    return { status: "stale" };
  }

  // Step 3 (continued) / step 4 precondition: issuedAt monotonicity is
  // checked against the consumer's own record of this source (the
  // high-water mark) -- a returning consumer (`!firstAdoption`) with no
  // high-water mark on file has no prior head to be monotonic against,
  // which is itself a broken invariant (§5.3 rule 5: "a returning consumer
  // MUST verify linkage ... always"), surfaced as `broken-chain`.
  const highWaterMark = await hwm.get(source);
  if (!firstAdoption && highWaterMark === undefined) {
    return { status: "broken-chain", at: "missing-high-water-mark" };
  }
  // §5.2: `issuedAt` MUST strictly increase on every re-signing. A prior
  // accepted head's `issuedAt` (persisted on the high-water mark) is the
  // consumer's own record to be monotonic against -- a presented head that
  // does not strictly increase on it is a regression (clock rollback or a
  // maliciously backdated re-sign), never accepted.
  if (
    highWaterMark !== undefined &&
    !(new Date(head.issuedAt).getTime() > new Date(highWaterMark.issuedAt).getTime())
  ) {
    return { status: "broken-chain", at: "issued-at-monotonicity" };
  }

  // Materialize the fed entries once; both the global structural checks and
  // the linkage walk need random-access-by-digest.
  const fed: Array<{ entry: AnnouncementEntry; signature: DsseEnvelope }> = [];
  for await (const item of opts.entries) fed.push(item);
  const digested = digestEntries(fed.map((item) => item.entry));
  const signatureByDigest = new Map(digested.map((d, index) => [d.digest, fed[index]!.signature] as const));
  const byDigest = new Map(digested.map((d) => [d.digest, d] as const));

  // Step 6 (fork-absence) is checked globally, ahead of the walk: a fork or
  // duplicate genesis is equivocation evidence even when the presented head
  // only cites one of the colliding entries (§5.3 rule 2).
  const globalFailure = checkGlobalChainRules(digested);
  if (globalFailure !== undefined) {
    if (globalFailure.kind === "forked") {
      return { status: "forked", evidence: { a: globalFailure.a, b: globalFailure.b } };
    }
    return { status: "broken-chain", at: globalFailure.kind };
  }

  // Step 4: linkage from the head's cited entry back to the high-water mark
  // (or genesis on first adoption). Step 6 (contiguity) and the
  // published-source ceilings are enforced along the same walk.
  const walk = walkLinkage({
    byDigest,
    headEntryDigest: head.entry,
    stopAtDigest: firstAdoption ? undefined : highWaterMark!.entry,
  });
  if (!walk.ok) {
    return { status: "broken-chain", at: walk.failure.kind };
  }

  // Step 5: entry signatures as corroboration -- a key that held the
  // discovery scope for this source's agent at ANY time (rotation never
  // orphans history, §10.1); a missing entry signature is broken-chain, a
  // signature by a key never bound to the agent is unauthorized-signer.
  for (const node of walk.walked) {
    // §16 item 2: each entry's source tuple must equal the head it is
    // walked under -- an entry from another of this agent's sources (or a
    // foreign one) must never be accepted as this source's history.
    if (node.entry.source.agent !== source.agent || node.entry.source.name !== source.name) {
      return { status: "broken-chain", at: "source-mismatch" };
    }
    const signature = signatureByDigest.get(node.digest)!;
    if (signature.signatures.length === 0) {
      return { status: "broken-chain", at: "missing-entry-signature" };
    }
    let everBoundSigner: string | undefined;
    for (const sig of signature.signatures) {
      if (sig.keyid === undefined) continue;
      if (await keys.everBound(source.agent, sig.keyid)) {
        everBoundSigner = sig.keyid;
        break;
      }
    }
    if (everBoundSigner === undefined) {
      return { status: "unauthorized-signer" };
    }
    const corroborated = await verifySignedBy(
      signature,
      sealJson(node.entry).bytes,
      MEDIA_ENTRY,
      [{ keyid: everBoundSigner, publicKey: "", algorithm: "" }],
      sigs,
    );
    if (!corroborated) {
      return { status: "broken-chain", at: "entry-signature-corroboration" };
    }
  }

  // Step 7: advance the high-water mark. Persists `issuedAt` alongside the
  // chain-position cursor -- the record the NEXT verification's issuedAt
  // monotonicity check (above) is monotonic against.
  const advanced: HighWaterMark = { sequence: head.sequence, entry: head.entry, issuedAt: head.issuedAt };
  await hwm.put(source, advanced);
  return { status: "ok", head, advanced };
}

// Re-exported for callers that need the digested walk shape without
// re-deriving it (e.g. serve/client, M5/M6).
export type { DigestedEntry };
