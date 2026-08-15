// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  type Sha256Digest,
} from "@jinn-network/trust-core";
import { z } from "zod";

import { PrefixedSha256Schema } from "./digests.js";
import { invalidInput } from "./errors.js";
import { CHAIN_OBSERVATION_SCHEMA_ID, COMPOSITE_OBSERVATION_SCHEMA_ID } from "./identifiers.js";

/**
 * Every chain quantity travels as a decimal string. A wei balance or a gas figure past 2^53
 * loses precision as a JSON number, which would change the canonical bytes of an unchanged
 * world between two honest runs.
 */
const QuantitySchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u, "must be a decimal quantity");
const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/u, "must be a lowercase 0x address");
const Word32Schema = z.string().regex(/^0x[0-9a-f]{64}$/u, "must be a lowercase 0x 32-byte word");
const HexBytesSchema = z.string().regex(/^0x(?:[0-9a-f]{2})*$/u, "must be lowercase 0x bytes");

export const LogEntrySchema = z.strictObject({
  address: AddressSchema,
  topics: z.array(Word32Schema),
  data: HexBytesSchema,
});

export const PROBE_RECEIPT_STATUSES = ["success", "reverted", "not-executed"] as const;

export const ProbeOutcomeSchema = z.strictObject({
  id: z.string().min(1),
  /** Digest of the raw signed transaction bytes, when the probe sent one. */
  transactionDigest: PrefixedSha256Schema.optional(),
  receiptStatus: z.enum(PROBE_RECEIPT_STATUSES),
  gasUsed: QuantitySchema,
  /** Ordered. Log order is consensus-observable and part of the claim. */
  logs: z.array(LogEntrySchema),
  returnData: HexBytesSchema,
  /** Negative probes declare the class they expect; both sides are recorded so a divergence
   * names which one moved. */
  expectedErrorClass: z.string().min(1).optional(),
  observedErrorClass: z.string().min(1).optional(),
});
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>;

export const StorageEntrySchema = z.strictObject({
  slot: Word32Schema,
  value: Word32Schema,
});

export const TouchedStateEntrySchema = z.strictObject({
  address: AddressSchema,
  nonce: QuantitySchema,
  balance: QuantitySchema,
  codeHash: Word32Schema,
  storage: z.array(StorageEntrySchema),
});
export type TouchedStateEntry = z.infer<typeof TouchedStateEntrySchema>;

/** One resolved `callResult` / `reportedValue.groundTruth` read (ruling CR6). */
export const StateReadOutcomeSchema = z.strictObject({
  /** CE2's derived key. CE3 re-derives it identically; the equivalence fixture matches the digest. */
  key: z.string().min(1),
  /** Which world the read was executed against. Baseline reads are the pre-replay ground truth
   * the design's `reportedValue` rule depends on; mis-tagging one re-opens the gaming case. */
  state: z.enum(["baseline", "post-replay"]),
  to: AddressSchema,
  /** The exact calldata that was sent -- recorded so a third party can re-issue the call. */
  calldata: HexBytesSchema,
  returnData: HexBytesSchema,
  /** `reverted` is a legitimate observation, not an error: a predicate may expect it. */
  status: z.enum(["success", "reverted"]),
});
export type StateReadOutcome = z.infer<typeof StateReadOutcomeSchema>;

export const BlockCommitmentSchema = z.strictObject({
  number: QuantitySchema,
  hash: Word32Schema,
  stateRoot: Word32Schema,
  timestamp: QuantitySchema,
});

/** Design §5.1 step 7's list, one field per clause. */
export const CanonicalChainObservationSchema = z.strictObject({
  schema: z.literal(CHAIN_OBSERVATION_SCHEMA_ID),
  probes: z.array(ProbeOutcomeSchema),
  touchedState: z.array(TouchedStateEntrySchema),
  /**
   * Resolved structured reads, keyed by CE2's `stateReadKey` (ruling CR6). Sorted by key, so
   * the projection's bytes do not depend on the order the reads were issued. This is what the
   * pure predicate evaluator looks up: a key that differs by one character makes it report
   * `unevaluable` for a read that actually happened.
   */
  stateReads: z.array(StateReadOutcomeSchema),
  traceProjectionDigest: PrefixedSha256Schema,
  /** A state commitment, not a content digest: `0x` + 64 hex, the spelling CE1's record uses
   * for `initialStateCommitment` and the spelling `reset` returns. */
  finalStateCommitment: Word32Schema,
  blocks: z.array(BlockCommitmentSchema),
});
export type CanonicalChainObservation = z.infer<typeof CanonicalChainObservationSchema>;

/** Design §5.1 step 6's information-plane probes, as an observation the K-run comparison
 * covers alongside the chain plane. */
export const InformationPlaneObservationSchema = z.strictObject({
  worlds: z.array(z.strictObject({
    world: PrefixedSha256Schema,
    entries: z.array(z.strictObject({
      requestKey: z.string().min(1),
      responseDigest: PrefixedSha256Schema,
    })),
    /** The permuted-header/query probe of design §4.4: two spellings of one request must
     * resolve to one entry, or the world is not repeat-stable. */
    requestKeyEquivalence: z.enum(["equivalent", "divergent"]),
    missPolicyObservation: z.strictObject({
      requestKey: z.string().min(1),
      responseDigest: PrefixedSha256Schema,
    }),
  })),
  budget: z.strictObject({
    requests: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    enforced: z.boolean(),
  }),
});
export type InformationPlaneObservation = z.infer<typeof InformationPlaneObservationSchema>;

export const CompositeObservationSchema = z.strictObject({
  schema: z.literal(COMPOSITE_OBSERVATION_SCHEMA_ID),
  chain: CanonicalChainObservationSchema,
  information: InformationPlaneObservationSchema,
});
export type CompositeObservation = z.infer<typeof CompositeObservationSchema>;

function parseObservation(value: unknown): CanonicalChainObservation {
  const result = CanonicalChainObservationSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid chain observation at /${first.path.join("/")}: ${first.message}`
        : "Invalid chain observation.",
    );
  }
  return result.data;
}

/**
 * Parses a runtime-supplied observation and puts it in canonical order. Sets (touched state,
 * storage) are sorted by code units; sequences whose order is semantic (probes, logs, blocks)
 * are left exactly as the suite produced them.
 */
export function buildCanonicalChainObservation(value: unknown): CanonicalChainObservation {
  const parsed = parseObservation(value);
  return {
    ...parsed,
    touchedState: [...parsed.touchedState]
      .map((entry) => ({
        ...entry,
        storage: [...entry.storage].sort((left, right) =>
          compareCodeUnitStrings(left.slot, right.slot)),
      }))
      .sort((left, right) => compareCodeUnitStrings(left.address, right.address)),
    stateReads: [...parsed.stateReads]
      .sort((left, right) => compareCodeUnitStrings(left.key, right.key)),
  };
}

/** RFC 8785 bytes of the canonical observation -- the bytes stored through the artifact port
 * and the bytes the digest covers, so a third party can recompute it from what it retrieved. */
export function canonicalChainObservationBytes(
  observation: CanonicalChainObservation,
): Uint8Array {
  return canonicalJsonBytes(parseObservation(observation));
}

export function chainObservationDigest(observation: CanonicalChainObservation): Sha256Digest {
  return recordDigest(canonicalChainObservationBytes(observation));
}

/** Observation equality over the canonical form. Wall time, memory, and every other cost
 * observation stay out of it -- they are recorded, not compared (design §5.3). */
export function chainObservationsEqual(
  left: CanonicalChainObservation,
  right: CanonicalChainObservation,
): boolean {
  return chainObservationDigest(left) === chainObservationDigest(right);
}

export function buildCompositeObservation(value: unknown): CompositeObservation {
  const result = CompositeObservationSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid composite observation at /${first.path.join("/")}: ${first.message}`
        : "Invalid composite observation.",
    );
  }
  return {
    ...result.data,
    chain: buildCanonicalChainObservation(result.data.chain),
  };
}

export function compositeObservationBytes(observation: CompositeObservation): Uint8Array {
  return canonicalJsonBytes(buildCompositeObservation(observation));
}

export function compositeObservationDigest(observation: CompositeObservation): Sha256Digest {
  return recordDigest(compositeObservationBytes(observation));
}
