// SPDX-License-Identifier: MIT

/**
 * `learner-public.v1` and the fail-closed materialization rule (substrate §4.2).
 *
 * This is the second independent implementation of the profile C3 registers over the shipped
 * freeze/delivery/status surfaces. The two must agree byte-for-byte on the fork-healing fixture
 * tree, because that agreement is the whole content of "one hashing procedure, three uses" — if
 * they ever diverge, the `codeDigest` ↔ loadout-digest fork the substrate exists to heal has
 * quietly reopened, and a single operator is back to two digests for one tree.
 *
 * The profile is deliberately **blind** to four roots, which is exactly why the digest cannot be
 * the control against smuggled bytes. `assertMaterializable` is that control, and the two are
 * separate functions on purpose: `hashTreeLearnerPublicV1` answers "what is this tree's public
 * identity", `assertMaterializable` answers "may this package be unpacked into a workspace", and
 * a package can honestly pass the first while failing the second.
 *
 * Pure by construction: it hashes a described tree, never a filesystem. Walking a real directory
 * into `TreeEntry[]` is the host's job.
 */

import { compareCodeUnitStrings } from "./canonical.js";
import { sha256HexOfText } from "./digest.js";
import { refuse } from "./errors.js";
import {
  LEARNER_PUBLIC_V1_ALLOWED_DIRS,
  LEARNER_PUBLIC_V1_ALLOWED_FILES,
  LEARNER_PUBLIC_V1_EXCLUDED_ROOTS,
} from "./tokens.js";
import type { TreeEntry } from "./types.js";

const EXCLUDED_ROOTS = new Set<string>(LEARNER_PUBLIC_V1_EXCLUDED_ROOTS);
const ALLOWED_DIRS = new Set<string>(LEARNER_PUBLIC_V1_ALLOWED_DIRS);
const ALLOWED_FILES = new Set<string>(LEARNER_PUBLIC_V1_ALLOWED_FILES);

function topLevelSegment(path: string): string {
  const separator = path.indexOf("/");
  return separator === -1 ? path : path.slice(0, separator);
}

/**
 * The digest: path-sorted per-file sha256, joined as `<path>:<hex>` lines with LF and no trailing
 * newline, then one outer sha256. Output is **bare** hex (F9); the `sha256:` prefix belongs to the
 * loadout pinning value, and C5 owns the conversion.
 */
export function hashTreeLearnerPublicV1(entries: readonly TreeEntry[]): string {
  const contributing: { path: string; line: string }[] = [];

  for (const entry of entries) {
    const root = topLevelSegment(entry.path);

    // Excluded subtrees are skipped BEFORE classification. Getting this order wrong is the
    // mistake a naive fail-closed implementation makes: excluded roots hold arbitrary bytes — a
    // real `.git/` routinely contains symlinks — so an implementation that screens every entry
    // and then excludes would refuse every real learner tree.
    if (EXCLUDED_ROOTS.has(root)) continue;

    if (root === entry.path) {
      // A top-level entry. `policy.json` is the only classified top-level FILE; directory-ness is
      // part of the classification, so a regular file named `skills` is not admitted on the
      // strength of its name, and a stray `README.md` is not admitted for looking harmless.
      if (!ALLOWED_FILES.has(entry.path) || entry.kind !== "file") {
        refuse("hash-profile-violation", entry.path,
          "unclassified top-level entry; the learner-public.v1 classification is exhaustive");
      }
    } else if (!ALLOWED_DIRS.has(root)) {
      // Hashing an unknown root would make the digest depend on files nobody agreed were public;
      // ignoring it would make the digest blind to them. Refuse instead, naming the root.
      refuse("hash-profile-violation", root,
        "unclassified top-level directory; the learner-public.v1 classification is exhaustive");
    }

    if (entry.kind !== "file") {
      // Symlinks are refused rather than followed: following would let a package hash bytes that
      // live outside the tree entirely, including inside an excluded root, which is how a
      // `secrets/` file re-enters a "public" digest. Special files have no stable bytes to hash
      // and can block a read forever.
      refuse("hash-profile-violation", entry.path,
        `a ${entry.kind} has no hashable content under learner-public.v1`);
    }

    contributing.push({
      path: entry.path,
      line: `${entry.path}:${sha256HexOfText(entry.content ?? "")}`,
    });
  }

  contributing.sort((left, right) => compareCodeUnitStrings(left.path, right.path));
  return sha256HexOfText(contributing.map(({ line }) => line).join("\n"));
}

/**
 * Substrate §4.2 — a `jinn.harness-state.v1` package containing **any** profile-ignored root is
 * rejected at materialization, on **every** path (the Workspace Provisioner included, not only
 * `jinn checkpoint install`).
 *
 * The refusal, not the digest, is the control. A package carrying an executable
 * `.git/hooks/post-checkout` digest-verifies perfectly — nothing about the digest is wrong, and
 * nothing about the digest can save you, because the hook fires the moment the learner's own git
 * machinery runs in the materialized workspace.
 */
export function assertMaterializable(entries: readonly TreeEntry[]): void {
  for (const entry of entries) {
    const root = topLevelSegment(entry.path);
    if (!EXCLUDED_ROOTS.has(root)) continue;
    refuse("materialization-refused", entry.path,
      `package carries the profile-ignored root ${root}/, whose bytes the digest cannot see`);
  }
}
