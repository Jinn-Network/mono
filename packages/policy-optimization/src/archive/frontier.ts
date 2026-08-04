// SPDX-License-Identifier: MIT

/**
 * The frontier (product design §8.3): the quality / cost / latency **non-dominated set**.
 *
 * > frontier membership (quality / cost / latency non-dominated set — a *set*, deliberately not a
 * > leaderboard). Re-derivable; never authoritative; never published as a ranking.
 *
 * The return type is a `ReadonlySet`, and that is the point rather than a convenience. §14 forbids
 * a leaderboard and a ranking record outright, and an array has an order — the first person to
 * read one would take position 0 for "best", and they would not be being unreasonable. A set has
 * no first element to misread. Where bytes are needed (the derived projection, the CLI) the
 * members are sorted **by digest**, which is deliberately meaningless as a quality ordering.
 *
 * No statistic is computed here (program ruling R3). Domination is a pairwise exact-decimal
 * comparison — selection, not estimation. Nothing is scalarized, weighted, or normalized, because
 * every one of those operations would be the product inventing a measurement the Reports never
 * claimed.
 */

import { compareExactDecimals } from "../allocation.js";
import { refuse } from "../errors.js";
import type { FrontierDimension, FrontierEntry } from "./types.js";

/**
 * Is `left` at least as good as `right` on this dimension, and is it strictly better?
 *
 * `undefined` on a value neither side can order. An unorderable comparison is not a tie: treating
 * it as one would make membership depend on which unorderable value happened to be on the left.
 */
function compareOn(
  dimension: FrontierDimension,
  left: string,
  right: string,
): -1 | 0 | 1 | undefined {
  const ordered = compareExactDecimals(left, right);
  if (ordered === undefined) return undefined;
  if (ordered === 0) return 0;
  const better = dimension.direction === "maximize" ? 1 : -1;
  return ordered === better ? 1 : -1;
}

function valueOf(entry: FrontierEntry, dimension: FrontierDimension): string {
  const value = entry.values[dimension.key];
  if (typeof value !== "string") {
    refuse("archive-derivation", `${entry.tupleDigest}.values.${dimension.key}`,
      `no value on declared dimension ${dimension.key}; an entry that cannot be placed on every dimension cannot be placed on the frontier`);
  }
  return value;
}

/** Does `left` dominate `right` — at least as good everywhere, strictly better somewhere? */
function dominates(
  left: FrontierEntry,
  right: FrontierEntry,
  dimensions: readonly FrontierDimension[],
): boolean {
  let strictlyBetterSomewhere = false;
  for (const dimension of dimensions) {
    const ordered = compareOn(dimension, valueOf(left, dimension), valueOf(right, dimension));
    if (ordered === undefined) {
      refuse("archive-derivation", `values.${dimension.key}`,
        `${left.values[dimension.key]} and ${right.values[dimension.key]} are not both plain decimals; the archive orders exactly or not at all`);
    }
    if (ordered === -1) return false;
    if (ordered === 1) strictlyBetterSomewhere = true;
  }
  return strictlyBetterSomewhere;
}

/**
 * The non-dominated set over `entries` on `dimensions`.
 *
 * Ties are members: two entries equal on every dimension dominate each other nowhere, so both
 * stay. That is the honest answer — the archive has no tie-break to offer that would not be an
 * invented preference — and it is why the frontier is routinely larger than one.
 *
 * Refuses: no dimensions, a duplicate dimension key, a duplicate `tupleDigest`, an entry missing a
 * declared dimension, and a value the exact-decimal comparison cannot order.
 */
export function frontier(
  entries: readonly FrontierEntry[],
  dimensions: readonly FrontierDimension[],
): ReadonlySet<string> {
  if (dimensions.length === 0) {
    refuse("archive-derivation", "dimensions",
      "a frontier needs at least one dimension; with none, every entry is non-dominated and the set says nothing");
  }
  const keys = new Set<string>();
  for (const dimension of dimensions) {
    if (keys.has(dimension.key)) {
      refuse("archive-derivation", `dimensions.${dimension.key}`,
        "a dimension key appears twice; one axis counted twice is a weighting, and the archive does not weight");
    }
    keys.add(dimension.key);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.tupleDigest)) {
      refuse("archive-derivation", `entries.${entry.tupleDigest}`,
        "a tuple digest appears twice; the frontier is keyed by the population key and holds each once");
    }
    seen.add(entry.tupleDigest);
  }

  const members = new Set<string>();
  for (const entry of entries) {
    const dominated = entries.some((other) =>
      other.tupleDigest !== entry.tupleDigest && dominates(other, entry, dimensions));
    if (!dominated) members.add(entry.tupleDigest);
  }
  return members;
}

/**
 * The frontier's members as bytes, sorted by digest.
 *
 * The sort is lexicographic on a hash and carries **no** quality meaning; it exists so two hosts
 * projecting the same archive write the same file. Anywhere a human reads this list, the
 * accompanying text has to say the same thing.
 */
export function frontierMembers(members: ReadonlySet<string>): readonly string[] {
  return [...members].sort();
}
