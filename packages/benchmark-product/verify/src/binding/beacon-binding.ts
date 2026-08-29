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

const HexValueSchema = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must match ^sha256:[0-9a-f]{64}$");
const InstantSchema = z.string().datetime({ offset: true });

/**
 * A public beacon reference: which beacon, which round or height, and the value it published
 * there. `round` is the source's own index -- a drand round number, a Bitcoin block height.
 */
export const BeaconReferenceSchema = z.strictObject({
  source: z.enum(Object.keys(BEACON_SOURCES) as [BeaconSourceId, ...BeaconSourceId[]]),
  round: z.number().int().positive(),
  value: HexValueSchema,
});
export type BeaconReference = z.infer<typeof BeaconReferenceSchema>;

const CommonBindingFields = {
  procedure: z.literal(BEACON_BINDING_PROCEDURE),
  /** The digest of the sealed record this binding postdates -- the run's own seal. */
  sealDigest: DigestSchema,
  /** When that seal was taken. The beacon must postdate it. */
  sealedAt: InstantSchema,
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
 */
export function beaconRoundInstant(beacon: BeaconReference): string | undefined {
  const source = BEACON_SOURCES[beacon.source];
  if (source.timeBasis !== "deterministic-round-time") return undefined;
  const { genesisTimeSeconds, periodSeconds } = source as BeaconSourceDefinition & {
    readonly genesisTimeSeconds: number;
    readonly periodSeconds: number;
  };
  return new Date((genesisTimeSeconds + (beacon.round - 1) * periodSeconds) * 1000).toISOString();
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

export interface VerifiedRunBinding {
  readonly procedure: typeof BEACON_BINDING_PROCEDURE;
  readonly mode: RunBinding["mode"];
  readonly beacon: BeaconReference;
  readonly sealDigest: string;
  readonly sealedAt: string;
  /** The recomputed identity-set digest of the pool (sampled) or population (census). */
  readonly poolDigest: string;
  readonly poolSize: number;
  /** The recomputed full order. In census mode this is the execution order. */
  readonly order: readonly string[];
  /** The recomputed slate. Present in `sampled` mode only. */
  readonly sample?: readonly string[];
  readonly postSeal: BeaconPostSealBasis;
  /** The beacon's own publication instant, when its source's round index determines one. */
  readonly beaconInstant?: string;
}

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

  const common = {
    procedure: BEACON_BINDING_PROCEDURE,
    mode: binding.mode,
    beacon: binding.beacon,
    sealDigest: binding.sealDigest,
    sealedAt: binding.sealedAt,
    poolDigest: derived.poolDigest,
    poolSize: pool.length,
    order: derived.order,
    postSeal,
    ...(beaconInstant === undefined ? {} : { beaconInstant }),
  } as const;

  if (binding.mode === "census") {
    if (!sameSequence(binding.order, derived.order)) {
      fail("order", "declared execution order differs from the beacon-binding/1 recomputation");
    }
    return common;
  }

  if (binding.sampleSize > pool.length) {
    fail("sampleSize", `must not exceed the pool size (${pool.length}), got ${binding.sampleSize}`);
  }
  const sample = derived.order.slice(0, binding.sampleSize);
  if (!sameSequence(binding.sample, sample)) {
    fail("sample", "declared sample differs from the beacon-binding/1 recomputation");
  }
  return { ...common, sample };
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
