// SPDX-License-Identifier: Apache-2.0

/**
 * Seeded inputs for the equivalence suite. The corpus holds what someone thought of; these hold the
 * combinations nobody did: envelopes built from every spelling the parsers tell apart, signed by
 * the right and wrong keys of every type `node:crypto` can verify with, then damaged. A run is
 * fixed by its seed.
 */

import { createHash } from "node:crypto";
import { MATRIX_RECORD_KIND, RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import {
  DSSE_PAYLOAD_TYPE,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  canonicalJsonBytes,
  dssePreAuthEncoding,
} from "@jinn-network/trust-core";
import type { EvaluateIntegrityAnchorsInput } from "../../anchor/check.js";

export interface Rng {
  /** A whole number from 0 up to, but not including, `below`. */
  int(below: number): number;
  chance(probability: number): boolean;
  pick<T>(choices: readonly T[]): T;
  bytes(length: number): Uint8Array;
}

/** mulberry32: small, and fixed by its seed on every host. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number): number => Math.floor(next() * below);
  return {
    int,
    chance: (probability) => next() < probability,
    pick: (choices) => choices[int(choices.length)]!,
    bytes: (length) => Uint8Array.from({ length }, () => int(256)),
  };
}

export interface EnvelopeSigner {
  readonly keyId: string;
  sign(message: Uint8Array): Uint8Array;
}

/**
 * The right value most of the time. A valid input is built from many independent choices, so with
 * even odds nearly every input would be wrong in several ways at once and be refused by the first
 * check it meets. Near-valid inputs, wrong in one way, are the ones that tell two checkers apart.
 */
function mostly<T>(rng: Rng, right: T, wrong: readonly T[]): T {
  return rng.chance(0.85) ? right : rng.pick(wrong);
}

function standardBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Each spelling is one the strict parser, the lenient parser, or both read differently. */
const OTHER_BASE64_SPELLINGS: readonly ((bytes: Uint8Array) => string)[] = [
  (bytes) => Buffer.from(bytes).toString("base64url"),
  (bytes) => standardBase64(bytes).replace(/=+$/u, ""),
  // Sets the bits a `=` ending leaves unused, which every decoder here ignores.
  (bytes) => standardBase64(bytes).replace(/[A-Za-z0-9+/](?==+$)/u, "B"),
  (bytes) => `${standardBase64(bytes).slice(0, 4)}\n${standardBase64(bytes).slice(4)}`,
  (bytes) => `${standardBase64(bytes)}=`,
  (bytes) => `-_${standardBase64(bytes).slice(2)}+/`,
];

function damagedSignature(rng: Rng, signature: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(signature);
  if (rng.chance(0.85)) return copy;
  switch (rng.int(4)) {
    case 0:
      if (copy.length > 0) copy[rng.int(copy.length)]! ^= 1 << rng.int(8);
      return copy;
    case 1:
      return copy.slice(0, -1);
    case 2:
      return Uint8Array.of(...copy, 0);
    default:
      return rng.bytes(rng.int(80));
  }
}

interface SpelledSignature {
  readonly keyid?: string;
  readonly sig: string;
}

function randomSignature(
  rng: Rng,
  preAuthEncoding: Uint8Array,
  signer: EnvelopeSigner,
  stranger: EnvelopeSigner,
): SpelledSignature {
  const who = mostly(rng, signer, [stranger]);
  const message = mostly(rng, preAuthEncoding, [rng.bytes(16)]);
  const keyid = mostly(rng, signer.keyId, [stranger.keyId, undefined, ""]);
  const spelling = mostly(rng, standardBase64, OTHER_BASE64_SPELLINGS);
  return {
    ...(keyid === undefined ? {} : { keyid }),
    sig: spelling(damagedSignature(rng, who.sign(message))),
  };
}

interface SpelledEnvelope {
  readonly payloadType: string;
  readonly payload: string;
  readonly signatures: readonly SpelledSignature[];
}

function canonical(envelope: SpelledEnvelope): string {
  try {
    return new TextDecoder().decode(canonicalJsonBytes(envelope as never));
  } catch {
    // A lone surrogate has no canonical encoding, and JSON still spells it as an escape.
    return JSON.stringify(envelope);
  }
}

const OTHER_ENVELOPE_SPELLINGS: readonly ((envelope: SpelledEnvelope) => string)[] = [
  (envelope) => JSON.stringify(envelope, null, 2),
  (envelope) => JSON.stringify({
    signatures: envelope.signatures,
    payload: envelope.payload,
    payloadType: envelope.payloadType,
  }),
  (envelope) => JSON.stringify({ ...envelope, extra: 1 }),
  (envelope) => JSON.stringify({
    ...envelope,
    signatures: envelope.signatures.map((signature) => ({ ...signature, note: "unknown" })),
  }),
  (envelope) => `﻿${canonical(envelope)}`,
  // The first of a repeated member, which JSON.parse drops.
  (envelope) => `{"payloadType":"shadowed",${canonical(envelope).slice(1)}`,
  (envelope) => `${canonical(envelope)}\n`,
  (envelope) => canonical(envelope).replace('"payloadType":"a', '"payloadType":"\\u0061'),
];

const OTHER_PAYLOAD_TYPES = [
  "application/json",
  "application/vnd.jinn.equivalence+json",
  "",
  "ünï",
  "\ud83d",
];

/** One DSSE envelope, mostly signed by `signer`, in one of the spellings above, sometimes damaged. */
export function randomEnvelope(rng: Rng, signer: EnvelopeSigner, stranger: EnvelopeSigner): Uint8Array {
  const payloadType = mostly(rng, DSSE_PAYLOAD_TYPE, OTHER_PAYLOAD_TYPES);
  const payloadBytes = rng.bytes(mostly(rng, 1 + rng.int(47), [0]));
  const preAuthEncoding = dssePreAuthEncoding(payloadType, payloadBytes);
  const signatures = Array.from(
    { length: mostly(rng, 1, [2, 2, 3, 4]) },
    () => randomSignature(rng, preAuthEncoding, signer, stranger),
  );
  const spelling = mostly(rng, standardBase64, OTHER_BASE64_SPELLINGS);
  const spelled = mostly(rng, canonical, OTHER_ENVELOPE_SPELLINGS)({
    payloadType,
    payload: spelling(payloadBytes),
    signatures,
  });
  const bytes = new TextEncoder().encode(spelled);
  if (rng.chance(0.05)) bytes[rng.int(bytes.length)]! ^= 1 << rng.int(8);
  return rng.chance(0.02) ? bytes.slice(0, rng.int(bytes.length)) : bytes;
}

/** Public-key bytes as a publisher might hand them over: right, cut short, extended, or not a key. */
export function randomSpki(rng: Rng, spki: Uint8Array): Uint8Array {
  if (rng.chance(0.85)) return spki;
  switch (rng.int(4)) {
    case 0:
      return spki.slice(0, -1);
    case 1:
      return Uint8Array.of(...spki, 0);
    case 2:
      return rng.bytes(rng.int(64));
    default: {
      const flipped = Uint8Array.from(spki);
      flipped[rng.int(flipped.length)]! ^= 1 << rng.int(8);
      return flipped;
    }
  }
}

/** One signature over bytes the caller already holds, as the evidence-native check receives it. */
export function randomDetachedSignature(rng: Rng, signer: EnvelopeSigner): {
  readonly preAuthEncoding: Uint8Array;
  readonly signature: Uint8Array;
} {
  const preAuthEncoding = rng.bytes(rng.int(64));
  return {
    preAuthEncoding,
    signature: damagedSignature(rng, signer.sign(mostly(rng, preAuthEncoding, [rng.bytes(16)]))),
  };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = "";
  for (; value > 0n; value /= 58n) text = BASE58[Number(value % 58n)] + text;
  return "1".repeat(bytes.findIndex((byte) => byte !== 0)) + text;
}

/** An identifier shaped like a did:key, valid or wrong in one way. */
export function randomDidKey(rng: Rng): string {
  const key = rng.bytes(32);
  const payload = base58(Uint8Array.of(0xed, 0x01, ...key));
  const position = rng.int(payload.length);
  switch (rng.int(14)) {
    case 0:
      return `did:key:z${base58(Uint8Array.of(0xec, 0x01, ...key))}`;
    case 1:
      return `did:key:z${base58(Uint8Array.of(0xed, 0x02, ...key))}`;
    case 2:
      return `did:key:z${base58(Uint8Array.of(0xed, 0x01, ...key.slice(1)))}`;
    case 3:
      return `did:key:z${base58(Uint8Array.of(0xed, 0x01, ...key, 0))}`;
    case 4:
      return `did:key:z${base58(Uint8Array.of(0, 0xed, 0x01, ...key.slice(1)))}`;
    case 5:
      return `did:key:z${payload.slice(0, position)}${rng.pick(["0", "O", "I", "l", "+", "é", "\u{1f600}"])}${payload.slice(position + 1)}`;
    case 6:
      return `did:key:z${payload.slice(0, position)}${payload.slice(position + 1)}`;
    case 7:
      return `did:key:z${payload}${rng.pick([...BASE58])}`;
    case 8:
      return `did:key:z${"1".repeat(rng.int(60))}`;
    case 9:
      return `${rng.pick(["did:web:z", "did:key:", "did:key:Z", "DID:KEY:z", "z", ""])}${payload}`;
    default:
      return `did:key:z${payload}`;
  }
}

type Carried = EvaluateIntegrityAnchorsInput["records"][number];
type Json = Record<string, any>;

const ANCHOR_EDITS: readonly ((rng: Rng, record: Json) => void)[] = [
  (rng, record) => {
    record["provider"] = rng.pick([RFC3161_TSA_ANCHOR_PROFILE, OPENTIMESTAMPS_ANCHOR_PROFILE, "https://example.com/not-implemented"]);
  },
  (rng, record) => {
    record["subject"].kind = rng.pick([RUN_RECORD_KIND, MATRIX_RECORD_KIND, "https://example.com/other-kind"]);
  },
  (rng, record) => {
    record["subject"].digest.sha256 = rng.pick(["1", "2", "3"]).repeat(64);
  },
  (rng, record) => {
    const content = record["proof"].content as string;
    const position = rng.int(content.length);
    record["proof"].content = `${content.slice(0, position)}${rng.pick(["A", "/", "-", "="])}${content.slice(position + 1)}`;
  },
  (_rng, record) => {
    record["unknown"] = true;
  },
];

/** A carried record that still parses as far as the edit lets it, re-sealed so the exact parse is not what refuses it. */
function randomAnchorRecord(rng: Rng, carried: Carried): Carried {
  if (rng.chance(0.7)) return carried;
  const bytes = Uint8Array.from(carried.bytes);
  const record = JSON.parse(new TextDecoder().decode(bytes)) as Json;
  let edited: Uint8Array;
  switch (rng.int(6)) {
    case 0:
      bytes[rng.int(bytes.length)]! ^= 1 << rng.int(8);
      edited = bytes;
      break;
    case 1:
      edited = new TextEncoder().encode(JSON.stringify(record, null, 2));
      break;
    default:
      rng.pick(ANCHOR_EDITS)(rng, record);
      edited = canonicalJsonBytes(record as never);
  }
  return { recordSha256: createHash("sha256").update(edited).digest("hex"), bytes: edited };
}

function shuffled<T>(rng: Rng, items: readonly T[]): readonly T[] {
  const shuffle = [...items];
  for (let index = shuffle.length - 1; index > 0; index -= 1) {
    const other = rng.int(index + 1);
    [shuffle[index], shuffle[other]] = [shuffle[other]!, shuffle[index]!];
  }
  return shuffle;
}

/** One of the corpus's evaluator inputs with its records, instants, subjects, and material varied. */
export function randomAnchorInput(
  rng: Rng,
  inputs: readonly EvaluateIntegrityAnchorsInput[],
): EvaluateIntegrityAnchorsInput {
  const base = rng.pick(inputs);
  const pool = inputs.flatMap(({ records }) => records);
  const records = [
    ...base.records,
    ...Array.from({ length: mostly(rng, 0, [1, 2]) }, () => rng.pick(pool)),
  ].map((record) => randomAnchorRecord(rng, record));
  const trust = mostly(rng, base.trust, [undefined, {}, rng.pick(inputs).trust]);
  const declaredProfiles = mostly(rng, base.declaredProfiles, [
    undefined,
    [],
    [RFC3161_TSA_ANCHOR_PROFILE],
    [OPENTIMESTAMPS_ANCHOR_PROFILE],
    [RFC3161_TSA_ANCHOR_PROFILE, OPENTIMESTAMPS_ANCHOR_PROFILE],
    [OPENTIMESTAMPS_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE],
    [RFC3161_TSA_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE],
    ["https://example.com/never-carried"],
  ]);
  const [runSha256, matrixSha256] = mostly(rng, [base.runSha256, base.matrixSha256], [
    [base.matrixSha256, base.runSha256],
    [base.runSha256, base.runSha256],
  ]);
  return {
    records: shuffled(rng, records),
    runSha256: runSha256!,
    matrixSha256: matrixSha256!,
    closeAt: mostly(rng, base.closeAt, ["2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z", "2026-05-01T12:00:00Z", "not an instant", ""]),
    ...(declaredProfiles === undefined ? {} : { declaredProfiles }),
    ...(trust === undefined ? {} : { trust }),
  };
}
