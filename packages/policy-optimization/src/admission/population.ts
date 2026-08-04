// SPDX-License-Identifier: MIT

/**
 * The candidate population, keyed by `tupleDigest` (product design §7.3).
 *
 * > **Population membership is keyed by `tupleDigest`.** A second manifest proposing an
 * > already-admitted tuple joins the existing arm rather than minting a duplicate; execution
 * > attribution goes to the first-admitted manifest, and later manifests are journaled against the
 * > same arm (load-bearing for any future paid-proposal economics).
 *
 * Three decisions follow from that paragraph and are all here rather than at call sites.
 *
 * - **The arm id is derived from the tuple digest, not from insertion order.** An order-derived id
 *   (`arm-1`, `arm-2`) is a different label after any replay that admits candidates in a different
 *   order, and the wave engine seals Run bytes over arm ids (`buildWaveArms` sorts by `armId`).
 *   Deriving from the digest makes the id a property of the *tuple*, so a resumed campaign and a
 *   re-derived one agree.
 * - **Attribution is written once and never moved.** "Execution attribution goes to the
 *   first-admitted manifest" is not a default — a later manifest joining the arm must not be able
 *   to displace it, which is exactly the move a paid-proposal economics would create an incentive
 *   for.
 * - **Joining is not silent.** `admitToPopulation` reports `joinedExisting`, so the caller journals
 *   a `candidate-admitted` entry naming the arm the manifest joined. A join that produced no
 *   journal entry would make the second proposer's contribution unrecoverable.
 */

import { canonicalJsonBytes, canonicalJsonText, prefixedDigest } from "@jinn-network/policy-identity";
import { refuse } from "../errors.js";
import { CAMPAIGN_POPULATION_FORMAT_TOKEN } from "../tokens.js";
import type { JsonValue, PolicyRef } from "../types.js";

const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/;

/** One arm of the population: a tuple, the manifest that minted it, and everything that joined it. */
export interface PopulationEntry {
  readonly tupleDigest: string;
  /** `arm-<first 12 hex of the tuple digest>` — see `armIdForTuple`. */
  readonly armId: string;
  /** The **first-admitted** manifest. Written once; never moved. */
  readonly attribution: PolicyRef;
  /** Every admitted manifest digest for this tuple, in admission order, `attribution` first. */
  readonly manifests: readonly string[];
}

export interface Population {
  readonly formatToken: string;
  /** Sorted by `tupleDigest`, so the document's bytes do not depend on admission order. */
  readonly entries: readonly PopulationEntry[];
}

export const EMPTY_POPULATION: Population = {
  formatToken: CAMPAIGN_POPULATION_FORMAT_TOKEN,
  entries: [],
};

/**
 * `arm-<first 12 hex characters of the tuple digest>` — 48 bits, inside records §7.1's
 * `[A-Za-z0-9_-]{1,64}` grammar.
 *
 * Truncated rather than full-length because an arm id appears in every `cellKey` of every wave, and
 * a 64-character id makes those unreadable for no gain: the id does not have to be
 * collision-resistant against an adversary, only against accident within one campaign's population.
 * `admitToPopulation` refuses on a collision anyway, so a truncation clash is a loud refusal rather
 * than two tuples quietly sharing an arm.
 */
export function armIdForTuple(tupleDigest: string): string {
  if (!SHA256_PREFIXED.test(tupleDigest)) {
    refuse("population-conflict", "tupleDigest", "a tuple digest must be sha256:<64 lowercase hex>");
  }
  return `arm-${tupleDigest.slice("sha256:".length, "sha256:".length + 12)}`;
}

export interface AdmitToPopulationInput {
  readonly tupleDigest: string;
  /** `sha256:` over the sealed candidate manifest's bytes. */
  readonly manifestDigest: string;
}

export interface PopulationAdmission {
  readonly population: Population;
  readonly entry: PopulationEntry;
  /** True when this manifest joined an arm an earlier manifest minted (§7.3). */
  readonly joinedExisting: boolean;
  /** True when this exact manifest was already recorded on the arm — an idempotent replay. */
  readonly alreadyRecorded: boolean;
}

function sortEntries(entries: readonly PopulationEntry[]): readonly PopulationEntry[] {
  return [...entries].sort((left, right) => (left.tupleDigest < right.tupleDigest ? -1
    : left.tupleDigest > right.tupleDigest ? 1 : 0));
}

/**
 * Admits one manifest to the population.
 *
 * Idempotent: re-admitting the same `(tupleDigest, manifestDigest)` pair returns the population
 * unchanged with `alreadyRecorded`, which is what a caller re-entering after a crash between the
 * registry write and the journal append needs.
 */
export function admitToPopulation(
  population: Population,
  input: AdmitToPopulationInput,
): PopulationAdmission {
  if (!SHA256_PREFIXED.test(input.manifestDigest)) {
    refuse("population-conflict", "manifestDigest",
      "a manifest digest must be sha256:<64 lowercase hex>");
  }
  const armId = armIdForTuple(input.tupleDigest);

  const collision = population.entries.find(
    (entry) => entry.armId === armId && entry.tupleDigest !== input.tupleDigest,
  );
  if (collision !== undefined) {
    refuse("population-conflict", "armId",
      `arm ${armId} already names tuple ${collision.tupleDigest}; two tuples cannot share an arm`);
  }

  const existing = population.entries.find((entry) => entry.tupleDigest === input.tupleDigest);
  if (existing === undefined) {
    const entry: PopulationEntry = {
      tupleDigest: input.tupleDigest,
      armId,
      attribution: { kind: "candidate", digest: input.manifestDigest },
      manifests: [input.manifestDigest],
    };
    return {
      population: { ...population, entries: sortEntries([...population.entries, entry]) },
      entry,
      joinedExisting: false,
      alreadyRecorded: false,
    };
  }

  if (existing.manifests.includes(input.manifestDigest)) {
    return { population, entry: existing, joinedExisting: true, alreadyRecorded: true };
  }

  const entry: PopulationEntry = {
    ...existing,
    // `attribution` is spread from `existing` above and deliberately not recomputed here: the
    // first-admitted manifest keeps the arm.
    manifests: [...existing.manifests, input.manifestDigest],
  };
  return {
    population: {
      ...population,
      entries: sortEntries(population.entries.map((e) => (e.tupleDigest === entry.tupleDigest ? entry : e))),
    },
    entry,
    joinedExisting: true,
    alreadyRecorded: false,
  };
}

/** The registry's exact on-disk bytes. Canonical, so a rewrite that changed nothing changes no byte. */
export function populationBytes(population: Population): Uint8Array {
  return canonicalJsonBytes(population as unknown as JsonValue);
}

export function populationDigest(population: Population): string {
  return prefixedDigest(populationBytes(population));
}

/**
 * Parses a registry document, refusing anything that is not the canonical form or that disagrees
 * with itself about an arm.
 *
 * The self-consistency checks are re-run on read rather than trusted from the write: the registry
 * is a *derived* document (the journal's `candidate-admitted` entries are the authority, §5.2), and
 * a derived document that has drifted from its source must fail to open rather than be believed.
 */
export function parseExactPopulation(bytes: Uint8Array): Population {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    refuse("population-conflict", "", "the population registry is not valid UTF-8 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse("population-conflict", "", "the population registry must be a JSON object");
  }
  const document = parsed as Record<string, unknown>;
  if (document["formatToken"] !== CAMPAIGN_POPULATION_FORMAT_TOKEN) {
    refuse("population-conflict", "formatToken",
      `formatToken must be ${CAMPAIGN_POPULATION_FORMAT_TOKEN}`);
  }
  if (!Array.isArray(document["entries"])) {
    refuse("population-conflict", "entries", "entries must be an array");
  }

  const seenArms = new Set<string>();
  const seenTuples = new Set<string>();
  document["entries"].forEach((raw, index) => {
    const path = `entries.${index}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      refuse("population-conflict", path, "a population entry must be a JSON object");
    }
    const entry = raw as Record<string, unknown>;
    const tupleDigest = entry["tupleDigest"];
    if (typeof tupleDigest !== "string" || !SHA256_PREFIXED.test(tupleDigest)) {
      refuse("population-conflict", `${path}.tupleDigest`, "tupleDigest must be sha256:<64 lowercase hex>");
    }
    if (entry["armId"] !== armIdForTuple(tupleDigest)) {
      refuse("population-conflict", `${path}.armId`,
        `armId ${String(entry["armId"])} is not the id derived from ${tupleDigest}`);
    }
    if (seenTuples.has(tupleDigest) || seenArms.has(entry["armId"] as string)) {
      refuse("population-conflict", path, `duplicate population entry for ${tupleDigest}`);
    }
    seenTuples.add(tupleDigest);
    seenArms.add(entry["armId"] as string);

    const manifests = entry["manifests"];
    if (!Array.isArray(manifests) || manifests.length === 0
      || manifests.some((digest) => typeof digest !== "string" || !SHA256_PREFIXED.test(digest))) {
      refuse("population-conflict", `${path}.manifests`,
        "manifests must be a non-empty array of sha256:<64 lowercase hex> digests");
    }
    const attribution = entry["attribution"] as Record<string, unknown> | undefined;
    if (attribution?.["kind"] !== "candidate" || attribution["digest"] !== manifests[0]) {
      refuse("population-conflict", `${path}.attribution`,
        "attribution must name the first-admitted manifest as a typed candidate reference");
    }
  });

  const population = document as unknown as Population;
  if (canonicalJsonText(population as unknown as JsonValue) !== text) {
    refuse("population-conflict", "", "these bytes are not the canonical form of the registry they carry");
  }
  return population;
}
