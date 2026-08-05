// SPDX-License-Identifier: MIT

/**
 * The C6-emitted candidate, read from committed bytes (program §1 C9, leg 2).
 *
 * ## The seam is the bytes — see FINDING F-C9-1
 *
 * `client/` cannot import this package and this package cannot import `client/`. Both directions
 * are enforced, deliberately:
 *
 * - `architecture/platform-packages.v1.json` puts `@jinn-network/policy-optimization` in release
 *   group `transitional-or-private`, and `@jinn-network/client`'s group
 *   (`legacy-product-lines`) does not allow depending on it.
 * - `.github/scripts/policy-optimization-source-boundaries.test.mjs` denies
 *   `@jinn-network/client` **by name** in this package's `EXPLICITLY_DENIED` list.
 *
 * So the seam between the two tiers is the sealed bytes and nothing else. `client`'s
 * `test/harnesses/impls/learner/candidate-admission-seam.test.ts` runs the *shipped*
 * `LearnerHarness` in candidate mode against a scripted adapter, writes what it emits here, and
 * asserts byte-equality on every subsequent run. This module reads those bytes back and hands
 * them to the campaign, which admits them through the **unmodified** gate.
 *
 * `evidence-provenance.json` runs the other way: this package's `assembleEvidenceBundle` authored
 * it, and `client` consumes it as opaque input (the learner's contract requires provenance and
 * refuses to fabricate it — F-C6-1). `assertBundleProvenanceMatches` below is what keeps that
 * direction honest: if the campaign's evidence bundle ever stops digesting to the value the
 * committed provenance pins, this fails **here**, with an instruction, rather than surfacing four
 * stages later as an opaque admission refusal.
 *
 * Regenerate both directions with:
 *
 * ```
 * (cd client && JINN_C9_WRITE_FIXTURES=1 yarn vitest run \
 *    test/harnesses/impls/learner/candidate-admission-seam.test.ts)
 * ```
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashTreeLearnerPublicV1, type TreeEntry } from "@jinn-network/policy-identity";

import { SEED_TREE } from "./fixtures.js";
import type { LearnerCandidateFixture } from "./campaign.js";

const REGENERATE =
  "Regenerate with: (cd client && JINN_C9_WRITE_FIXTURES=1 yarn vitest run "
  + "test/harnesses/impls/learner/candidate-admission-seam.test.ts). See FINDING F-C9-1.";

function fixtureUrl(name: string): URL {
  return new URL(`../../fixtures/learner/${name}`, import.meta.url);
}

function readFixture(name: string): Buffer {
  try {
    return readFileSync(fileURLToPath(fixtureUrl(name)));
  } catch {
    throw new Error(`missing C9 seam fixture 'fixtures/learner/${name}'. ${REGENERATE}`);
  }
}

/** The evidence-bundle provenance the learner was configured with, as committed bytes. */
export function learnerEvidenceProvenance(): Readonly<Record<string, unknown>> {
  return JSON.parse(readFixture("evidence-provenance.json").toString("utf8")) as Readonly<
    Record<string, unknown>
  >;
}

/**
 * Fail loudly, and early, when the campaign's own evidence bundle has drifted away from the one
 * the committed learner candidate was issued against.
 *
 * Without this the drift still surfaces — as admission check 5 refusing the learner candidate for
 * `evidence-bundle-mismatch`, which reads like a product defect and is not one.
 */
export function assertBundleProvenanceMatches(
  provenance: Readonly<Record<string, unknown>>,
): void {
  const committed = learnerEvidenceProvenance();
  for (const key of ["savedQueryDigest", "recordListDigest"] as const) {
    if (JSON.stringify(committed[key]) !== JSON.stringify(provenance[key])) {
      throw new Error(
        `the campaign's evidence bundle no longer matches the committed learner candidate: `
        + `${key} is ${String(provenance[key])}, the fixture pins ${String(committed[key])}. `
        + REGENERATE,
      );
    }
  }
}

/**
 * The sealed manifest and the materialized tree the shipped learner emitted.
 *
 * The seed check is the one thing worth asserting on load: `client` seeds its harness from
 * `fixtures/learner/seed-tree.json`, this package's campaign seeds from `SEED_TREE`, and the
 * emitted manifest's `parents[0]` only resolves to the campaign's seed tuple while those two are
 * the same tree.
 */
export function loadLearnerCandidateFixture(): LearnerCandidateFixture {
  const seed = JSON.parse(readFixture("seed-tree.json").toString("utf8")) as TreeEntry[];
  if (hashTreeLearnerPublicV1(seed) !== hashTreeLearnerPublicV1(SEED_TREE)) {
    throw new Error(
      "fixtures/learner/seed-tree.json is not this campaign's seed policy, so the learner "
      + `candidate's declared parent cannot resolve to it. ${REGENERATE}`,
    );
  }
  return {
    manifestBytes: new Uint8Array(readFixture("candidate-manifest.json")),
    tree: JSON.parse(readFixture("candidate-tree.json").toString("utf8")) as TreeEntry[],
  };
}
