// SPDX-License-Identifier: MIT

/**
 * NAIVE REFERENCE — the `learner-public.v1` tree-hash profile and the fail-closed
 * materialization rule (substrate §4.2).
 *
 * This is the fork-healing half of the kit. The digest it produces is the one C3's shipped
 * regression suite (`client/test/harnesses/hash-profile.test.ts`) pins, and the fixture tree is
 * byte-for-byte the same tree — so the cross-unit byte-match the program requires is a fact this
 * kit can assert on its own, from a second implementation, without importing C3's code.
 *
 * The profile:
 *   - excluded roots (`.git`, `operator-requests`, `secrets`, `transcripts`) are skipped whole,
 *     **before** any classification runs — they hold arbitrary bytes including symlinks;
 *   - every remaining top-level path must be a classified directory or the classified file
 *     `policy.json`; anything else fails closed, and directory-ness is part of the
 *     classification (a regular file named `skills` is not the `skills` directory);
 *   - a symlink or special file anywhere outside an excluded root fails closed rather than being
 *     followed;
 *   - per-file `sha256` over the file's exact bytes, path-sorted, emitted as `<relPath>:<hex>`,
 *     joined with LF and **no trailing newline**, then `sha256` over that — bare lowercase hex.
 *
 * The digest is `learner-public.v1`'s whole contract, and it is deliberately blind to everything
 * under the excluded roots. That blindness is why §4.2 requires the separate materialization
 * refusal below: a package can carry executable `.git/hooks/*` and still digest-verify.
 */

import {
  LEARNER_PUBLIC_V1_ALLOWED_DIRS,
  LEARNER_PUBLIC_V1_ALLOWED_FILES,
  LEARNER_PUBLIC_V1_EXCLUDED_ROOTS,
} from "../../src/tokens.js";
import type { TreeEntry } from "../../src/types.js";
import { compareCodeUnitStrings } from "./canonical.js";
import { fail } from "./errors.js";
import { sha256HexOfText } from "./hashing.js";

const EXCLUDED = new Set<string>(LEARNER_PUBLIC_V1_EXCLUDED_ROOTS);
const ALLOWED_DIRS = new Set<string>(LEARNER_PUBLIC_V1_ALLOWED_DIRS);
const ALLOWED_FILES = new Set<string>(LEARNER_PUBLIC_V1_ALLOWED_FILES);

function topLevelSegment(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

function isNested(path: string): boolean {
  return path.includes("/");
}

/**
 * `learner-public.v1` over an in-memory tree description. Returns **bare lowercase hex**, the
 * spelling C3's `hashImplStateDir` returns and the constant the two units share.
 */
export function hashTreeLearnerPublicV1(entries: readonly TreeEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const root = topLevelSegment(entry.path);

    // Excluded roots are skipped before classification. Nothing inside them is inspected — not
    // its kind, not its name, not its bytes.
    if (EXCLUDED.has(root)) continue;

    if (entry.kind === "symlink") {
      fail("hash-profile-violation", entry.path, "symlinks are not hashable; the profile fails closed rather than following them");
    }
    if (entry.kind === "special") {
      fail("hash-profile-violation", entry.path, "special files are not hashable; the profile fails closed");
    }

    if (isNested(entry.path)) {
      // A nested file is reachable only through a classified top-level directory.
      if (!ALLOWED_DIRS.has(root)) {
        fail("hash-profile-violation", root, `unclassified top-level path "${root}"; the profile fails closed`);
      }
    } else {
      // A top-level regular file must be a classified FILE. `skills` is a classified directory,
      // so a regular file called `skills` fails closed: directory-ness is part of the rule.
      if (!ALLOWED_FILES.has(entry.path)) {
        fail("hash-profile-violation", entry.path, `unclassified top-level path "${entry.path}"; the profile fails closed`);
      }
    }

    if (entry.content === undefined) {
      fail("hash-profile-violation", entry.path, "a hashable file must carry its exact bytes");
    }
    lines.push(`${entry.path}:${sha256HexOfText(entry.content)}`);
  }

  lines.sort(compareCodeUnitStrings);
  return sha256HexOfText(lines.join("\n"));
}

/**
 * Substrate §4.2 — the fail-closed materialization rule, on **every** path (Workspace
 * Provisioner included, not only `jinn checkpoint install`).
 *
 * A `jinn.harness-state.v1` package containing **any** profile-ignored root is refused. The
 * digest cannot see those bytes, so a package carrying executable `.git/hooks/*` digest-verifies
 * perfectly and then fires when the learner's own git machinery runs in the materialized
 * workspace. The refusal — not the digest — is the control.
 */
export function assertMaterializable(entries: readonly TreeEntry[]): void {
  for (const entry of entries) {
    const root = topLevelSegment(entry.path);
    if (EXCLUDED.has(root)) {
      fail(
        "materialization-refused",
        entry.path,
        `package carries the profile-ignored root "${root}"; the digest cannot see it, so materialization refuses it`,
      );
    }
  }
}
