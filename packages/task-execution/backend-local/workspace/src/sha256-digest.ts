// SPDX-License-Identifier: Apache-2.0

/**
 * The F9 conversion (policy-optimization implementation program §9 addendum,
 * docs/superpowers/plans/2026-08-03-policy-optimization-implementation-program.md): the
 * `learner-public.v1` hash profile (mirrored here in `harness-state-package.ts`, and shipped in
 * `operator/src/harnesses/freeze.ts#hashImplStateDir`) emits **bare** 64-character lowercase hex,
 * while a `jinn.harness-state.v1` loadout pin's `digest` field carries the `sha256:`-prefixed
 * spelling (substrate §4.2's tuple example; every other single-digest field in the substrate —
 * `tupleDigest`, the candidate manifest digest, `ResolvedTaskProfile.digest` — uses the same
 * prefixed convention). This is the one named conversion point C5 owns: every call site imports
 * these two functions rather than concatenating or slicing `"sha256:"` inline.
 *
 * Mirrors the established `toBareSha256Hex`/`toRepositorySha256Digest` pair in
 * `packages/evidence/trace/src/digests.ts` (not imported — evidence/trace is a
 * different tree and not an approved task-execution dependency).
 */

const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BARE_SHA256 = /^[0-9a-f]{64}$/u;

/** `sha256:<hex>` -> bare `<hex>`. Throws on anything else. */
export function toBareSha256Hex(digest: string): string {
  if (!PREFIXED_SHA256.test(digest)) {
    throw new TypeError('expected a "sha256:<64 lowercase hex>" digest');
  }
  return digest.slice("sha256:".length);
}

/** Bare `<hex>` -> `sha256:<hex>`. Throws on anything else. */
export function toSha256Digest(hex: string): `sha256:${string}` {
  if (!BARE_SHA256.test(hex)) {
    throw new TypeError("expected a bare 64-character lowercase hex sha256 digest");
  }
  return `sha256:${hex}`;
}
