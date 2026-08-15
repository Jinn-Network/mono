import {
  DISCOVERY_SIGNING_SCOPE,
  dssePreAuthEncoding,
  recordDigest,
  referenceBearingFields,
  sealJson,
  sha256Hex,
} from "@jinn-network/record-discovery-protocol";
import type {
  EntryFetcher,
  FactsProfileDocument,
  FactsRecompute,
  FreshnessPolicy,
  HighWaterMark,
  HighWaterMarkStore,
  KeyResolver,
  RecordFactRecompute,
  RecordFactValue,
  RecordFetcher,
  ReferencedBytes,
  ResolvedKey,
  SignatureVerifier,
  SourceIdentity,
  SubstrateChecker,
} from "@jinn-network/record-discovery-protocol";

// Deterministic in-memory fakes for every port `record-discovery-protocol`
// defines (plan Task 11 Step 1). No ambient network, no locale-sensitive
// APIs -- guard-enforced same as every other file in this tree.
//
// Fake signing scheme (testing-kit-internal only, never used outside this
// kit -- real DSSE verification is trust-core's job at M6): a "signature"
// is the string `sha256Hex(dssePreAuthEncoding(payloadType, payloadBytes))
// + ":" + keyid`. This mirrors exactly how the §18 vector fixtures were
// generated (see fixtures/vectors/*/vector.json).

export interface SeedKey {
  agent: string;
  keyid: string;
  validFrom: string;
  validTo: string | null;
  scope: string;
}

export interface Seed {
  now: string; // ISO instant the fake Clock reports
  keys: SeedKey[]; // key-binding history for KeyResolver
  hwm: { source: SourceIdentity; cursor: HighWaterMark } | null;
  /** digest -> the record's own JSON value (sealed on demand for RecordFetcher/facts recompute). */
  records: Record<string, unknown>;
  /** digest -> the entry's own JSON value (sealed on demand for EntryFetcher). */
  entries: Record<string, unknown>;
  /** Referenced-record digests that are NOT fetchable -- drives `indeterminate` facts. */
  withheldDigests: string[];
  /** The single facts profile active for the item(s) under test. */
  factsProfile: FactsProfileDocument | undefined;
  /** Whether the announcing source is an author source (rejects substrate facts, §5.4 rule 2). */
  sourceClass: "author" | "projection";
  substrateOutcome: "present" | "fabricated" | "reorged-away" | undefined;
}

export const DEFAULT_SEED: Seed = {
  now: "2026-07-28T12:00:00.000Z",
  keys: [],
  hwm: null,
  records: {},
  entries: {},
  withheldDigests: [],
  factsProfile: undefined,
  sourceClass: "projection",
  substrateOutcome: undefined,
};

export function mergeSeed(seed?: Partial<Seed>): Seed {
  // Fixture-derived partial seeds (built from JSON that may omit a key
  // entirely) can carry an explicit `undefined` for a field rather than
  // leaving it absent; an ordinary object spread would let that
  // `undefined` clobber DEFAULT_SEED's value, so only apply keys the
  // caller actually set to something other than `undefined`.
  const defined = Object.fromEntries(
    Object.entries(seed ?? {}).filter(([, value]) => value !== undefined),
  );
  return { ...DEFAULT_SEED, ...defined };
}

export interface TestPorts {
  seed: Seed;
  clock: { now(): Date };
  keys: KeyResolver;
  sigs: SignatureVerifier;
  fresh: FreshnessPolicy;
  hwm: HighWaterMarkStore;
  records: RecordFetcher;
  entries: EntryFetcher;
  substrate: SubstrateChecker;
  factsRecompute: FactsRecompute;
}

/** The fake signing scheme's signature string (exported so the harness/vectors' pre-baked "sig" fields are legible against it). */
export function fakeSignature(payloadType: string, payloadBytes: Uint8Array, keyid: string): string {
  const pae = dssePreAuthEncoding(payloadType, payloadBytes);
  return `${sha256Hex(pae)}:${keyid}`;
}

function withinValidity(key: SeedKey, at: Date): boolean {
  const from = new Date(key.validFrom).getTime();
  const to = key.validTo === null ? Number.POSITIVE_INFINITY : new Date(key.validTo).getTime();
  const t = at.getTime();
  return t >= from && t < to;
}

// The KeyResolver contract (protocol's verify/ports.ts) documents `resolve`
// as returning "the scoped keys valid for `agent` at `at`, under
// DISCOVERY_SIGNING_SCOPE" -- i.e. the resolver itself is scoped to
// discovery's signing purpose, not merely to `agent`. Filtering on
// `key.scope === DISCOVERY_SIGNING_SCOPE` here (a seeded field the fake
// previously stored but never consulted) is what makes the
// `wrong-signing-scope` vector -- a key bound under a foreign scope -- fail
// resolution the way §10.3 step 1 requires (finding, M4).
function makeKeyResolver(seed: Seed): KeyResolver {
  return {
    async resolve(agent: string, at: Date): Promise<ResolvedKey[]> {
      return seed.keys
        .filter((key) => key.agent === agent && key.scope === DISCOVERY_SIGNING_SCOPE && withinValidity(key, at))
        .map((key) => ({ keyid: key.keyid, publicKey: `fake-public-key:${key.keyid}`, algorithm: "fake" }));
    },
    async everBound(agent: string, keyid: string): Promise<boolean> {
      return seed.keys.some((key) => key.agent === agent && key.keyid === keyid && key.scope === DISCOVERY_SIGNING_SCOPE);
    },
  };
}

function makeSignatureVerifier(): SignatureVerifier {
  return {
    async verify(pae: Uint8Array, sig: Uint8Array, key: ResolvedKey): Promise<boolean> {
      const expected = `${sha256Hex(pae)}:${key.keyid}`;
      return new TextDecoder().decode(sig) === expected;
    },
  };
}

function makeFreshnessPolicy(): FreshnessPolicy {
  return {
    isFresh(refreshBy: string, now: Date): boolean {
      return new Date(refreshBy).getTime() > now.getTime();
    },
  };
}

function makeHighWaterMarkStore(seed: Seed): HighWaterMarkStore {
  const store = new Map<string, HighWaterMark>();
  // Fixture JSON that omits `seed.hwm` entirely (rather than spelling out
  // `"hwm": null`) parses to `undefined`, not `null` -- treat both as "no
  // high-water mark" so a missing key never crashes the fake.
  if (seed.hwm !== null && seed.hwm !== undefined) {
    store.set(`${seed.hwm.source.agent}/${seed.hwm.source.name}`, seed.hwm.cursor);
  }
  return {
    async get(source: SourceIdentity): Promise<HighWaterMark | undefined> {
      return store.get(`${source.agent}/${source.name}`);
    },
    async put(source: SourceIdentity, mark: HighWaterMark): Promise<void> {
      store.set(`${source.agent}/${source.name}`, mark);
    },
  };
}

// Every `"fetch"(...)` method below is deliberately quoted, not
// `fetch(...)` -- see the identical note in protocol's verify/ports.ts.
// The discovery tree's ambient-network guard is a textual regex scanner
// (cloned verbatim, never re-derived) and cannot distinguish a same-named
// port-method declaration from a call to the banned global `fetch`; the
// quoted form is semantically identical for every caller.

function makeRecordFetcher(seed: Seed): RecordFetcher {
  return {
    async "fetch"(digest: `sha256:${string}`): Promise<Uint8Array> {
      const value = seed.records[digest];
      if (value === undefined) throw new Error(`fake RecordFetcher: no record seeded for ${digest}`);
      return sealJson(value).bytes;
    },
  };
}

function makeEntryFetcher(seed: Seed): EntryFetcher {
  return {
    async "fetch"(digest: `sha256:${string}`): Promise<Uint8Array> {
      const value = seed.entries[digest];
      if (value === undefined) throw new Error(`fake EntryFetcher: no entry seeded for ${digest}`);
      return sealJson(value).bytes;
    },
  };
}

function makeSubstrateChecker(seed: Seed): SubstrateChecker {
  return {
    async check(): Promise<"present" | "fabricated" | "reorged-away"> {
      return seed.substrateOutcome ?? "present";
    },
  };
}

function makeReferencedBytes(seed: Seed): ReferencedBytes {
  return {
    async "fetch"(digest: `sha256:${string}`): Promise<Uint8Array | undefined> {
      if (seed.withheldDigests.includes(digest)) return undefined;
      const value = seed.records[digest];
      return value === undefined ? undefined : sealJson(value).bytes;
    },
  };
}

/**
 * Builds the single generic per-kind recompute fn the fake registers for
 * every kind under test: reference-bearing fields read straight from the
 * record's own bytes; every other RECORD-classed field is treated as
 * "drawn from the referenced record" (design §12's Submission example --
 * task profile URI drawn from the referenced Task) keyed by the record's
 * own reference-bearing field's value, `undefined` when that referenced
 * lookup is withheld. SUBSTRATE-classed fields are never computed from
 * record bytes (§5.4 rule 2: projection-only) -- they are simply absent
 * from the recomputed map, which conformance.ts's comparison treats as an
 * automatic mismatch against any announced substrate fact from an author
 * source.
 */
function makeRecordFactRecompute(seed: Seed): RecordFactRecompute {
  return async (bytes: Uint8Array, refs: ReferencedBytes): Promise<Record<string, RecordFactValue>> => {
    const profile = seed.factsProfile;
    if (profile === undefined) return {};
    const record = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const referenceField = referenceBearingFields(profile)[0];
    const referenceDigest = referenceField !== undefined ? (record[referenceField] as string | undefined) : undefined;

    const result: Record<string, RecordFactValue> = {};
    for (const field of profile.fields) {
      if (field.class === "substrate") continue; // never record-computable
      if (field.referenceBearing === true) {
        const value = record[field.name];
        result[field.name] = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
        continue;
      }
      const referencedBytes = referenceDigest !== undefined ? await refs.fetch(referenceDigest as `sha256:${string}`) : undefined;
      if (referencedBytes === undefined) {
        result[field.name] = undefined;
        continue;
      }
      const value = record[field.name];
      result[field.name] = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
    }
    return result;
  };
}

function makeFactsRecompute(seed: Seed): FactsRecompute {
  const recompute = makeRecordFactRecompute(seed);
  return {
    get(_kind: string): RecordFactRecompute | undefined {
      // The fake is kind-agnostic: it registers the one active profile's
      // recompute fn for whatever kind the vector under test declares.
      // A real FactsRecompute registry (facts/* leaves, M7/M8) is keyed
      // per-kind; here there is always exactly one kind in play per vector.
      return seed.factsProfile === undefined ? undefined : recompute;
    },
  };
}

/** Builds the full deterministic port bundle from a (possibly partial) seed. */
export function makeInMemoryPorts(seed?: Partial<Seed>): TestPorts {
  const merged = mergeSeed(seed);
  return {
    seed: merged,
    clock: { now: () => new Date(merged.now) },
    keys: makeKeyResolver(merged),
    sigs: makeSignatureVerifier(),
    fresh: makeFreshnessPolicy(),
    hwm: makeHighWaterMarkStore(merged),
    records: makeRecordFetcher(merged),
    entries: makeEntryFetcher(merged),
    substrate: makeSubstrateChecker(merged),
    factsRecompute: makeFactsRecompute(merged),
  };
}

/** Re-hashes a fixture record digest the same way `sealJson` would -- exported for harness/vector wiring convenience. */
export function digestOf(value: unknown): `sha256:${string}` {
  return sealJson(value).digest;
}

/** Exposed for callers that need a raw digest over already-encoded bytes without going through JCS. */
export function digestOfBytes(bytes: Uint8Array): `sha256:${string}` {
  return recordDigest(bytes);
}
