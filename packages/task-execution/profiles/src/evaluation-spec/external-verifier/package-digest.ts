import { sha256Hex } from "../../bytes.js";
import { ProfilesError } from "../../errors.js";
import { EXTERNAL_VERIFIER_DIGEST_PATTERN } from "../family-blocks.js";
import { compareCodePointStrings } from "./code-point-order.js";

/** One file of a Harbor task package: its path from the package root, with `/` between
 * segments, and the SHA-256 of its bytes as 64 lowercase hexadecimal digits. */
export interface HarborPackageFile {
  path: string;
  sha256: string;
}

const encoder = new TextEncoder();

/**
 * The content hash Harbor assigns to a task package (proposal 0002, section 6): order the
 * files by path, ascending by Unicode code point; write one line per file, the path, one byte
 * 0x00, the file's digest, one byte 0x0A, all as UTF-8; take the SHA-256 of the lines joined
 * together.
 *
 * This is the grader digest of an `external-verifier` specification whose harness is `harbor`.
 * It is not the SHA-256 of any file or archive, so no byte stream hashes to it: a reader that
 * holds the package checks the digest by calling this function.
 *
 * Which files a package holds is Harbor's decision. The caller passes every file of the
 * package as published. One path given twice, or a file digest in any other form, is refused
 * with `ProfilesError("invalid-document")`.
 */
export function harborPackageContentHash(files: readonly HarborPackageFile[]): string {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new ProfilesError("invalid-document", `Harbor package lists the path "${file.path}" more than once.`);
    }
    seen.add(file.path);
    if (typeof file.sha256 !== "string" || !EXTERNAL_VERIFIER_DIGEST_PATTERN.test(file.sha256)) {
      throw new ProfilesError(
        "invalid-document",
        `Harbor package file "${file.path}" needs its SHA-256 as 64 lowercase hexadecimal digits, with no prefix.`,
      );
    }
  }
  const lines = [...files]
    .sort((left, right) => compareCodePointStrings(left.path, right.path))
    .map((file) => `${file.path}\0${file.sha256}\n`)
    .join("");
  return sha256Hex(encoder.encode(lines));
}
