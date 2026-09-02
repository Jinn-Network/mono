// SPDX-License-Identifier: Apache-2.0

/**
 * `beacon-binding/1` -- binding a sealed run to public randomness that did not exist when it was
 * sealed (issue #2976).
 *
 * Sealing proves a method document predates its publication. It cannot prove the *run* happened
 * after the seal: a party could run privately, write a method describing what already happened,
 * seal it, and re-run. `verify/src/profile/anchor-claims.ts` says as much in the sealed claim's own
 * words -- a time anchor proves "the design's existence by that time and nothing else about the run
 * -- in particular, not that results were produced after it".
 *
 * This procedure closes that gap by deriving a run property from a value that postdates the seal.
 * Where a slate is drawn from a larger pool, the draw is a function of (seal digest, beacon value),
 * so no post-hoc selection is possible: the operator would have had to predict the beacon. Where
 * the slate is a whole census, there is no draw to bind, and the beacon binds only execution
 * ORDER -- a strictly weaker property that this module names as such rather than dressing up.
 *
 * It is the deliberate sibling of `../admission/screening-sample.ts` (`screening-sample/1`) and
 * reuses that procedure's encoding decisions verbatim, including its identity-set digest. The one
 * substantive difference is the HMAC key: `screening-sample/1` keys on a SEALED seed, which is
 * exactly the property #2976 says is insufficient, and this one keys on the seal digest together
 * with a post-seal beacon value. Everything else is deliberately identical so a second implementer
 * who has already built one has nothing new to get wrong.
 *
 * Every encoding choice, restated here so this paragraph alone is reimplementable in any language:
 *
 * - **The HMAC key is `utf8(sealDigest || beaconValue)`.** `sealDigest` enters in its
 *   `sha256:`-prefixed lowercase-hex string form (a fixed 71 characters) and `beaconValue` as its
 *   64 lowercase hex digits. Both are fixed-length, so -- as in `screening-sample/1` -- no
 *   delimiter separates them; a delimiter would only be a second convention to get wrong. Never
 *   raw digest bytes: the whole procedure is text.
 * - **The HMAC message is `utf8(itemSha256)`**, the same `sha256:`-prefixed lowercase-hex form.
 * - **The order is ascending over the 32 unsigned HMAC-SHA256 bytes**, ties broken by `itemSha256`
 *   in code-unit order. This is `compareScreeningStreamEntries`, shared rather than re-derived.
 * - **`poolDigest` binds the identity SET**: `sha256:` followed by the SHA-256 of the canonical-JSON
 *   bytes of the `itemSha256` values, code-unit sorted and unique. This is
 *   `computeScreeningPoolDigest`, shared for the same reason.
 * - **The sample is the first `sampleSize` of that order.** In census mode there is no sample and
 *   the order itself is the execution order.
 *
 * The beacon's postdating is checked, not assumed, and how strongly it can be checked depends on
 * the source. A drand round number maps to a time by published chain parameters
 * (`genesis + (round - 1) * period`), so "this value did not exist at seal time" is arithmetic any
 * reader does offline. A Bitcoin height does not: block times need headers, so that check is
 * attributive and this module says so instead of claiming an offline proof it cannot make.
 *
 * Postdating alone would still leave the operator a choice, and issue #3322 closes it: admitting any
 * round later than the seal makes the VALUE unpredictable but not WHICH realized value applies, so
 * an operator could watch the rounds published between lock and launch and bind the one whose
 * derivation they preferred. For a scheduled source the seal already names one round --
 * `requiredBeaconRound`, the first published strictly after it -- so the commitment needs no
 * separate record, the producer refuses any other round, and `roundBasis` reports which of the two
 * situations a record is in so the report face can say only what is true of it.
 *
 * The SOURCE choice survived that, and issue #3426 closes it on the same terms. It was never a swap
 * between equally constrained beacons: `bitcoin/mainnet` is `attributive-height`, so no round
 * follows from a seal for it and the postdating refusal below is never reached on that branch --
 * leaving the round rule one source selection away from having no effect. So the sealed record names
 * the beacon the run will bind to, `declaredSource` restates that naming inside the binding, the
 * producer refuses a binding naming any other source, and `sourceBasis` reports which of the two
 * situations a record is in.
 *
 * This module does no filesystem or network I/O and throws `RunBindingError` on any invalid input.
 */

import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  compareScreeningStreamEntries,
  computeScreeningPoolDigest,
  type ScreeningStreamEntry,
} from "../admission/screening-sample.js";

/** The procedure identifier a binding record must carry. */
export const BEACON_BINDING_PROCEDURE = "beacon-binding/1" as const;

/**
 * How strongly a source's own round index proves that its value postdates a given instant.
 *
 * `deterministic-round-time` sources index rounds by a published arithmetic schedule, so the
 * proof is offline arithmetic. `attributive-height` sources index by block height, whose time
 * needs headers the reader must obtain separately -- the claim is then what the chain asserts,
 * checked elsewhere, and never an offline proof.
 */
export type BeaconSourceTimeBasis = "deterministic-round-time" | "attributive-height";

export interface BeaconSourceDefinition {
  readonly timeBasis: BeaconSourceTimeBasis;
  /** Unix seconds of round 1. Present only on `deterministic-round-time` sources. */
  readonly genesisTimeSeconds?: number;
  /** Seconds between rounds. Present only on `deterministic-round-time` sources. */
  readonly periodSeconds?: number;
  /** Reader-facing name used by the report face. */
  readonly displayName: string;
}

/**
 * The beacons this procedure admits. Values are the sources' own published chain parameters and
 * are part of the derivation: a reader recomputing `beaconRoundInstant` needs exactly these
 * numbers, so they live in the code rather than in a comment.
 */
export const BEACON_SOURCES = {
  "drand/quicknet": {
    timeBasis: "deterministic-round-time",
    genesisTimeSeconds: 1692803367,
    periodSeconds: 3,
    displayName: "drand quicknet",
  },
  "drand/default": {
    timeBasis: "deterministic-round-time",
    genesisTimeSeconds: 1595431050,
    periodSeconds: 30,
    displayName: "drand default chain",
  },
  "bitcoin/mainnet": {
    timeBasis: "attributive-height",
    displayName: "Bitcoin mainnet",
  },
} as const satisfies Record<string, BeaconSourceDefinition>;

export type BeaconSourceId = keyof typeof BEACON_SOURCES;

export const BEACON_SOURCE_IDS = Object.keys(BEACON_SOURCES).sort() as readonly BeaconSourceId[];

/**
 * A schema-level sanity ceiling on a round index. Not a beacon limit, and deliberately not the
 * representability guarantee either: the ceiling that matters is per-source, because it falls out
 * of each source's own period, and one shared number cannot be sound for all of them. Quicknet's
 * 3-second period puts round 1,000,000,000,000 some 95,000 years out and inside what `Date`
 * represents; the default chain's 30-second period puts the same round ten times further out and
 * outside it. So this bound only rejects the absurd, and `beaconRoundInstant` -- not the schema --
 * owns the guarantee that the arithmetic stays representable. Every real Bitcoin height is eight
 * orders of magnitude below this.
 */
export const MAX_BEACON_ROUND = 1_000_000_000_000;

/**
 * The widest instant `Date` represents, in milliseconds either side of the epoch (ECMA-262:
 * 8.64e15). Beyond it `toISOString` throws an untyped `RangeError`, which is what
 * `beaconRoundInstant` refuses on this module's own terms instead.
 */
const MAX_REPRESENTABLE_TIME_MS = 8_640_000_000_000_000;

const HexValueSchema = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must match ^sha256:[0-9a-f]{64}$");
const InstantSchema = z.string().datetime({ offset: true });

/**
 * The admitted-source registry as a schema: exactly the ids of `BEACON_SOURCES`, nothing wider.
 * Exported on its own because the source is named in two places that are not this record -- the
 * draft spec that declares it before the lock and the sealed Run extension that carries it -- and
 * both validate against this one enum rather than against a second list free to drift from the
 * registry the derivation actually reads.
 */
export const BeaconSourceIdSchema = z.enum(
  Object.keys(BEACON_SOURCES) as [BeaconSourceId, ...BeaconSourceId[]],
);

/**
 * A public beacon reference: which beacon, which round or height, and the value it published
 * there. `round` is the source's own index -- a drand round number, a Bitcoin block height.
 */
export const BeaconReferenceSchema = z.strictObject({
  source: BeaconSourceIdSchema,
  round: z.number().int().positive().max(MAX_BEACON_ROUND),
  value: HexValueSchema,
});
export type BeaconReference = z.infer<typeof BeaconReferenceSchema>;

const CommonBindingFields = {
  procedure: z.literal(BEACON_BINDING_PROCEDURE),
  /** The digest of the sealed record this binding postdates -- the run's own seal. */
  sealDigest: DigestSchema,
  /** When that seal was taken. The beacon must postdate it. */
  sealedAt: InstantSchema,
  /**
   * The beacon source the SEALED record named (issue #3426), restated here the way `sealedAt` is
   * restated: this record must be checkable on its own, and a reader who also holds the sealed Run
   * checks the restatement against it (`beacon-source/v1`).
   *
   * Optional, because absence is a real and historical state: a run that declared no source left
   * the beacon to the operator, and every record sealed before this field existed is exactly that
   * run. Absence is reported as `operator-chosen`, never defaulted to a source.
   */
  declaredSource: BeaconSourceIdSchema.optional(),
  beacon: BeaconReferenceSchema,
} as const;

/**
 * The two shapes, disjoint by construction so no reader can mistake the weaker binding for the
 * stronger one:
 *
 * - `sampled` -- a slate drawn from a larger pool. `sample` is the claim; the verifier recomputes
 *   it and fails on mismatch.
 * - `census` -- the whole declared population runs, so there is no draw. `order` is the claim, and
 *   it binds execution order only.
 */
export const RunBindingSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    ...CommonBindingFields,
    mode: z.literal("sampled"),
    /** The pool the slate was drawn from. Order is irrelevant; the identity set is what binds. */
    poolItemSha256s: z.array(DigestSchema).min(1),
    sampleSize: z.number().int().positive(),
    /** The drawn slate, in derived order. */
    sample: z.array(DigestSchema).min(1),
  }),
  z.strictObject({
    ...CommonBindingFields,
    mode: z.literal("census"),
    /** The whole population. Order is irrelevant here; `order` below is the derived claim. */
    itemSha256s: z.array(DigestSchema).min(1),
    /** Every item, in beacon-derived execution order. */
    order: z.array(DigestSchema).min(1),
  }),
]);
export type RunBinding = z.infer<typeof RunBindingSchema>;

export class RunBindingError extends Error {
  override readonly name = "RunBindingError";
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.path = path;
  }
}

function fail(path: string, detail: string): never {
  throw new RunBindingError(path, detail);
}

/**
 * The instant a `deterministic-round-time` beacon published `round`, as an RFC 3339 UTC string, or
 * `undefined` for a source whose round index carries no offline time. The schedule is
 * `genesis + (round - 1) * period`: round 1 is published at genesis.
 *
 * Refuses (throws `RunBindingError`) when that instant falls outside the range `Date` represents.
 * The check lives here rather than on the schema because the largest representable round is a
 * function of the source's own period -- the default chain runs out ten times earlier than
 * quicknet does -- so a single schema ceiling would leave the slower source's tail passing
 * validation and then throwing an untyped `RangeError` from `toISOString` deep inside
 * verification. Guarding the arithmetic where the arithmetic happens makes the typed refusal a
 * property of this function, and therefore true for every source and every caller.
 */
export function beaconRoundInstant(beacon: Pick<BeaconReference, "source" | "round">): string | undefined {
  const source = BEACON_SOURCES[beacon.source];
  if (source.timeBasis !== "deterministic-round-time") return undefined;
  const { genesisTimeSeconds, periodSeconds } = source as BeaconSourceDefinition & {
    readonly genesisTimeSeconds: number;
    readonly periodSeconds: number;
  };
  const instantMs = (genesisTimeSeconds + (beacon.round - 1) * periodSeconds) * 1000;
  if (!Number.isFinite(instantMs) || Math.abs(instantMs) > MAX_REPRESENTABLE_TIME_MS) {
    fail(
      "beacon.round",
      `${source.displayName} round ${beacon.round} is scheduled outside the range a timestamp can `
      + "represent, so its publication instant cannot be computed",
    );
  }
  return new Date(instantMs).toISOString();
}

/** The one round a run sealed at a given instant may bind to, and when that round is published. */
export interface RequiredBeaconRound {
  readonly round: number;
  /** RFC 3339 UTC, from the source's own schedule -- the same arithmetic `beaconRoundInstant` does. */
  readonly publishedAt: string;
}

/**
 * The one round a run sealed at `sealedAt` may bind to on a `deterministic-round-time` source: the
 * first round that source publishes STRICTLY after the seal (issue #3322).
 *
 * The point is that the seal already fixes it. `verifyRunBinding` admits any round whose instant
 * postdates the seal, which makes the beacon VALUE unpredictable but leaves the CHOICE among
 * realized values open: between seal and binding an operator sees many published rounds, can derive
 * what each would produce, and can bind the one they prefer. The standard construction is to commit
 * at seal time to a specific future round -- and for a scheduled source no separate commitment
 * record is needed, because `(source, sealedAt)` already determines exactly one such round, and both
 * are fixed at seal time and carried by the binding itself.
 *
 * From `instant(r) = genesis + (r - 1) * period`, the smallest `r` with `instant(r) > sealedAt` is
 * `floor((sealedAt - genesis) / period) + 2`, clamped to round 1 for a seal that predates genesis.
 *
 * `undefined` -- meaning no round is derivable, so the operator's choice remains and the report face
 * says so -- when the source indexes by block height rather than by a schedule, when `sealedAt` is
 * unparseable, or when the required round leaves `MAX_BEACON_ROUND` or the representable range.
 */
export function requiredBeaconRound(
  source: BeaconSourceId,
  sealedAt: string,
): RequiredBeaconRound | undefined {
  const definition = BEACON_SOURCES[source];
  if (definition.timeBasis !== "deterministic-round-time") return undefined;
  const { genesisTimeSeconds, periodSeconds } = definition as BeaconSourceDefinition & {
    readonly genesisTimeSeconds: number;
    readonly periodSeconds: number;
  };
  const sealedAtMs = Date.parse(sealedAt);
  if (!Number.isFinite(sealedAtMs)) return undefined;
  const round = Math.max(
    1,
    Math.floor((sealedAtMs - genesisTimeSeconds * 1000) / (periodSeconds * 1000)) + 2,
  );
  if (!Number.isSafeInteger(round) || round > MAX_BEACON_ROUND) return undefined;
  // `beaconRoundInstant` owns the representability refusal; a round derived from a real seal is
  // within one period of it, so this only ever throws on an input `Date` itself cannot represent.
  let publishedAt: string | undefined;
  try {
    publishedAt = beaconRoundInstant({ source, round });
  } catch {
    return undefined;
  }
  return publishedAt === undefined ? undefined : { round, publishedAt };
}

export interface BeaconOrderParams {
  /** `sha256:<64 lowercase hex>` -- the sealed record the beacon postdates. */
  readonly sealDigest: string;
  /** The beacon's published value, 64 lowercase hex characters. */
  readonly beaconValue: string;
  /** The identity set to order. Non-empty, unique, each `sha256:<64 lowercase hex>`. */
  readonly itemSha256s: readonly string[];
}

export interface BeaconOrderResult {
  /** `sha256:<64 lowercase hex>` of the sorted, unique identity set. */
  readonly poolDigest: string;
  /** Every item, ascending by HMAC stream (unsigned byte order), ties by code-unit order. */
  readonly order: readonly string[];
}

/**
 * The derivation itself. Refuses (throws `RunBindingError`) when `sealDigest` or `beaconValue` is
 * malformed, or when `itemSha256s` is empty, contains a duplicate, or contains a malformed entry.
 */
export function computeBeaconOrder(params: BeaconOrderParams): BeaconOrderResult {
  const { sealDigest, beaconValue, itemSha256s } = params;

  if (!DigestSchema.safeParse(sealDigest).success) {
    fail("sealDigest", `must match ^sha256:[0-9a-f]{64}$, got ${JSON.stringify(sealDigest)}`);
  }
  if (!HexValueSchema.safeParse(beaconValue).success) {
    fail("beaconValue", `must be 64 lowercase hex characters, got ${JSON.stringify(beaconValue)}`);
  }
  itemSha256s.forEach((itemSha256, index) => {
    if (!DigestSchema.safeParse(itemSha256).success) {
      fail(`itemSha256s[${index}]`, `must match ^sha256:[0-9a-f]{64}$, got ${JSON.stringify(itemSha256)}`);
    }
  });
  if (itemSha256s.length === 0) fail("itemSha256s", "identity set must be non-empty");
  if (new Set(itemSha256s).size !== itemSha256s.length) {
    fail("itemSha256s", "identity set must not contain duplicate itemSha256 values");
  }

  const key = Buffer.from(`${sealDigest}${beaconValue}`, "utf8");
  const entries: ScreeningStreamEntry[] = itemSha256s.map((itemSha256) => ({
    itemSha256,
    stream: new Uint8Array(createHmac("sha256", key).update(Buffer.from(itemSha256, "utf8")).digest()),
  }));

  return {
    poolDigest: computeScreeningPoolDigest(itemSha256s),
    order: [...entries].sort(compareScreeningStreamEntries).map((entry) => entry.itemSha256),
  };
}

/** Whether the beacon's postdating of the seal was proven here, or only asserted by its chain. */
export type BeaconPostSealBasis = "proven-offline" | "attributive";

/**
 * Whether the seal fixed WHICH post-seal value applied, or the operator picked it (issue #3322).
 *
 * `seal-derived` -- the named round is `requiredBeaconRound` for this source and seal, so there was
 * exactly one round to bind to and no choosing happened. `operator-chosen` -- the round postdates
 * the seal (that is still checked) but was selected afterwards from among those published since, so
 * the derivation is one of several the operator could have realized. Every `attributive-height`
 * source is `operator-chosen` by construction: a block height carries no schedule, so no round
 * follows from the seal.
 *
 * This is derived and reported, never enforced here. A verifier states what the bytes are; the
 * choosing happens in the producer, which is where the refusal belongs (`bind` refuses a round other
 * than the derivable one). Refusing here would also make every already-sealed record unreadable.
 */
export type BeaconRoundBasis = "seal-derived" | "operator-chosen";

/**
 * Whether the seal fixed WHICH BEACON applied, or the operator picked it (issue #3426).
 *
 * `seal-declared` -- the record RESTATES a source the sealed Run named, so the binding had one
 * beacon available and `bind` refuses a binding naming any other. `operator-chosen` -- the record
 * declares no source, so the operator selected one from the admitted set after sealing.
 *
 * "Restates" is exact, and is the same standing the record's `sealedAt` and `sealDigest` have: this
 * function never sees the Run, so it can check only that the restatement agrees with the beacon the
 * binding itself names. Whether it agrees with the RUN is a separate check, made by whoever holds
 * the sealed record -- `core/src/binding/carriage.ts` workspace-side, and step 2c of
 * `EXTERNAL-VERIFICATION.md` for an external reader. Without that check a restatement is only a
 * claim, and a face keyed on it says more than these bytes establish.
 *
 * The source residue is not a swap between equals, which is why it needed closing rather than only
 * reporting: `bitcoin/mainnet` is `attributive-height`, so `requiredBeaconRound` derives nothing for
 * it and `beaconRoundInstant` returns `undefined`, which means the postdating refusal in
 * `verifyRunBinding` is never reached on that branch. Under `operator-chosen` the round rule is
 * therefore one source selection away from having no effect at all.
 *
 * Like {@link BeaconRoundBasis} this is derived and reported here, never enforced: a verifier states
 * what the bytes are, and refusing an undeclared source would make every already-sealed record
 * unreadable. The refusal belongs to the producer, and `bind` makes it.
 */
export type BeaconSourceBasis = "seal-declared" | "operator-chosen";

/** What every verified binding carries, whichever mode produced it. */
export interface VerifiedRunBindingBase {
  readonly procedure: typeof BEACON_BINDING_PROCEDURE;
  readonly beacon: BeaconReference;
  readonly sealDigest: string;
  readonly sealedAt: string;
  /** The recomputed identity-set digest of the pool (sampled) or population (census). */
  readonly poolDigest: string;
  readonly poolSize: number;
  /** The recomputed full order. In census mode this is the execution order. */
  readonly order: readonly string[];
  readonly postSeal: BeaconPostSealBasis;
  /** Whether the seal fixed which post-seal round applied, or the operator chose it. */
  readonly roundBasis: BeaconRoundBasis;
  /** Whether the seal fixed which beacon applied, or the operator chose it. */
  readonly sourceBasis: BeaconSourceBasis;
  /** The source the sealed record named, present exactly when it named one. */
  readonly declaredSource?: BeaconSourceId;
  /** The beacon's own publication instant, when its source's round index determines one. */
  readonly beaconInstant?: string;
}

/**
 * Discriminated on `mode` so `sample` is present exactly when there was a draw. A single optional
 * `sample` would make every reader of the stronger binding write a fallback for a case that cannot
 * happen, and the fallback is where a "0 items" sentence gets shipped.
 */
export type VerifiedRunBinding =
  | (VerifiedRunBindingBase & { readonly mode: "census" })
  | (VerifiedRunBindingBase & { readonly mode: "sampled"; readonly sample: readonly string[] });

/**
 * Verifies one binding record: the beacon postdates the seal, and the declared draw or order is
 * exactly what `beacon-binding/1` derives. Throws `RunBindingError` on any disagreement -- the
 * recomputation wins, always; a stored field never does.
 */
export function verifyRunBinding(candidate: unknown): VerifiedRunBinding {
  const parsed = RunBindingSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    fail(issue.path.length === 0 ? "binding" : issue.path.join("."), issue.message);
  }
  const binding = parsed.data;

  const sealedAtMs = Date.parse(binding.sealedAt);
  const beaconInstant = beaconRoundInstant(binding.beacon);
  let postSeal: BeaconPostSealBasis;
  if (beaconInstant === undefined) {
    postSeal = "attributive";
  } else {
    if (Date.parse(beaconInstant) <= sealedAtMs) {
      fail(
        "beacon.round",
        `${BEACON_SOURCES[binding.beacon.source].displayName} round ${binding.beacon.round} was published at `
        + `${beaconInstant}, which does not postdate the seal at ${binding.sealedAt} — a beacon that existed at `
        + "seal time binds nothing",
      );
    }
    postSeal = "proven-offline";
  }

  const pool = binding.mode === "sampled" ? binding.poolItemSha256s : binding.itemSha256s;
  const derived = computeBeaconOrder({
    sealDigest: binding.sealDigest,
    beaconValue: binding.beacon.value,
    itemSha256s: pool,
  });

  // A record that restates a declaration contradicting its own beacon is refused rather than
  // reported: the two fields would name two different runs' worth of intent, and no reading of the
  // bytes is honest. The restatement's agreement with the SEALED record is checked by the reader
  // who holds it (workspace-side: `core/src/binding/carriage.ts`).
  if (binding.declaredSource !== undefined && binding.declaredSource !== binding.beacon.source) {
    fail(
      "declaredSource",
      `the sealed record named ${BEACON_SOURCES[binding.declaredSource].displayName} as this run's beacon, but `
      + `this binding names ${BEACON_SOURCES[binding.beacon.source].displayName} — a declared source the binding `
      + "does not use fixes nothing",
    );
  }

  const required = requiredBeaconRound(binding.beacon.source, binding.sealedAt);
  const roundBasis: BeaconRoundBasis = required !== undefined && required.round === binding.beacon.round
    ? "seal-derived"
    : "operator-chosen";

  const common = {
    procedure: BEACON_BINDING_PROCEDURE,
    beacon: binding.beacon,
    sealDigest: binding.sealDigest,
    sealedAt: binding.sealedAt,
    poolDigest: derived.poolDigest,
    poolSize: pool.length,
    order: derived.order,
    postSeal,
    roundBasis,
    sourceBasis: binding.declaredSource === undefined
      ? ("operator-chosen" as const)
      : ("seal-declared" as const),
    ...(binding.declaredSource === undefined ? {} : { declaredSource: binding.declaredSource }),
    ...(beaconInstant === undefined ? {} : { beaconInstant }),
  } as const;

  if (binding.mode === "census") {
    if (!sameSequence(binding.order, derived.order)) {
      fail("order", "declared execution order differs from the beacon-binding/1 recomputation");
    }
    return { ...common, mode: "census" };
  }

  if (binding.sampleSize > pool.length) {
    fail("sampleSize", `must not exceed the pool size (${pool.length}), got ${binding.sampleSize}`);
  }
  const sample = derived.order.slice(0, binding.sampleSize);
  if (!sameSequence(binding.sample, sample)) {
    fail("sample", "declared sample differs from the beacon-binding/1 recomputation");
  }
  return { ...common, mode: "sampled", sample };
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
