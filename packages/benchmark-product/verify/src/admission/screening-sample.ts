// SPDX-License-Identifier: Apache-2.0

/**
 * `screening-sample/1` -- the verifier's independent recomputation of binary-judgment human-review
 * sample membership (judge-path program packet P6, spec
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §6.5 "(1) Sample membership").
 *
 * The verifier does not execute the operator's sealed sampling script; it recomputes membership
 * from this specified procedure instead, and the recomputation wins on disagreement. That only
 * works if the procedure is reimplementable in any language from the spec paragraph alone (R-4), so
 * every encoding choice below is spelled out rather than left to convention:
 *
 * - **`poolDigest` binds the row *identity* set, never the rows.** It is `sha256:` followed by the
 *   64 lowercase hex digits of the SHA-256 of the canonical-JSON bytes of the `itemSha256` values
 *   alone, code-unit sorted and unique -- not the rows themselves. Binding the rows is circular and
 *   uncomputable: a row carries `handChecked`, which rows carry it depends on the sample, and the
 *   sample depends on the digest. Binding the identity set breaks the cycle, because `itemSha256` is
 *   exactly the part of a row hand-checking never touches.
 * - **The key is text, not raw digest bytes.** The HMAC key is `utf8(sampleSeed || poolDigest)`,
 *   where `poolDigest` enters in its `sha256:`-prefixed lowercase-hex string form -- the exact
 *   64-hex-digit string, concatenated onto `sampleSeed`, then UTF-8 encoded. Keying on the digest's
 *   32 raw bytes instead would introduce the only binary-versus-text distinction in an otherwise
 *   all-text procedure, which is exactly the kind of thing a second implementer gets wrong.
 * - **No delimiter separates `sampleSeed` and `poolDigest`.** `poolDigest` is a fixed 71-character
 *   suffix (`sha256:` + 64 hex digits), so a delimiter would just be a second convention to get
 *   wrong.
 * - **The HMAC message is `utf8(itemSha256)`**, the same `sha256:`-prefixed lowercase-hex string
 *   used everywhere else in the spec -- never raw digest bytes.
 * - **Stream comparison is over 32 *unsigned* bytes.** `Uint8Array` elements are unsigned by
 *   construction in JavaScript (0-255), so a plain per-element numeric comparison is correct; the
 *   classic bug is reading the same bytes through a signed 8-bit view (where 0x80 becomes -128)
 *   or via a hex-string shortcut that doesn't preserve this. Ties are broken by `itemSha256` in
 *   code-unit order (never `localeCompare`, which is locale-dependent).
 *
 * This module does no filesystem or network I/O, throws `ScreeningSampleError` on any invalid
 * input, and owns exactly its own input validity -- not the four other §6.5 checks (coverage,
 * required hand checks, agreement rate, per-row admission), which read the recomputed sample but
 * live elsewhere in this package.
 */

import { createHash, createHmac } from "node:crypto";
import { canonicalJsonBytes, compareCodeUnitStrings } from "@jinn-network/task-execution-profiles";

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class ScreeningSampleError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "ScreeningSampleError";
    this.path = path;
  }
}

function fail(path: string, detail: string): never {
  throw new ScreeningSampleError(path, detail);
}

export interface ScreeningSampleParams {
  /** The table's `itemSha256` values -- the row identity set. Order is irrelevant; see R-4. */
  readonly itemSha256s: readonly string[];
  /** Non-empty seed string. Enters the HMAC key as literal UTF-8 text, concatenated with `poolDigest`. */
  readonly sampleSeed: string;
  /** Positive integer, `<= itemSha256s.length`. The sample is the first `sampleSize` of the full order. */
  readonly sampleSize: number;
}

export interface ScreeningSampleResult {
  /** `sha256:<64 lowercase hex>` -- the digest of the sorted, unique identity set alone. */
  readonly poolDigest: string;
  /** Every `itemSha256` in the pool, ascending by HMAC stream (unsigned byte order), ties by code-unit order. */
  readonly order: readonly string[];
  /** `order.slice(0, sampleSize)`. */
  readonly sample: readonly string[];
}

/**
 * One entry in the HMAC-stream ordering: the value actually compared (`stream`) paired with the
 * tie-break key (`itemSha256`). Exported so the sort itself is directly testable -- a real
 * HMAC-SHA256 collision cannot be constructed to exercise the tie-break in an end-to-end call.
 */
export interface ScreeningStreamEntry {
  readonly itemSha256: string;
  readonly stream: Uint8Array;
}

/**
 * `stream` compared as 32 unsigned bytes ascending; ties broken by `itemSha256` code-unit order.
 * `Uint8Array` indexing always yields an unsigned 0-255 number in JavaScript, so a direct numeric
 * subtraction per element is already the unsigned comparison -- no bit-masking is needed, but it
 * must not be replaced by a signed-view read (e.g. `Int8Array`) or by comparing a hex rendering.
 */
export function compareScreeningStreamEntries(left: ScreeningStreamEntry, right: ScreeningStreamEntry): number {
  const length = Math.min(left.stream.length, right.stream.length);
  for (let index = 0; index < length; index += 1) {
    const delta = left.stream[index]! - right.stream[index]!;
    if (delta !== 0) return delta;
  }
  if (left.stream.length !== right.stream.length) return left.stream.length - right.stream.length;
  return compareCodeUnitStrings(left.itemSha256, right.itemSha256);
}

/**
 * `sha256:` followed by the 64 lowercase hex digits of the SHA-256 of the canonical-JSON bytes of
 * `itemSha256s`, code-unit sorted first so the digest does not depend on input order. Does not
 * validate its input; `computeScreeningSample` owns that. Exported because the spec names
 * `poolDigest` directly and a cross-language implementer will want to check it in isolation.
 */
export function computeScreeningPoolDigest(itemSha256s: readonly string[]): string {
  const sorted = [...itemSha256s].sort(compareCodeUnitStrings);
  const bytes = canonicalJsonBytes(sorted);
  const hex = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Procedure `screening-sample/1` (§6.5). Refuses (throws `ScreeningSampleError`) when:
 * - `itemSha256s` is empty, contains a duplicate, or contains an entry not matching
 *   `^sha256:[0-9a-f]{64}$`;
 * - `sampleSeed` is empty;
 * - `sampleSize` is not a positive integer, or exceeds `itemSha256s.length`.
 */
export function computeScreeningSample(params: ScreeningSampleParams): ScreeningSampleResult {
  const { itemSha256s, sampleSeed, sampleSize } = params;

  itemSha256s.forEach((itemSha256, index) => {
    if (!SHA256_DIGEST_PATTERN.test(itemSha256)) {
      fail(`itemSha256s[${index}]`, `must match ^sha256:[0-9a-f]{64}$, got ${JSON.stringify(itemSha256)}`);
    }
  });

  if (itemSha256s.length === 0) fail("itemSha256s", "identity set must be non-empty");

  if (new Set(itemSha256s).size !== itemSha256s.length) {
    fail("itemSha256s", "identity set must not contain duplicate itemSha256 values");
  }

  if (sampleSeed.length === 0) fail("sampleSeed", "must be non-empty");

  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    fail("sampleSize", `must be a positive integer, got ${JSON.stringify(sampleSize)}`);
  }

  if (sampleSize > itemSha256s.length) {
    fail("sampleSize", `must not exceed the pool size (${itemSha256s.length}), got ${sampleSize}`);
  }

  const poolDigest = computeScreeningPoolDigest(itemSha256s);
  const key = Buffer.from(`${sampleSeed}${poolDigest}`, "utf8");

  const entries: ScreeningStreamEntry[] = itemSha256s.map((itemSha256) => ({
    itemSha256,
    stream: new Uint8Array(createHmac("sha256", key).update(Buffer.from(itemSha256, "utf8")).digest()),
  }));

  const order = [...entries].sort(compareScreeningStreamEntries).map((entry) => entry.itemSha256);

  return {
    poolDigest,
    order,
    sample: order.slice(0, sampleSize),
  };
}
