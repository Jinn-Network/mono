import { RECORDS_SEGMENT, SEQUENCE_WIDTH, SOURCE_NAME_GRAMMAR } from "./identifiers.js";
import {
  CANONICAL_ORIGIN,
  RECOGNIZED_ORIGINS,
  VERSION_GRAMMAR,
  canonicalVersionSegment,
} from "./origins.js";

/** Source names match SOURCE_NAME_GRAMMAR (§5.1): lowercase alphanumeric plus interior hyphens, ≤64 chars. */
export function isSourceName(name: string): boolean {
  return SOURCE_NAME_GRAMMAR.test(name);
}

/**
 * The records container under every recognized origin, canonical first. During the
 * DR-2026-08-04 transition window the legacy `https://jinn.network/records` root is still
 * recognized, because pre-migration documents spell their kind that way; C2 narrows this to
 * the canonical root alone once the re-seal has landed. See `./origins.ts`.
 */
export const RECORD_KIND_ROOTS: readonly string[] = Object.freeze(
  RECOGNIZED_ORIGINS.map((origin) => `${origin}/${RECORDS_SEGMENT}`),
);

/** The canonical records root: `https://spec.jinn.network/records`. */
export const CANONICAL_RECORDS_ROOT = `${CANONICAL_ORIGIN}/${RECORDS_SEGMENT}`;

/**
 * Splits a record-kind URI into its parts, or returns `undefined` when the input does not
 * conform. Accepts either recognized origin and either version form (canonical `v<major>`
 * or legacy `<major>.<minor>`) -- see `./origins.ts` for why both, and for how long.
 */
export function parseRecordKindUri(
  uri: string,
): { root: string; segment: string; version: string } | undefined {
  if (typeof uri !== "string") return undefined;
  const root = RECORD_KIND_ROOTS.find((candidate) => uri.startsWith(`${candidate}/`));
  if (root === undefined) return undefined;
  const parts = uri.slice(root.length + 1).split("/");
  if (parts.length !== 2) return undefined;
  const [segment, version] = parts as [string, string];
  if (!isSourceName(segment) || !VERSION_GRAMMAR.test(version)) return undefined;
  return { root, segment, version };
}

/**
 * Record-kind URI grammar (§12): `<records-root>/<segment>/<version>`, segment matching
 * SOURCE_NAME_GRAMMAR. Throws on any non-conforming input.
 */
export function assertRecordKindUri(uri: string): void {
  const root = RECORD_KIND_ROOTS.find(
    (candidate) => typeof uri === "string" && uri.startsWith(`${candidate}/`),
  );
  if (root === undefined) {
    throw new Error(
      `Record-kind URI must start with one of ${RECORD_KIND_ROOTS.map((candidate) => `"${candidate}/"`).join(", ")}: ${uri}`,
    );
  }
  const parts = uri.slice(root.length + 1).split("/");
  if (parts.length !== 2) {
    throw new Error(
      `Record-kind URI must have the shape ${root}/<segment>/<version>: ${uri}`,
    );
  }
  const [segment, version] = parts as [string, string];
  if (!isSourceName(segment)) {
    throw new Error(`Record-kind URI segment is not a valid source-name-shaped segment: ${segment}`);
  }
  if (!VERSION_GRAMMAR.test(version)) {
    throw new Error(
      `Record-kind URI version must be v<major> (canonical) or <major>.<minor> (legacy): ${version}`,
    );
  }
}

/**
 * Translate any recognized record-kind URI to its canonical form -- canonical origin,
 * major-only version. Returns `undefined` for a non-conforming input rather than passing it
 * through, so a name that is not a record kind can never be keyed on as if it were one.
 *
 * This is the translate-then-key entry point for record kinds: callers canonicalize once at
 * the boundary and key on the result. A legacy spelling is never itself a selection key
 * (`./origins.ts`, and `packages/evidence/trace-decode/src/formats.ts` for the same
 * discipline applied to native-trace formats).
 */
export function canonicalizeRecordKindUri(uri: string): string | undefined {
  const parsed = parseRecordKindUri(uri);
  if (parsed === undefined) return undefined;
  const version = canonicalVersionSegment(parsed.version);
  if (version === undefined) return undefined;
  return `${CANONICAL_RECORDS_ROOT}/${parsed.segment}/${version}`;
}

/** Source Head `origin` grammar (§5.2): the agent IRI, a single "/", the source name. */
export function formatOrigin(agent: string, name: string): string {
  return `${agent}/${name}`;
}

/**
 * Splits an `origin` string on its *last* "/" (§5.2): source names contain no
 * "/" (SOURCE_NAME_GRAMMAR), so the last "/" always separates unambiguously,
 * regardless of whether the agent IRI itself contains slashes.
 */
export function splitOrigin(origin: string): { agent: string; name: string } {
  const index = origin.lastIndexOf("/");
  if (index === -1) {
    throw new Error(
      `Origin must contain a "/" separating the agent IRI from the source name: ${origin}`,
    );
  }
  return { agent: origin.slice(0, index), name: origin.slice(index + 1) };
}

/** Fixed-width 16-digit decimal sequence formatting (§5.1). */
export function formatSequence(n: bigint): string {
  if (n < 1n) {
    throw new Error(`Sequence must be a positive integer: ${n}`);
  }
  const digits = n.toString();
  if (digits.length > SEQUENCE_WIDTH) {
    throw new Error(`Sequence exceeds the fixed ${SEQUENCE_WIDTH}-digit width: ${n}`);
  }
  return digits.padStart(SEQUENCE_WIDTH, "0");
}

/** Increments a sequence by exactly one; gaps are forbidden (§5.1). */
export function nextSequence(prev: string): string {
  return formatSequence(BigInt(prev) + 1n);
}
