/**
 * Digest-addressed sealed-record store (spec §4.5).
 *
 * Every sealed record the product touches is stored as its exact bytes,
 * addressed by digest. Product state references records by digest only —
 * nothing is ever re-canonicalized (the platform's exactness property, see
 * `@jinn-network/benchmarking-records`'s own `sealRecord`). This module is
 * the workspace-local half of that discipline: a content-addressed blob
 * store under `records/`, verified on every read, not just at write time.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../errors.js";
import { atomicWriteFileSync, readFileIfExistsSync } from "../fs/atomic.js";
import { recordsDir } from "./layout.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** Lowercase sha256 hex digest of the exact bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `records/<hex64>.bin` under the workspace. Refuses `"validation"` unless
 * `sha256` is a well-formed lowercase hex digest.
 */
export function sealedRecordPath(workspaceDir: string, sha256: string): string {
  if (!DIGEST_PATTERN.test(sha256)) {
    refuse("validation", "sha256", "digest must be 64 lowercase hex characters");
  }
  return join(recordsDir(workspaceDir), `${sha256}.bin`);
}

/**
 * Stores `bytes` addressed by their own sha256 digest and returns it.
 * Written atomically; re-putting byte-identical content is a no-op that
 * returns the same digest (the destination path is the digest itself).
 */
export function putSealedBytes(workspaceDir: string, bytes: Uint8Array): string {
  const digest = sha256Hex(bytes);
  atomicWriteFileSync(sealedRecordPath(workspaceDir, digest), bytes);
  return digest;
}

/**
 * Returns the EXACT stored bytes for `sha256`. Refuses `"not-found"` when no
 * record with this digest is stored, and re-computes the digest on every
 * read, refusing `"record-integrity"` on mismatch (spec §4.5).
 */
export function getSealedBytes(workspaceDir: string, sha256: string): Uint8Array {
  const path = sealedRecordPath(workspaceDir, sha256);
  const bytes = readFileIfExistsSync(path);
  if (bytes === undefined) {
    refuse("not-found", path, "no sealed record with this digest");
  }
  if (sha256Hex(bytes) !== sha256) {
    refuse("record-integrity", path, "stored bytes do not match their digest");
  }
  return bytes;
}

/** True when a sealed record with this digest is stored. */
export function hasSealedBytes(workspaceDir: string, sha256: string): boolean {
  return existsSync(sealedRecordPath(workspaceDir, sha256));
}
