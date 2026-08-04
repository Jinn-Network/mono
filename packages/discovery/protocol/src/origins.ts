// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical protocol identifier origin and version form, plus the translation of their
 * recognized legacy predecessors.
 *
 * DR-2026-08-04 (`log/decisions/2026-08-04-spec-origin-and-vocabulary.md`) rules two things
 * this module implements:
 *
 * - **Decision 1/2 — one dedicated origin.** All protocol URIs, names and locators alike,
 *   move to `https://spec.jinn.network/`. The apex `jinn.network` becomes purely product.
 * - **Decision 4 — major-only versions.** Type and protocol identifiers carry `v<major>`,
 *   not `<major>.<minor>`: a compatible 1.0 -> 1.1 must not change the identifier, and a
 *   breaking change is a new name. The `<major>.<minor>` form contradicted our own
 *   identifier law.
 *
 * Pre-migration bytes stay recognized as legacy input (DR §Consequences: "readers keep
 * recognizing legacy names; nothing content-addressed is edited"). That is what the legacy
 * arms below are for -- and only that.
 *
 * ## The discipline
 *
 * This follows the translate-then-key shape that
 * `packages/evidence/trace-decode/src/formats.ts` already uses for native-trace formats: a
 * legacy table plus an explicit translator, with the rule stated there --
 * **legacy spellings are inputs to translation, never selection keys.** Nothing downstream
 * dispatches on a legacy identifier. It is canonicalized first; the canonical string is the
 * only key. Two spellings of one identifier must never both reach a lookup table, because
 * then the table decides identity and the identifier stops being the identity.
 *
 * This module is the reference implementation the re-seal program's per-package waves copy.
 * It lives here, and it is copied rather than imported, because the dependency direction
 * forbids new edges into `@jinn-network/record-discovery-protocol` from the tier-2 record
 * packages (they mirror the grammar precisely so they can stay dependency-free).
 *
 * ## TRANSITION WINDOW
 *
 * Every `LEGACY_` export and every legacy arm of the grammars below is scaffolding for the
 * migration and nothing else. Component C2 of the re-seal program narrows this module to
 * the canonical origin and the canonical version form once every document in the tree has
 * been migrated, and the origin tripwire
 * (`.github/scripts/origin-tripwire.mjs`) is activated at the same time to keep the legacy
 * origin from creeping back.
 */

/** The dedicated identifier origin (DR-2026-08-04 §Decision 1). No trailing slash. */
export const CANONICAL_ORIGIN = "https://spec.jinn.network";

/**
 * LEGACY, transition window only: origins that pre-migration documents spell. Recognized so
 * that a legacy identifier is still *seen* -- an unrecognized origin would make an
 * unmigrated document silently unclaimed, which is the fail-open this window must avoid.
 * Removed by C2.
 */
export const LEGACY_ORIGINS: readonly string[] = Object.freeze(["https://jinn.network"]);

/** Every origin a reader accepts during the window, canonical first. */
export const RECOGNIZED_ORIGINS: readonly string[] = Object.freeze([
  CANONICAL_ORIGIN,
  ...LEGACY_ORIGINS,
]);

/** Canonical version segment: major-only `v<major>`, no `v0` (DR-2026-08-04 §Decision 4). */
export const CANONICAL_VERSION_GRAMMAR = /^v[1-9]\d*$/;

/** LEGACY, transition window only: the pre-re-seal `<major>.<minor>` form. Removed by C2. */
export const LEGACY_VERSION_GRAMMAR = /^\d+\.\d+$/;

/**
 * Dual-accept version grammar for the window: canonical `v<major>` or legacy
 * `<major>.<minor>`. C2 narrows this to {@link CANONICAL_VERSION_GRAMMAR}.
 */
export const VERSION_GRAMMAR = /^(?:v[1-9]\d*|\d+\.\d+)$/;

/**
 * The origin a recognized identifier is spelled with, or `undefined` when the identifier
 * belongs to no recognized origin. Byte-exact: no normalization, no case folding, no
 * trailing-dot tolerance (audit §5.5 -- one canonical string form, compared byte-exactly).
 */
export function identifierOrigin(uri: string): string | undefined {
  if (typeof uri !== "string") return undefined;
  return RECOGNIZED_ORIGINS.find((origin) => uri.startsWith(`${origin}/`));
}

/** Whether `uri` is spelled with a legacy origin (and therefore needs translation). */
export function isLegacyOriginIdentifier(uri: string): boolean {
  const origin = identifierOrigin(uri);
  return origin !== undefined && origin !== CANONICAL_ORIGIN;
}

/**
 * Translate any recognized identifier onto the canonical origin. Already-canonical input is
 * returned unchanged; an identifier from no recognized origin returns `undefined` rather
 * than being passed through, so an unrecognized name can never masquerade as canonical.
 *
 * The path is copied verbatim: only the origin moves. Version translation is a separate
 * decision and lives in {@link canonicalVersionSegment}.
 */
export function canonicalizeOrigin(uri: string): string | undefined {
  const origin = identifierOrigin(uri);
  if (origin === undefined) return undefined;
  return origin === CANONICAL_ORIGIN ? uri : `${CANONICAL_ORIGIN}${uri.slice(origin.length)}`;
}

/**
 * Translate a version segment to the canonical major-only form. `v1` is returned unchanged;
 * `1.0` and `1.1` both translate to `v1`, which is exactly the DR's rule -- a compatible
 * minor revision was never supposed to change the identifier. A segment that is neither
 * form, or a major-0 legacy version (no `v0` exists under the canonical grammar), returns
 * `undefined`.
 */
export function canonicalVersionSegment(version: string): string | undefined {
  if (typeof version !== "string") return undefined;
  if (CANONICAL_VERSION_GRAMMAR.test(version)) return version;
  const legacy = /^([1-9]\d*)\.\d+$/.exec(version);
  return legacy === null ? undefined : `v${legacy[1]}`;
}
