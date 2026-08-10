import { describe, expect, it } from "vitest";
import type { BindingResolver, BindingResolverQuery, ResolvedBinding } from "@jinn-network/trust-core";
import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_ENTRY,
  MEDIA_HEAD,
  archivePagePath,
  dssePreAuthEncoding,
  headPath,
  parseAnnouncementEntry,
  sealJson,
  sha256Hex,
} from "@jinn-network/record-discovery-protocol";
import type { AnnouncementEntry, SourceHead } from "@jinn-network/record-discovery-protocol";

import { createInMemoryHighWaterMarkStore } from "./high-water-mark.js";
import type { Transport, TransportResponse } from "./ports.js";
import { coldSync, fetchHead, returningSync } from "./sync.js";
import type { SourceEndpoint, SyncedEntry } from "./sync.js";
import { createTrustAdapter } from "./trust-adapter.js";
import type { AgentKeyCatalogEntry, RawSignatureVerifier } from "./trust-adapter.js";
import { createVerifyDriver } from "./verify-driver.js";

// #2531 F1, end-to-end across the REAL sync path.
//
// The consumer-side unit tests that existed before this file all fed `verifySourceChain` (or a stub
// standing in for it) by hand, so nothing ever asserted that what `returningSync` PRODUCES is what
// the linkage walk CONSUMES. It was not: returning sync yields entries strictly above the
// high-water mark, and the walk could only terminate by walking INTO the high-water-mark entry, so
// a consumer that had adopted entry N refused entry N+1 with `broken-chain`/`linkage` on a
// perfectly sound chain -- and could never recover, because the durable checkpoint stores the
// boundary entry's DIGEST and never its body.
//
// So this drives the actual production seam: a real served archive over a routed transport, real
// `coldSync`/`returningSync`, real DSSE envelopes over the real pre-auth encoding, and the real
// `createVerifyDriver` -> `verifySourceChain` -> `walkLinkage` stack. The only fake is the
// signature primitive itself (the M3 kit's `sha256Hex(pae):keyid` scheme, exactly as
// `verify-driver.test.ts` uses it) -- a wrong signature still fails, which is what keeps the
// "verification strength is unchanged" assertions below honest.

const AGENT = "did:key:zAgentSourceOne";
const SOURCE = "feed";
const ROOT = "https://example.org";
const KEYID = "key-1";
const NOW = new Date("2026-07-28T12:30:00.000Z");

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The M3 kit's fake signing scheme, over the REAL DSSE pre-auth encoding. */
function sign(payloadType: string, payloadBytes: Uint8Array, keyid = KEYID) {
  const pae = dssePreAuthEncoding(payloadType, payloadBytes);
  return {
    payloadType,
    payload: encodeBase64(payloadBytes),
    signatures: [{ keyid, sig: encodeBase64(new TextEncoder().encode(`${sha256Hex(pae)}:${keyid}`)) }],
  };
}

const verifier: RawSignatureVerifier = {
  async verify(pae, sig, key) {
    return new TextDecoder().decode(sig) === `${sha256Hex(pae)}:${key.keyid}`;
  },
};

function bindingResolver(): BindingResolver {
  return {
    async resolveBinding(query: BindingResolverQuery): Promise<ResolvedBinding | null> {
      if (query.agent !== AGENT || query.key !== KEYID) return null;
      return {
        binding: {
          protocol: "https://spec.jinn.network/trust/key-binding/v1",
          agent: AGENT,
          key: { publicKey: `pubkey-${KEYID}`, keyid: KEYID, algorithm: "ed25519", didKey: KEYID },
          voucher: { kind: "account", did: "did:pkh:eip155:1:0x0", contractAccount: false },
          relationship: "controls",
          scope: [DISCOVERY_SIGNING_SCOPE],
          validFrom: "2026-01-01T00:00:00.000Z",
          ceremony: { type: "eoa", digest: `sha256:${"0".repeat(64)}` },
          strength: "strong",
          anchors: [],
        } as never,
        envelopeBytes: new Uint8Array(),
        bindingDigest: `sha256:${"0".repeat(64)}`,
        effectiveStart: "2026-01-01T00:00:00.000Z",
        isGenesis: true,
        revocations: [],
      };
    },
  };
}

function makeEntry(sequence: string, previous: `sha256:${string}` | null): AnnouncementEntry {
  return parseAnnouncementEntry({
    protocol: "https://spec.jinn.network/record-discovery/v1",
    source: { agent: AGENT, name: SOURCE },
    sequence,
    previous,
    timestamp: "2026-07-28T12:00:00.000Z",
    announcements: [
      {
        announcementId: `ann-${sequence}`,
        action: "available",
        record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` },
      },
    ],
  });
}

function headFor(entry: AnnouncementEntry, issuedAt: string): SourceHead {
  return {
    protocol: "https://spec.jinn.network/record-discovery/v1",
    origin: `${AGENT}/${SOURCE}`,
    sequence: entry.sequence,
    entry: sealJson(entry).digest,
    issuedAt,
    refreshBy: "2026-07-29T12:00:00.000Z",
  };
}

/**
 * Serves the archive the way the real serving plane does: ONE PAGE PER ENTRY, newest page as the
 * advertised archive root, each page's `prevArchive` naming its predecessor. This is also the
 * shape that rolls the archive root as history grows, which is what operator A's live archive did.
 */
function serve(entries: readonly AnnouncementEntry[], issuedAt: string) {
  const routes = new Map<string, unknown>();
  entries.forEach((entry, index) => {
    const page = String(index + 1).padStart(16, "0");
    routes.set(`${ROOT}${archivePagePath(SOURCE, page)}`, {
      protocol: "https://spec.jinn.network/record-discovery/v1",
      source: SOURCE,
      page,
      prevArchive: index === 0 ? null : String(index).padStart(16, "0"),
      entries: [{ entry, signature: sign(MEDIA_ENTRY, sealJson(entry).bytes) }],
    });
  });
  const head = headFor(entries.at(-1)!, issuedAt);
  routes.set(`${ROOT}${headPath(SOURCE)}`, sign(MEDIA_HEAD, sealJson(head).bytes));

  const transport: Transport = {
    async "fetch"(url: string): Promise<TransportResponse> {
      if (!routes.has(url)) throw new Error(`no route seeded for ${url}`);
      return {
        status: 200,
        contentType: "application/json",
        bytes: sealJson(routes.get(url)).bytes,
      };
    },
  };
  const endpoint: SourceEndpoint = {
    agent: AGENT,
    name: SOURCE,
    servingRoot: ROOT,
    archiveRootUrl: `${ROOT}${archivePagePath(SOURCE, String(entries.length).padStart(16, "0"))}`,
  };
  return { transport, endpoint };
}

/** A fresh driver over a DURABLE high-water-mark store -- i.e. a process restart. */
function bootConsumer(hwm: ReturnType<typeof createInMemoryHighWaterMarkStore>) {
  const trust = createTrustAdapter({
    bindingResolver: bindingResolver(),
    keyCatalog: {
      async candidateKeys(agent: string): Promise<AgentKeyCatalogEntry[]> {
        return agent === AGENT ? [{ keyid: KEYID, probeAt: "2026-01-01T00:00:00.000Z" }] : [];
      },
    },
    verifier,
  });
  return createVerifyDriver({
    trust,
    hwm,
    factsProfiles: { get: () => undefined },
    factsRecompute: { get: () => undefined },
    records: { "fetch": async () => new Uint8Array() },
    entries: { "fetch": async () => new Uint8Array() },
    now: () => NOW,
  });
}

async function collect(entries: AsyncIterable<SyncedEntry>): Promise<SyncedEntry[]> {
  const out: SyncedEntry[] = [];
  for await (const item of entries) out.push(item);
  return out;
}

async function* signedEntries(items: readonly SyncedEntry[]) {
  for (const item of items) yield { entry: item.entry, signature: item.signature! };
}

const GENESIS = makeEntry("0000000000000001", null);
const SECOND = makeEntry("0000000000000002", sealJson(GENESIS).digest);
const THIRD = makeEntry("0000000000000003", sealJson(SECOND).digest);

describe("a returning consumer accepts the NEXT announcement across a restart (#2531 F1)", () => {
  it("cold-adopts entry N, restarts, and accepts entry N+1 without refetching the archive", async () => {
    const hwm = createInMemoryHighWaterMarkStore();

    // --- process 1: first adoption -------------------------------------------------
    const cold = serve([GENESIS, SECOND], "2026-07-28T12:05:00.000Z");
    const coldHead = await fetchHead(cold.endpoint, cold.transport);
    const coldEntries = await collect(coldSync(cold.endpoint, { transport: cold.transport }));
    expect(coldEntries.map((e) => e.entry.sequence)).toEqual(["0000000000000001", "0000000000000002"]);

    const first = await bootConsumer(hwm).verifySource({
      source: { agent: AGENT, name: SOURCE },
      head: coldHead.head,
      headSignature: coldHead.signature!,
      entries: signedEntries(coldEntries),
      firstAdoption: true,
    });
    expect(first.status).toBe("ok");
    expect(await hwm.get({ agent: AGENT, name: SOURCE })).toMatchObject({
      sequence: "0000000000000002",
      entry: sealJson(SECOND).digest,
    });

    // --- the source appends entry 3 (and its archive root rolls) --------------------
    const warm = serve([GENESIS, SECOND, THIRD], "2026-07-28T12:10:00.000Z");

    // --- process 2: a RESTART holding only the durable high-water mark --------------
    const warmHead = await fetchHead(warm.endpoint, warm.transport);
    const resumed = await collect(
      returningSync(warm.endpoint, { sequence: "0000000000000002", entry: sealJson(SECOND).digest }, {
        transport: warm.transport,
      }),
    );
    // This is the crux: returning sync hands over the NEW entry only. The high-water-mark entry
    // is not in the fed set and cannot be -- the checkpoint never stored its body.
    expect(resumed.map((e) => e.entry.sequence)).toEqual(["0000000000000003"]);

    const second = await bootConsumer(hwm).verifySource({
      source: { agent: AGENT, name: SOURCE },
      head: warmHead.head,
      headSignature: warmHead.signature!,
      entries: signedEntries(resumed),
      firstAdoption: false,
    });
    expect(second).toMatchObject({ status: "ok" });
    expect(await hwm.get({ agent: AGENT, name: SOURCE })).toMatchObject({
      sequence: "0000000000000003",
      entry: sealJson(THIRD).digest,
    });
  });

  it("accepts a THIRD announcement too -- resumption is not a one-shot", async () => {
    const hwm = createInMemoryHighWaterMarkStore();
    const cold = serve([GENESIS, SECOND], "2026-07-28T12:05:00.000Z");
    const coldHead = await fetchHead(cold.endpoint, cold.transport);
    await bootConsumer(hwm).verifySource({
      source: { agent: AGENT, name: SOURCE },
      head: coldHead.head,
      headSignature: coldHead.signature!,
      entries: signedEntries(await collect(coldSync(cold.endpoint, { transport: cold.transport }))),
      firstAdoption: true,
    });

    const fourth = makeEntry("0000000000000004", sealJson(THIRD).digest);
    for (const [index, [entries, issuedAt]] of ([
      [[GENESIS, SECOND, THIRD], "2026-07-28T12:10:00.000Z"],
      [[GENESIS, SECOND, THIRD, fourth], "2026-07-28T12:15:00.000Z"],
    ] as const).entries()) {
      const served = serve(entries, issuedAt);
      const head = await fetchHead(served.endpoint, served.transport);
      const mark = (await hwm.get({ agent: AGENT, name: SOURCE }))!;
      const outcome = await bootConsumer(hwm).verifySource({
        source: { agent: AGENT, name: SOURCE },
        head: head.head,
        headSignature: head.signature!,
        entries: signedEntries(
          await collect(returningSync(served.endpoint, mark, { transport: served.transport })),
        ),
        firstAdoption: false,
      });
      expect(outcome.status, `resumption ${index + 1}`).toBe("ok");
    }
    expect(await hwm.get({ agent: AGENT, name: SOURCE })).toMatchObject({
      sequence: "0000000000000004",
    });
  });
});

// The other half of the mandate: making the boundary optional must not make anything else
// optional. Each case below is a refusal that has to survive the F1 fix, driven through the same
// real path, with the high-water mark set so the returning branch is the one under test.
describe("verification strength is unchanged for a returning consumer (#2531 F1)", () => {
  async function returningOutcome(input: {
    readonly served: readonly AnnouncementEntry[];
    readonly fed: readonly AnnouncementEntry[];
    readonly mark: { sequence: string; entry: `sha256:${string}` };
    readonly headEntry?: AnnouncementEntry;
    readonly tamperEntrySignature?: boolean;
    readonly headKeyid?: string;
  }) {
    const hwm = createInMemoryHighWaterMarkStore();
    await hwm.put({ agent: AGENT, name: SOURCE }, { ...input.mark, issuedAt: "2026-07-28T12:05:00.000Z" });
    const head = headFor(input.headEntry ?? input.served.at(-1)!, "2026-07-28T12:10:00.000Z");
    return bootConsumer(hwm).verifySource({
      source: { agent: AGENT, name: SOURCE },
      head,
      headSignature: sign(MEDIA_HEAD, sealJson(head).bytes, input.headKeyid ?? KEYID) as never,
      entries: (async function* () {
        for (const entry of input.fed) {
          yield {
            entry,
            signature: sign(
              MEDIA_ENTRY,
              input.tamperEntrySignature ? new TextEncoder().encode("not the entry") : sealJson(entry).bytes,
            ) as never,
          };
        }
      })(),
      firstAdoption: false,
    });
  }

  it("refuses `linkage` when the fed entry names a parent that is NOT the high-water mark (fork)", async () => {
    const forged = parseAnnouncementEntry({
      ...THIRD,
      previous: `sha256:${"e".repeat(64)}`,
    });
    expect(
      await returningOutcome({
        served: [forged],
        fed: [forged],
        mark: { sequence: "0000000000000002", entry: sealJson(SECOND).digest },
      }),
    ).toEqual({ status: "broken-chain", at: "linkage" });
  });

  it("refuses `sequence-contiguity` when the fed entry links correctly but skips a sequence", async () => {
    const gapped = makeEntry("0000000000000005", sealJson(SECOND).digest);
    expect(
      await returningOutcome({
        served: [gapped],
        fed: [gapped],
        mark: { sequence: "0000000000000002", entry: sealJson(SECOND).digest },
      }),
    ).toEqual({ status: "broken-chain", at: "sequence-contiguity" });
  });

  it("refuses `linkage` on a rollback: the recorded high-water mark is no longer on the served chain", async () => {
    expect(
      await returningOutcome({
        served: [GENESIS, SECOND],
        fed: [GENESIS, SECOND],
        mark: { sequence: "0000000000000009", entry: `sha256:${"f".repeat(64)}` },
      }),
    ).toEqual({ status: "broken-chain", at: "linkage" });
  });

  it("refuses `forked` when two distinct children of the high-water mark are served together", async () => {
    const sibling = parseAnnouncementEntry({
      ...THIRD,
      announcements: [{ ...THIRD.announcements[0]!, announcementId: "ann-sibling" }],
    });
    expect(
      await returningOutcome({
        served: [THIRD, sibling],
        fed: [THIRD, sibling],
        mark: { sequence: "0000000000000002", entry: sealJson(SECOND).digest },
      }),
    ).toMatchObject({ status: "forked" });
  });

  it("refuses `entry-signature-corroboration` when a fed entry's signature does not cover it", async () => {
    expect(
      await returningOutcome({
        served: [THIRD],
        fed: [THIRD],
        mark: { sequence: "0000000000000002", entry: sealJson(SECOND).digest },
        tamperEntrySignature: true,
      }),
    ).toEqual({ status: "broken-chain", at: "entry-signature-corroboration" });
  });

  it("refuses `unauthorized-signer` when the head is signed by a key never bound to the agent", async () => {
    expect(
      await returningOutcome({
        served: [THIRD],
        fed: [THIRD],
        mark: { sequence: "0000000000000002", entry: sealJson(SECOND).digest },
        headKeyid: "key-never-bound",
      }),
    ).toEqual({ status: "unauthorized-signer" });
  });

  it("refuses `issued-at-monotonicity` when the presented head does not strictly advance", async () => {
    const hwm = createInMemoryHighWaterMarkStore();
    await hwm.put(
      { agent: AGENT, name: SOURCE },
      { sequence: "0000000000000002", entry: sealJson(SECOND).digest, issuedAt: "2026-07-28T12:20:00.000Z" },
    );
    const head = headFor(THIRD, "2026-07-28T12:10:00.000Z"); // BEHIND the recorded head
    expect(
      await bootConsumer(hwm).verifySource({
        source: { agent: AGENT, name: SOURCE },
        head,
        headSignature: sign(MEDIA_HEAD, sealJson(head).bytes) as never,
        entries: (async function* () {
          yield { entry: THIRD, signature: sign(MEDIA_ENTRY, sealJson(THIRD).bytes) as never };
        })(),
        firstAdoption: false,
      }),
    ).toEqual({ status: "broken-chain", at: "issued-at-monotonicity" });
  });

  it("refuses `source-mismatch` when a fed entry belongs to another source of the same agent", async () => {
    const foreign = parseAnnouncementEntry({
      ...THIRD,
      source: { agent: AGENT, name: "other-source" },
    });
    expect(
      await returningOutcome({
        served: [foreign],
        fed: [foreign],
        mark: { sequence: "0000000000000002", entry: sealJson(SECOND).digest },
      }),
    ).toEqual({ status: "broken-chain", at: "source-mismatch" });
  });

  it("refuses `missing-high-water-mark` when a returning consumer holds no checkpoint at all", async () => {
    const hwm = createInMemoryHighWaterMarkStore();
    const head = headFor(THIRD, "2026-07-28T12:10:00.000Z");
    expect(
      await bootConsumer(hwm).verifySource({
        source: { agent: AGENT, name: SOURCE },
        head,
        headSignature: sign(MEDIA_HEAD, sealJson(head).bytes) as never,
        entries: (async function* () {
          yield { entry: THIRD, signature: sign(MEDIA_ENTRY, sealJson(THIRD).bytes) as never };
        })(),
        firstAdoption: false,
      }),
    ).toEqual({ status: "broken-chain", at: "missing-high-water-mark" });
  });
});
