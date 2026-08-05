// SPDX-License-Identifier: Apache-2.0

/**
 * The canonical protocol identifier origin and version form.
 *
 * DR-2026-08-04 (`log/decisions/2026-08-04-spec-origin-and-vocabulary.md`) rules two things
 * this module implements:
 *
 * - **Decision 1/2 — one dedicated origin.** All protocol URIs, names and locators alike,
 *   live at `https://spec.jinn.network/`. The apex `jinn.network` is purely product.
 * - **Decision 4 — major-only versions.** Type and protocol identifiers carry `v<major>`,
 *   not `<major>.<minor>`: a compatible 1.0 -> 1.1 must not change the identifier, and a
 *   breaking change is a new name. The `<major>.<minor>` form contradicted our own
 *   identifier law.
 *
 * ## One spelling, byte-exact
 *
 * The re-seal's transition window is closed. There is exactly one recognized origin and
 * exactly one version form; a document spelled any other way is not a protocol identifier
 * and is refused rather than translated. That is the point of the closure: while two
 * spellings were recognized, a lookup table could decide identity. Now the identifier is
 * the identity.
 *
 * The narrowing is held in place by `.github/scripts/origin-tripwire.mjs`, which fails CI on
 * any occurrence of the retired apex origin in the enforced source scopes.
 *
 * Genuinely historical wire ids — the ones that name bytes sealed before the re-seal, such
 * as the native-trace source formats in `packages/evidence/trace-decode/src/formats.ts` —
 * keep their own translate-then-key tables. Those translate *history*; they are not this
 * module's business.
 *
 * This module is the reference implementation the tier-2 record packages mirror. It is
 * copied rather than imported because the dependency direction forbids new edges into
 * `@jinn-network/record-discovery-protocol` from those packages (they stay dependency-free).
 *
 * The exception the DR names: task-profile *instances* are digest-pinned artifacts whose
 * revision is part of the name, so `task-profiles/<name>/<rev>` keeps a full revision. Those
 * are not record-kind URIs and this grammar does not govern them.
 */

/** The dedicated identifier origin (DR-2026-08-04 §Decision 1). No trailing slash. */
export const CANONICAL_ORIGIN = "https://spec.jinn.network";

/** Canonical version segment: major-only `v<major>`, no `v0` (DR-2026-08-04 §Decision 4). */
export const CANONICAL_VERSION_GRAMMAR = /^v[1-9]\d*$/;

/**
 * Whether `uri` is spelled with the canonical origin. Byte-exact: no normalization, no case
 * folding, no trailing-dot tolerance (audit §5.5 — one canonical string form, compared
 * byte-exactly). A subdomain that merely ends in the canonical host is not the canonical
 * host, because the check is a prefix match on `<origin>/`.
 */
export function isCanonicalOriginIdentifier(uri: string): boolean {
  return typeof uri === "string" && uri.startsWith(`${CANONICAL_ORIGIN}/`);
}
