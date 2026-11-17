// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CEREMONY_TYPES,
  DSSE_PAYLOAD_TYPE,
  TRUST_KEY_BINDING_FORMAT,
  TRUST_KEY_BINDING_MEDIA_TYPE,
  TRUST_REVOCATION_FORMAT,
  TRUST_REVOCATION_MEDIA_TYPE,
  ceremonyEvidenceDigest,
  compareCodeUnitStrings,
  deriveStrength,
  didPkh,
  dssePreAuthEncoding,
  parseDsseEnvelope,
  recoverEip191Address,
  sealDsseEnvelope,
  sealSignedRecord,
  serializeCeremonyMessage,
  settlementJoinCheck,
  verifyEnvelopeBinding,
} from "@jinn-network/trust-core";
import type {
  BindingAuthorityDeps,
  CeremonyType,
  DsseChainVerifier,
  DsseSigner,
  EoaCeremonyEvidence,
  KeyBinding,
  Revocation,
  Sha256Digest,
} from "@jinn-network/trust-core";
import { createAnchorResolver, createBindingResolver } from "@jinn-network/trust-resolve";
import type { SealedKeyBindingRecord, SealedRevocationRecord } from "@jinn-network/trust-resolve";
import { describe, expect, test } from "vitest";

import { createEoaTestSigner } from "./crypto.js";
import type { EoaTestSigner } from "./crypto.js";
import { testAgentIri, testDidKey, testSha256Digest } from "./fixtures.js";

// ---------------------------------------------------------------------------
// The world vectors of the key authority text,
// https://spec.jinn.network/profiles/key-authority/v1 section 13, copied byte
// for byte from the Jinn-Network/spec commit `provenance.json` names into
// `__fixtures__/key-authority-v1/`, which this package does not publish. Each
// vector states a world as data; this runner builds that world's sealed
// records by the construction in the copied README.md, stores them, and asks
// the real `createBindingResolver` and trust-core's procedure for each check's
// outcome, under each anchor profile the vector holds under and in many stored
// orders of its bindings and its revocations.
//
// The `account-signature` group states its cases directly and runs in
// trust-core (`key-authority-vectors.test.ts`). The vectors do not yet cover
// `agentId` composition (the README says so), so neither does this runner.
//
// Signatures: an account's signature on a revocation is a real EIP-191
// signature over the DSSE pre-authentication encoding (section 8), checked by
// recovery. A working key's signature is checked by its declared keyid, as
// every other suite in this kit does (`fakes.ts`): these keys are `did:key`
// spellings without key material, and the cases are about authority, so what
// "K did not sign" means here is an envelope that carries another key's
// signature and not K's.
// ---------------------------------------------------------------------------

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const ROOT = "key-authority-v1/";

interface Provenance {
  readonly repository: string;
  readonly commit: string;
  readonly root: string;
  readonly entries: readonly { readonly id: string; readonly sha256: string }[];
}

const provenance = JSON.parse(readFileSync(new URL(`${ROOT}provenance.json`, FIXTURES), "utf8")) as Provenance;

// ---------------------------------------------------------------------------
// The world format (README.md, "A world"). A field this runner does not know
// fails the vector, so a format change in the specification cannot pass here
// by being ignored.
// ---------------------------------------------------------------------------

type Profile = "anchors-required" | "anchors-optional";
const PROFILES: readonly Profile[] = ["anchors-required", "anchors-optional"];

interface WorldBinding {
  readonly id: string;
  readonly key: string;
  readonly voucher: string;
  readonly from: string;
  readonly anchor?: string | null;
  readonly until?: string;
  readonly scope?: readonly string[];
  readonly rel?: string;
  readonly consentBy?: string;
  readonly consentSig?: "undecodable";
  readonly ceremony?: string;
  readonly signed?: boolean;
  readonly below?: readonly string[];
  readonly filed?: string;
  readonly envelope?: {
    readonly type?: string;
    readonly until?: string | null;
    readonly scope?: readonly string[];
    readonly rel?: string;
  };
}

interface WorldEntry {
  readonly id: string;
  readonly anchor: string;
  readonly digest?: "low";
}

interface WorldRevocation {
  readonly target: string;
  readonly by: string;
  readonly at: string | null;
  readonly stated?: string;
  readonly envelope?: { readonly type?: string; readonly target?: string };
}

interface WorldJoin {
  readonly verdict: string;
  readonly settlement: string;
  readonly envelope: string;
  readonly claim: string;
}

interface WorldCheck {
  readonly key?: string;
  readonly at?: string;
  readonly join?: WorldJoin;
  readonly expect: string;
}

interface World {
  readonly name: string;
  readonly description: string;
  readonly profile?: Profile;
  readonly bindings: readonly WorldBinding[];
  readonly entries?: readonly WorldEntry[];
  readonly revocations?: readonly WorldRevocation[];
  readonly checks: readonly WorldCheck[];
}

const FIELDS = {
  world: ["name", "description", "profile", "bindings", "entries", "revocations", "checks"],
  binding: ["id", "key", "voucher", "from", "anchor", "until", "scope", "rel", "consentBy", "consentSig", "ceremony", "signed", "below", "filed", "envelope"],
  bindingEnvelope: ["type", "until", "scope", "rel"],
  entry: ["id", "anchor", "digest"],
  revocation: ["target", "by", "at", "stated", "envelope"],
  revocationEnvelope: ["type", "target"],
  check: ["key", "at", "join", "expect"],
  join: ["verdict", "settlement", "envelope", "claim"],
} as const;

const OUTCOMES = new Set([
  "accepted",
  "window-violation",
  "envelope-signature-invalid",
  "binding-not-resolved",
  "ceremony-verification-failed",
  "scope-violation",
  "consent-chain-violation",
  "revoked",
  "policy-rejected",
]);

function knownFields(where: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} is not an object`);
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`${where} has fields this runner does not know: ${unknown.join(", ")}`);
}

/** Reads one vector file, refusing anything outside the format the copied README states. */
function readWorld(id: string): World {
  const world = JSON.parse(readFileSync(new URL(id, FIXTURES), "utf8")) as World;
  knownFields(id, world, FIELDS.world);
  if (`${ROOT}${id.slice(ROOT.length).split("/")[0]}/${world.name}.json` !== id) throw new Error(`${id} is not named ${world.name}`);
  if (world.profile !== undefined && !PROFILES.includes(world.profile)) throw new Error(`${id}: profile ${world.profile}`);
  for (const binding of world.bindings) {
    knownFields(`${id} binding ${binding.id}`, binding, FIELDS.binding);
    if (binding.envelope !== undefined) knownFields(`${id} binding ${binding.id} envelope`, binding.envelope, FIELDS.bindingEnvelope);
  }
  for (const entry of world.entries ?? []) knownFields(`${id} entry ${entry.id}`, entry, FIELDS.entry);
  for (const revocation of world.revocations ?? []) {
    knownFields(`${id} revocation of ${revocation.target}`, revocation, FIELDS.revocation);
    if (revocation.envelope !== undefined) knownFields(`${id} revocation envelope`, revocation.envelope, FIELDS.revocationEnvelope);
  }
  for (const check of world.checks) {
    knownFields(`${id} check`, check, FIELDS.check);
    if (check.join === undefined) {
      if (check.key === undefined || !OUTCOMES.has(check.expect)) throw new Error(`${id}: check ${JSON.stringify(check)}`);
    } else {
      knownFields(`${id} join`, check.join, FIELDS.join);
      if (check.key !== undefined || check.at !== undefined || !["joined", "refused"].includes(check.expect)) {
        throw new Error(`${id}: join check ${JSON.stringify(check)}`);
      }
    }
  }
  return world;
}

const worldIds = provenance.entries.map(({ id }) => id).filter((id) => id.endsWith(".json"));
const worlds = worldIds.map((id) => [id.slice(ROOT.length, -".json".length), readWorld(id)] as const);

// ---------------------------------------------------------------------------
// The cast (README.md, "Building the records"): accounts A, B and C, distinct
// externally owned accounts on one chain, none a contract account; keys K1 to
// K7, distinct `did:key` keys; one Agent IRI per vector.
// ---------------------------------------------------------------------------

const CHAIN_ID = 84532;
const ACCOUNTS: Readonly<Record<string, EoaTestSigner>> = Object.fromEntries(
  ["A", "B", "C"].map((name) => [name, createEoaTestSigner(`key-authority-v1-account-${name}`)]),
);
const ACCOUNT_DIDS = new Map(Object.values(ACCOUNTS).map((signer) => [didPkh(CHAIN_ID, signer.address), signer]));
const KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  ["K1", "K2", "K3", "K4", "K5", "K6", "K7"].map((name) => [name, testDidKey(`key-authority-v1-key-${name}`)]),
);
/** Signs the envelopes of `signed: false` bindings and of stored entries: a key no world names. */
const UNNAMED_KEY = testDidKey("key-authority-v1-unnamed-key");
const SORT_FIELD = "trust-testing:sort";
const LOW_DIGEST = `sha256:${"0".repeat(64)}` as Sha256Digest;

function keyOf(name: string): string {
  const key = KEYS[name];
  if (key === undefined) throw new Error(`no key ${name}`);
  return key;
}

function accountOf(name: string): EoaTestSigner {
  const account = ACCOUNTS[name];
  if (account === undefined) throw new Error(`no account ${name}`);
  return account;
}

/** `MM-DD` is midnight UTC on that day of 2026. Any other time is literal. */
function time(value: string): string {
  return /^[0-9]{2}-[0-9]{2}$/u.test(value) ? `2026-${value}T00:00:00.000Z` : value;
}

function keySigner(keyid: string): DsseSigner {
  return async () => [{ signature: Uint8Array.of(1), keyid }];
}

/** Section 8, "An account's signature": EIP-191 `personal_sign` over the envelope's pre-authentication encoding. */
function accountSigner(account: EoaTestSigner): DsseSigner {
  return async ({ preAuthEncoding }) => [{ signature: account.sign(preAuthEncoding), keyid: didPkh(CHAIN_ID, account.address) }];
}

/** The DSSE leg: a key by its declared keyid (see the note at the top), an account by recovery. */
const worldDsseVerifier: DsseChainVerifier = (envelopeBytes) => {
  let envelope: ReturnType<typeof parseDsseEnvelope>;
  try {
    envelope = parseDsseEnvelope(envelopeBytes);
  } catch {
    return { validSignerKeyids: [] };
  }
  const preAuthEncoding = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
  return {
    validSignerKeyids: envelope.signatures.flatMap(({ keyid, sig }) => {
      if (keyid === undefined) return [];
      if (keyid.startsWith("did:key:")) return [keyid];
      const account = ACCOUNT_DIDS.get(keyid);
      if (account === undefined) return [];
      try {
        return recoverEip191Address(preAuthEncoding, Uint8Array.from(Buffer.from(sig, "base64"))) === account.address ? [keyid] : [];
      } catch {
        return [];
      }
    }),
  };
};

/** A genuine EOA ceremony by `account` over a message naming the Agent and the key. */
function eoaCeremony(account: EoaTestSigner, agent: string, key: string): EoaCeremonyEvidence {
  const message = {
    domain: "trust.jinn.network",
    address: account.address,
    uri: "https://trust.jinn.network/ceremony/key-binding",
    version: "1",
    chainId: CHAIN_ID,
    nonce: "key-authority-v1",
    issuedAt: "2026-01-01T00:00:00.000Z",
    resources: [agent, key],
  } as const;
  const messageBytes = serializeCeremonyMessage("eoa", message);
  return { type: "eoa", message, messageBytes, signature: account.sign(messageBytes) };
}

// ---------------------------------------------------------------------------
// Building a world's store.
// ---------------------------------------------------------------------------

interface BuiltWorld {
  readonly agent: string;
  readonly requireAnchors: boolean;
  /** Bindings in the vector's order, then its stored entries. */
  readonly bindings: readonly SealedKeyBindingRecord[];
  readonly revocations: readonly SealedRevocationRecord[];
  readonly anchorTimes: ReadonlyMap<Sha256Digest, string>;
}

async function buildWorld(id: string, world: World, profile: Profile): Promise<BuiltWorld> {
  const agent = testAgentIri(`key-authority-v1-${world.name}`);
  const requireAnchors = profile === "anchors-required";
  const anchorTimes = new Map<Sha256Digest, string>();
  const anchorAt = (label: string, at: string): readonly { readonly digest: Sha256Digest }[] => {
    const digest = testSha256Digest(`key-authority-v1/${id}/${profile}/anchor/${label}`);
    anchorTimes.set(digest, time(at));
    return [{ digest }];
  };

  const byId = new Map(world.bindings.map((binding) => [binding.id, binding]));
  const built = new Map<string, SealedKeyBindingRecord>();
  const building = new Set<string>();

  async function bind(binding: WorldBinding): Promise<SealedKeyBindingRecord> {
    const done = built.get(binding.id);
    if (done !== undefined) return done;
    if (building.has(binding.id)) throw new Error(`${id}: binding ${binding.id} depends on itself`);
    building.add(binding.id);
    const digestOf = async (other: string) => {
      const record = byId.get(other);
      if (record === undefined) throw new Error(`${id}: no binding ${other}`);
      return (await bind(record)).bindingDigest;
    };
    const below = await Promise.all((binding.below ?? []).map(digestOf));
    const filedUnder = binding.filed === undefined ? undefined : await digestOf(binding.filed);
    if (filedUnder !== undefined && below.length > 0) throw new Error(`${id}: ${binding.id} is both filed and sorted`);

    const key = keyOf(binding.key);
    const account = accountOf(binding.voucher);
    const anchorTime = binding.anchor === undefined ? binding.from : binding.anchor;
    const anchors = requireAnchors && anchorTime !== null ? anchorAt(`binding/${binding.id}`, anchorTime) : [];

    let evidence: EoaCeremonyEvidence | undefined;
    let ceremony: KeyBinding["ceremony"];
    if (binding.ceremony === undefined || binding.ceremony === "absent") {
      evidence = eoaCeremony(account, agent, key);
      ceremony = { type: "eoa", digest: ceremonyEvidenceDigest(evidence) };
    } else if ((CEREMONY_TYPES as readonly string[]).includes(binding.ceremony) && binding.ceremony !== "eoa") {
      ceremony = { type: binding.ceremony as CeremonyType, digest: testSha256Digest(`key-authority-v1/${id}/ceremony/${binding.id}`) };
    } else {
      throw new Error(`${id}: binding ${binding.id} ceremony ${binding.ceremony}`);
    }
    if (binding.consentSig !== undefined && binding.consentSig !== "undecodable") {
      throw new Error(`${id}: binding ${binding.id} consentSig ${binding.consentSig}`);
    }

    const fields = {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent,
      key: { publicKey: key, keyid: key, algorithm: "Ed25519", didKey: key },
      voucher: { kind: "account", did: didPkh(CHAIN_ID, account.address), contractAccount: false },
      relationship: binding.rel ?? "controls",
      scope: [...(binding.scope ?? ["verdicts", "bindings"])],
      validFrom: time(binding.from),
      ...(binding.until === undefined ? {} : { expiresAt: time(binding.until) }),
      ceremony,
      strength: deriveStrength(ceremony.type),
      ...(binding.consentBy === undefined
        ? {}
        // The kit's DSSE leg reads a countersignature's declared keyid; `undecodable` is not base64.
        : { consent: { keyid: keyOf(binding.consentBy), sig: binding.consentSig === "undecodable" ? "%" : btoa("countersigned") } }),
      anchors,
    } as KeyBinding;

    // Where `below` asks for this digest to sort below others, vary a namespaced extension field until it does.
    for (let attempt = 0; attempt < 4096; attempt += 1) {
      const stored = attempt === 0 ? fields : ({ ...fields, [SORT_FIELD]: attempt } as KeyBinding);
      const sealedFields: Record<string, unknown> = { ...stored };
      const { envelope } = binding;
      if (envelope?.until === null) delete sealedFields.expiresAt;
      else if (envelope?.until !== undefined) sealedFields.expiresAt = time(envelope.until);
      if (envelope?.scope !== undefined) sealedFields.scope = [...envelope.scope];
      if (envelope?.rel !== undefined) sealedFields.relationship = envelope.rel;
      // eslint-disable-next-line no-await-in-loop -- sealing until the digest lands.
      const sealed = await sealSignedRecord({
        record: sealedFields,
        payloadType: envelope?.type ?? TRUST_KEY_BINDING_MEDIA_TYPE,
        signer: keySigner(binding.signed === false ? UNNAMED_KEY : key),
      });
      const bindingDigest = filedUnder ?? sealed.recordDigest;
      if (below.every((other) => compareCodeUnitStrings(bindingDigest, other) < 0)) {
        const record: SealedKeyBindingRecord = {
          binding: stored,
          envelopeBytes: sealed.envelopeBytes,
          bindingDigest,
          ...(evidence === undefined || binding.ceremony === "absent" ? {} : { ceremonyEvidence: evidence }),
        };
        built.set(binding.id, record);
        building.delete(binding.id);
        return record;
      }
    }
    throw new Error(`${id}: no digest for ${binding.id} sorts below ${binding.below?.join(", ")}`);
  }

  const bindings: SealedKeyBindingRecord[] = [];
  for (const binding of world.bindings) {
    // eslint-disable-next-line no-await-in-loop -- one world's records, in its order.
    bindings.push(await bind(binding));
  }

  for (const entry of world.entries ?? []) {
    if (entry.digest !== undefined && entry.digest !== "low") throw new Error(`${id}: entry ${entry.id} digest ${entry.digest}`);
    // One anchor reference reported at `anchor`, or, for "unreadable", a value that is not a list of them.
    const fields = { anchors: entry.anchor === "unreadable" ? "unreadable" : anchorAt(`entry/${entry.id}`, entry.anchor) };
    // eslint-disable-next-line no-await-in-loop -- one world's records, in its order.
    const sealed = await sealSignedRecord({ record: fields, payloadType: TRUST_KEY_BINDING_MEDIA_TYPE, signer: keySigner(UNNAMED_KEY) });
    bindings.push({
      binding: fields as unknown as KeyBinding,
      envelopeBytes: sealed.envelopeBytes,
      bindingDigest: entry.digest === "low" ? LOW_DIGEST : testSha256Digest(`key-authority-v1/${id}/entry/${entry.id}`),
    });
  }

  const storedDigestOf = (target: string) => {
    const record = built.get(target);
    if (record === undefined) throw new Error(`${id}: no binding ${target}`);
    return record.bindingDigest;
  };
  const revocations: SealedRevocationRecord[] = [];
  for (const [index, revocation] of (world.revocations ?? []).entries()) {
    const account = revocation.by.startsWith("account:") ? accountOf(revocation.by.slice("account:".length)) : undefined;
    const revokedBy = account === undefined ? keyOf(revocation.by) : didPkh(CHAIN_ID, account.address);
    const stated = revocation.stated ?? revocation.at;
    if (stated === null) throw new Error(`${id}: revocation ${index} states no time`);
    const fields = {
      protocol: TRUST_REVOCATION_FORMAT,
      target: storedDigestOf(revocation.target),
      revokedBy,
      anchors: revocation.at === null ? [] : anchorAt(`revocation/${index}`, revocation.at),
      effectiveFrom: time(stated),
    } as Revocation;
    const payload = revocation.envelope?.target === undefined ? fields : { ...fields, target: storedDigestOf(revocation.envelope.target) };
    // eslint-disable-next-line no-await-in-loop -- one world's records, in its order.
    const sealed = await sealSignedRecord({
      record: payload,
      payloadType: revocation.envelope?.type ?? TRUST_REVOCATION_MEDIA_TYPE,
      signer: account === undefined ? keySigner(revokedBy) : accountSigner(account),
    });
    revocations.push({ revocation: fields, envelopeBytes: sealed.envelopeBytes });
  }

  return { agent, requireAnchors, bindings, revocations, anchorTimes };
}

// ---------------------------------------------------------------------------
// Stored orders. A verdict must be the same in every stored order of the
// bindings and of the revocations (README.md). Every order is taken where
// there are at most 24; past that, the listed order, its reverse and seeded
// shuffles up to 24. Binding orders and revocation orders are paired in turn,
// so every one of each is run.
// ---------------------------------------------------------------------------

const ORDERS_PER_LIST = 24;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function storedOrders<T>(items: readonly T[], seed: string): T[][] {
  let factorial = 1;
  for (let count = 2; count <= items.length; count += 1) factorial *= count;
  if (factorial <= ORDERS_PER_LIST) return permutations(items);
  const orders = new Map<string, T[]>();
  const add = (indices: number[]) => orders.set(indices.join(","), indices.map((index) => items[index]!));
  const listed = items.map((_item, index) => index);
  add(listed);
  add([...listed].reverse());
  const random = seededRandom(seed);
  while (orders.size < ORDERS_PER_LIST) {
    const shuffled = [...listed];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
    }
    add(shuffled);
  }
  return [...orders.values()];
}

// ---------------------------------------------------------------------------
// Running a world: the real resolver over one stored order, and section 9 or
// section 10 of the text for each check.
// ---------------------------------------------------------------------------

function authorityOver(
  world: BuiltWorld,
  bindings: readonly SealedKeyBindingRecord[],
  revocations: readonly SealedRevocationRecord[],
): BindingAuthorityDeps {
  const bindingResolver = createBindingResolver({
    bindings: {
      listBindingsForAgent: async (agent) => (agent === world.agent ? bindings : []),
      listRevocationsForTargets: async (targets) =>
        revocations.filter(({ revocation }) => targets.includes(revocation.target as Sha256Digest)),
    },
    anchors: createAnchorResolver({
      client: {
        lookupAnchor: async (digest) => {
          const anchorTime = world.anchorTimes.get(digest);
          return anchorTime === undefined ? null : { digest, anchorTime };
        },
      },
    }),
    requireAnchors: world.requireAnchors,
    recordSignedByItsKey: (record) => {
      const key = (record.binding as Partial<KeyBinding> | undefined)?.key?.didKey;
      return key !== undefined && worldDsseVerifier(record.envelopeBytes).validSignerKeyids.includes(key);
    },
  });
  return {
    bindingResolver,
    // No world holds a Safe ceremony, so no witness is ever asked for.
    witnessVerifier: { verify1271Witness: async () => ({ verified: false, reason: "no witness in a key-authority-v1 world" }) },
    dsseVerifier: worldDsseVerifier,
  };
}

/** Section 9 for record family `verdicts` (a trust policy that accepts every Agent, so step 9 never runs), or section 10. */
async function outcomeOf(world: BuiltWorld, deps: BindingAuthorityDeps, check: WorldCheck): Promise<string> {
  if (check.join !== undefined) {
    const joined = await settlementJoinCheck({
      verdictKey: keyOf(check.join.verdict),
      settlementDeclarationKey: keyOf(check.join.settlement),
      claimedEvaluatorAgent: world.agent,
      family: "verdicts",
      envelopeEffectiveTime: time(check.join.envelope),
      claimTime: time(check.join.claim),
    }, deps);
    return joined.ok ? "joined" : "refused";
  }
  const key = keyOf(check.key!);
  const envelopeBytes = sealDsseEnvelope({
    payloadBytes: new TextEncoder().encode("{}"),
    payloadType: DSSE_PAYLOAD_TYPE,
    signatures: [{ signature: Uint8Array.of(1), keyid: key }],
  });
  const outcome = await verifyEnvelopeBinding(
    { envelopeBytes, key, agent: world.agent, family: "verdicts", atTime: time(check.at ?? "06-01") },
    deps,
  );
  return outcome.ok ? "accepted" : outcome.reason ?? "refused without a reason";
}

function describeCheck(check: WorldCheck): string {
  return check.join === undefined
    ? `${check.key} at ${check.at ?? "06-01"}`
    : `join ${check.join.verdict}/${check.join.settlement} at ${check.join.envelope}/${check.join.claim}`;
}

/** Every check's outcome in every stored order run, keyed by the order's position in the run. */
async function runWorld(id: string, world: World, profile: Profile): Promise<{ readonly orders: number; readonly outcomes: Record<string, string>[] }> {
  const built = await buildWorld(id, world, profile);
  const bindingOrders = storedOrders(built.bindings, `${id}/${profile}/bindings`);
  const revocationOrders = storedOrders(built.revocations, `${id}/${profile}/revocations`);
  const runs = Math.max(bindingOrders.length, revocationOrders.length);
  const outcomes: Record<string, string>[] = [];
  for (let run = 0; run < runs; run += 1) {
    const deps = authorityOver(built, bindingOrders[run % bindingOrders.length]!, revocationOrders[run % revocationOrders.length]!);
    const observed: Record<string, string> = {};
    for (const [index, check] of world.checks.entries()) {
      // eslint-disable-next-line no-await-in-loop -- one resolver, its checks in turn.
      observed[`${index} ${describeCheck(check)}`] = await outcomeOf(built, deps, check);
    }
    outcomes.push(observed);
  }
  return { orders: runs, outcomes };
}

function expectedOf(world: World): Record<string, string> {
  return Object.fromEntries(world.checks.map((check, index) => [`${index} ${describeCheck(check)}`, check.expect]));
}

// ---------------------------------------------------------------------------

describe("key-authority-v1 world vectors", () => {
  test("are the bytes the specification published at the recorded commit, and no others", () => {
    expect(provenance.repository).toBe("https://github.com/Jinn-Network/spec");
    expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(provenance.root).toBe("documents/@jinn-network/trust-testing/fixtures");
    const directory = fileURLToPath(new URL(ROOT, FIXTURES));
    const onDisk = readdirSync(directory, { recursive: true, encoding: "utf8" })
      .filter((path) => statSync(join(directory, path)).isFile())
      .map((path) => `${ROOT}${path.split(sep).join("/")}`)
      .filter((id) => id !== `${ROOT}provenance.json`)
      .sort();
    expect(onDisk).toEqual(provenance.entries.map(({ id }) => id).sort());
    for (const { id, sha256 } of provenance.entries) {
      expect(createHash("sha256").update(readFileSync(new URL(id, FIXTURES))).digest("hex"), id).toBe(sha256);
    }
  });

  test("are every group the README lists but account-signature, which trust-core runs", () => {
    const readme = readFileSync(new URL(`${ROOT}README.md`, FIXTURES), "utf8");
    const listed = [...readme.matchAll(/^\| `([a-z-]+)\/` \|/gmu)].map((match) => match[1]!);
    expect(listed).toContain("account-signature");
    const copied = [...new Set(worldIds.map((id) => id.slice(ROOT.length).split("/")[0]!))].sort();
    expect(copied).toEqual(listed.filter((group) => group !== "account-signature").sort());
    expect(worlds).toHaveLength(116);
  });

  describe.each(worlds)("%s", (id, world) => {
    const profiles = world.profile === undefined ? PROFILES : [world.profile];
    test.each(profiles)(`${world.description} (%s)`, async (profile) => {
      const { orders, outcomes } = await runWorld(`${ROOT}${id}.json`, world, profile);
      expect(orders).toBeGreaterThan(0);
      const expected = expectedOf(world);
      for (const [run, observed] of outcomes.entries()) {
        expect(observed, `stored order ${run + 1} of ${orders}`).toEqual(expected);
      }
    });
  });
});
