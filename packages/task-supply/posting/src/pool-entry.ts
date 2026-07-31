// SPDX-License-Identifier: MIT

// The reconciliation between what C4's pool stores and what this application posts, filed as
// F-C5-8 (see README, "Reported to the program"). C4's `PoolEntry` names the admission receipt
// `receiptDigest` and models no publicness flag at all, while spec §8's D5 gate — the one
// `planPosting` and `buildDispatchSubmission` both enforce — needs `admissionReceiptDigest` and
// `evaluationSpecPublic`. Without this adapter the tier-4 composition would have to invent both,
// and the D5 refusal would rest on a caller's assertion rather than on the sealed bytes.
//
// So `evaluationSpecPublic` is read here, off the EvaluationSpec bytes the entry's own digest
// addresses: D5's stamping puts `accessClass: "public"` on every access-classified descriptor at
// seal time, and this reads those stamps back. Fail closed in every direction — an unstamped
// specification, a private stamp, a non-string stamp, or bytes that are not a JSON document all
// yield `false`, which `planPosting` records as the `evaluation-not-public` skip.
//
// No runtime edge into `@jinn-network/task-derivation` (finding F-C5-5): the input is declared
// structurally here and `pool-shape.test.ts` pins C4's stored entry against it at compile time.
import { sha256Hex } from "@jinn-network/task-execution-protocol";
import { assertPrefixedSha256 } from "./digest.js";
import type { PostingPoolEntry } from "./types.js";

/**
 * A pool entry as the supply pool stores it: the sealed pair's bytes, the digests that address
 * them, and the digest of the admission receipt the pair earned.
 */
export interface SuppliedPoolEntry {
  readonly taskDigest: `sha256:${string}`;
  readonly taskBytes: Uint8Array;
  readonly evaluationSpecDigest: `sha256:${string}`;
  readonly evaluationSpecBytes: Uint8Array;
  /** C4's name for the admission receipt this pair earned. */
  readonly receiptDigest: `sha256:${string}`;
}

export interface PostingPoolEntryOptions {
  /** Advisory acquisition hint for the receipt; the digest is what binds. */
  readonly admissionReceiptUri?: string;
}

const ACCESS_CLASS_KEY = "accessClass";
const PUBLIC_ACCESS_CLASS = "public";

function collectAccessClasses(node: unknown, found: unknown[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectAccessClasses(item, found);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === ACCESS_CLASS_KEY) {
      found.push(value);
      continue;
    }
    collectAccessClasses(value, found);
  }
}

/**
 * Whether every access-classified descriptor in a sealed EvaluationSpec is stamped public.
 *
 * A specification with no stamps at all is `false`: absence of a stamp is not evidence of
 * publicness, and v1 posts public-specification evaluation legs only (design §8, D5). The walk is
 * family-agnostic on purpose — it reads the stamps wherever a family block puts them rather than
 * hard-coding one family's shape into the posting application.
 */
export function evaluationSpecIsPublic(evaluationSpecBytes: Uint8Array): boolean {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evaluationSpecBytes));
  } catch {
    return false;
  }
  const found: unknown[] = [];
  collectAccessClasses(document, found);
  if (found.length === 0) return false;
  return found.every((value) => value === PUBLIC_ACCESS_CLASS);
}

/**
 * Builds the entry this application posts from the entry the pool stores.
 *
 * Both digests are checked against the bytes they address before anything is read from those
 * bytes: a publicness stamp read out of a specification the entry does not name would be a claim
 * about some other document.
 */
export function postingPoolEntry(
  entry: SuppliedPoolEntry,
  options: PostingPoolEntryOptions = {},
): PostingPoolEntry {
  assertPrefixedSha256(entry.taskDigest, "taskDigest");
  assertPrefixedSha256(entry.evaluationSpecDigest, "evaluationSpecDigest");
  assertPrefixedSha256(entry.receiptDigest, "receiptDigest");

  const taskHex = sha256Hex(entry.taskBytes);
  if (taskHex !== entry.taskDigest.slice("sha256:".length)) {
    throw new Error(
      `pool entry taskDigest ${entry.taskDigest} does not address its bytes (sha256:${taskHex})`,
    );
  }
  const specHex = sha256Hex(entry.evaluationSpecBytes);
  if (specHex !== entry.evaluationSpecDigest.slice("sha256:".length)) {
    throw new Error(
      `pool entry evaluationSpecDigest ${entry.evaluationSpecDigest} does not address its bytes `
        + `(sha256:${specHex}) -- the access class read from those bytes would describe another `
        + "specification",
    );
  }

  return {
    taskDigest: entry.taskDigest,
    taskBytes: entry.taskBytes,
    evaluationSpecDigest: entry.evaluationSpecDigest,
    admissionReceiptDigest: entry.receiptDigest,
    ...(options.admissionReceiptUri === undefined
      ? {}
      : { admissionReceiptUri: options.admissionReceiptUri }),
    evaluationSpecPublic: evaluationSpecIsPublic(entry.evaluationSpecBytes),
  };
}
