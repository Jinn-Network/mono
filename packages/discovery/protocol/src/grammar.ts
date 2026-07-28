import { RECORDS_ROOT, SEQUENCE_WIDTH, SOURCE_NAME_GRAMMAR } from "./identifiers.js";

/** Source names match SOURCE_NAME_GRAMMAR (§5.1): lowercase alphanumeric plus interior hyphens, ≤64 chars. */
export function isSourceName(name: string): boolean {
  return SOURCE_NAME_GRAMMAR.test(name);
}

const RECORD_KIND_VERSION_GRAMMAR = /^\d+\.\d+$/;

/**
 * Record-kind URI grammar (§12): `${RECORDS_ROOT}/<segment>/<major>.<minor>`,
 * segment matching SOURCE_NAME_GRAMMAR. Throws on any non-conforming input.
 */
export function assertRecordKindUri(uri: string): void {
  const prefix = `${RECORDS_ROOT}/`;
  if (!uri.startsWith(prefix)) {
    throw new Error(`Record-kind URI must start with "${prefix}": ${uri}`);
  }
  const parts = uri.slice(prefix.length).split("/");
  if (parts.length !== 2) {
    throw new Error(
      `Record-kind URI must have the shape ${RECORDS_ROOT}/<segment>/<major>.<minor>: ${uri}`,
    );
  }
  const [segment, version] = parts as [string, string];
  if (!isSourceName(segment)) {
    throw new Error(`Record-kind URI segment is not a valid source-name-shaped segment: ${segment}`);
  }
  if (!RECORD_KIND_VERSION_GRAMMAR.test(version)) {
    throw new Error(`Record-kind URI version must be <major>.<minor>: ${version}`);
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
