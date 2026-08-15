import { RECORDS_SEGMENT, SEQUENCE_WIDTH, SOURCE_NAME_GRAMMAR } from "./identifiers.js";
import { CANONICAL_ORIGIN, CANONICAL_VERSION_GRAMMAR } from "./origins.js";

/** Source names match SOURCE_NAME_GRAMMAR (§5.1): lowercase alphanumeric plus interior hyphens, ≤64 chars. */
export function isSourceName(name: string): boolean {
  return SOURCE_NAME_GRAMMAR.test(name);
}

/** The one records root: `https://spec.jinn.network/records` (DR-2026-08-04). */
export const RECORDS_KIND_ROOT = `${CANONICAL_ORIGIN}/${RECORDS_SEGMENT}`;

/**
 * Splits a record-kind URI into its parts, or returns `undefined` when the input does not
 * conform. One origin, one version form -- see `./origins.ts`.
 */
export function parseRecordKindUri(
  uri: string,
): { root: string; segment: string; version: string } | undefined {
  if (typeof uri !== "string" || !uri.startsWith(`${RECORDS_KIND_ROOT}/`)) return undefined;
  const parts = uri.slice(RECORDS_KIND_ROOT.length + 1).split("/");
  if (parts.length !== 2) return undefined;
  const [segment, version] = parts as [string, string];
  if (!isSourceName(segment) || !CANONICAL_VERSION_GRAMMAR.test(version)) return undefined;
  return { root: RECORDS_KIND_ROOT, segment, version };
}

/**
 * Record-kind URI grammar (§12): `https://spec.jinn.network/records/<segment>/v<major>`,
 * segment matching SOURCE_NAME_GRAMMAR. Throws on any non-conforming input.
 */
export function assertRecordKindUri(uri: string): void {
  if (typeof uri !== "string" || !uri.startsWith(`${RECORDS_KIND_ROOT}/`)) {
    throw new Error(`Record-kind URI must start with "${RECORDS_KIND_ROOT}/": ${uri}`);
  }
  const parts = uri.slice(RECORDS_KIND_ROOT.length + 1).split("/");
  if (parts.length !== 2) {
    throw new Error(
      `Record-kind URI must have the shape ${RECORDS_KIND_ROOT}/<segment>/<version>: ${uri}`,
    );
  }
  const [segment, version] = parts as [string, string];
  if (!isSourceName(segment)) {
    throw new Error(`Record-kind URI segment is not a valid source-name-shaped segment: ${segment}`);
  }
  if (!CANONICAL_VERSION_GRAMMAR.test(version)) {
    throw new Error(`Record-kind URI version must be v<major>: ${version}`);
  }
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
