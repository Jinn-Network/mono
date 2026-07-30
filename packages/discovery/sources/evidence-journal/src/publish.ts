import type { AnnouncementEntry, SourceHead, SourceIdentity } from "@jinn-network/record-discovery-protocol";
import { GENESIS_SEQUENCE, MEDIA_ENTRY, RECORD_DISCOVERY_VERSION, dssePreAuthEncoding, formatOrigin, sealJson } from "@jinn-network/record-discovery-protocol";
import type { BlobStore, Clock, DsseEnvelope, DsseSigner, SignedEntry } from "@jinn-network/record-discovery-serve";
import { maintainHead, writeArchivePages } from "@jinn-network/record-discovery-serve";

// Publishing (design §5.5, §7; plan Task 25 Step 3): re-seals + signs +
// writes the wrapper's OWN chain and head through `record-discovery-serve`'s
// published-source toolkit -- this module never signs journal bytes as-is
// (§11). Passing `signer` publishes the DSSE-signed published-source
// profile; omitting it writes the bare unpublished-conformant chain (§5.5),
// exactly the same signer-presence convention `serve`'s own `maintainHead`
// uses for the head.

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Signs one announcement entry under the entry payload type (§5.5: "entries
 * are signed once at append time"). Mirrors `record-discovery-serve`'s own
 * `signHead` exactly -- same DSSE-envelope-over-sealed-bytes construction,
 * `MEDIA_ENTRY` in place of `MEDIA_HEAD` -- because `serve` provides the
 * entry *storage* primitive (`writeArchivePages`, taking already-signed
 * `{entry, signature}` pairs) but not entry signing itself; unlike the head,
 * which `serve` owns end-to-end because it alone knows the head's own
 * re-signing cadence, entry signing is the appending source's job.
 */
export async function signEntry(entry: AnnouncementEntry, signer: DsseSigner): Promise<DsseEnvelope> {
  const { bytes } = sealJson(entry);
  const pae = dssePreAuthEncoding(MEDIA_ENTRY, bytes);
  const signatures = await signer.sign(pae);
  return {
    payloadType: MEDIA_ENTRY,
    payload: encodeBase64(bytes),
    signatures: signatures.map((signature) => ({
      ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
      sig: encodeBase64(signature.sig),
    })),
  };
}

export interface PublishOptions {
  readonly store: BlobStore;
  readonly clock: Clock;
  /** Present => published-source profile (DSSE-signed); absent => unpublished profile (§5.5). */
  readonly signer: DsseSigner | undefined;
  readonly source: SourceIdentity;
  /** Newly reconciled entries (`reconcile()`'s output), in ascending sequence order. May be empty for a head-only freshness refresh (§7 item 3). */
  readonly entries: readonly AnnouncementEntry[];
  /** The source's previously published head; `undefined` only for the very first publish ever (bootstrap). */
  readonly previousHead: SourceHead | undefined;
  readonly refreshWithinMs?: number;
}

export interface PublishResult {
  readonly pages: string[];
  readonly head: SourceHead;
  readonly headEnvelope?: DsseEnvelope;
}

function bootstrapHeadShell(source: SourceIdentity): SourceHead {
  // A placeholder shell for `maintainHead`'s `prevHead` parameter on the
  // very first publish: `sequence`/`entry` are overwritten below (from the
  // first batch's tip) before `maintainHead` is ever called, and its
  // ancient `issuedAt` guarantees `refreshHead`'s
  // `Math.max(nowMs, prevIssuedAtMs + 1)` resolves to "now" rather than
  // this placeholder.
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: formatOrigin(source.agent, source.name),
    sequence: GENESIS_SEQUENCE,
    entry: `sha256:${"0".repeat(64)}`,
    issuedAt: new Date(0).toISOString(),
    refreshBy: new Date(0).toISOString(),
  };
}

/**
 * Writes new entries (if any) as signed archive pages, then advances and
 * (re-)signs the head to cite the newest entry -- or, when `entries` is
 * empty, simply re-signs the existing head in place (the live-source
 * freshness obligation, §7 item 3).
 */
export async function publish(options: PublishOptions): Promise<PublishResult> {
  const { store, clock, signer, source, entries, previousHead, refreshWithinMs } = options;
  if (previousHead === undefined && entries.length === 0) {
    throw new Error("publish: a source with no previous head must publish at least one entry (bootstrap, §5.2).");
  }

  let pages: string[] = [];
  if (entries.length > 0) {
    const signedEntries: SignedEntry[] = await Promise.all(
      entries.map(async (entry) => ({
        entry,
        ...(signer === undefined ? {} : { signature: await signEntry(entry, signer) }),
      })),
    );
    ({ pages } = await writeArchivePages(store, source.name, signedEntries));
  }

  const tip = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const base = previousHead ?? bootstrapHeadShell(source);
  const advancedHead: SourceHead = tip === undefined ? base : { ...base, sequence: tip.sequence, entry: sealJson(tip).digest };

  const { head, envelope } = await maintainHead(store, signer, clock, source, advancedHead, refreshWithinMs);
  return { pages, head, ...(envelope === undefined ? {} : { headEnvelope: envelope }) };
}
