import type {
  AnnouncementEntry,
  AnnouncedItem,
  SourceHead,
} from "@jinn-network/record-discovery-protocol";
// DsseEnvelope is trust-core's type (verifySourceChain's declaration file
// references it from there, not re-exported through protocol's own index);
// import it directly since testing already carries trust-core as a
// devDependency (see package.json's shadow-dependency note, Task 9).
import type { DsseEnvelope } from "@jinn-network/trust-core";
import type { Vector } from "./vectors.js";

// Low-level driving utilities shared by conformance.ts's six exported
// `run*Conformance` suites (plan Task 11). Vector-interpretation lives
// here so conformance.ts stays a thin per-plane mapping from vectors to
// assertions.

/** Wraps a plain array as the AsyncIterable `verifySourceChain` expects for `entries`. */
export async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// -- source-chain vector shape recognition --------------------------------

export interface RunnableSourceChainInput {
  seed: { now: string; keys: unknown[]; hwm: unknown };
  firstAdoption: boolean;
  head: SourceHead;
  headSignature: DsseEnvelope;
  entries: Array<{ entry: AnnouncementEntry; signature: DsseEnvelope }>;
}

/**
 * The canonical, fully-specified source-chain vector shape: everything
 * `verifySourceChain` needs in one call. Some §18 vectors document a
 * DIFFERENT surface instead (two independently observed heads for a
 * cross-head fork comparison, an archive-page ceiling, or the M5
 * source-conformance scenarios) -- those are driven by their own
 * assertions in conformance.ts rather than a direct `verify()` call.
 */
export function isRunnableSourceChainInput(input: unknown): input is RunnableSourceChainInput {
  if (typeof input !== "object" || input === null) return false;
  const record = input as Record<string, unknown>;
  return (
    "head" in record &&
    "headSignature" in record &&
    "entries" in record &&
    Array.isArray(record["entries"]) &&
    typeof record["firstAdoption"] === "boolean"
  );
}

/** Vectors whose `input` intentionally fails Announcement Entry *parsing* before source-chain-verification even runs (§18 corpus completeness; primary coverage is M1's entry.test.ts). */
export function isParseErrorVector(vector: Vector): boolean {
  return (vector.expect as { status?: string }).status === "parse-error";
}

// -- item / facts-consistency / derivation-consistency vector shapes ------

export interface FactsConsistencyVectorInput {
  item: AnnouncedItem;
  profile?: unknown;
  recordBytes: unknown;
  sourceClass?: "author" | "projection";
  withheldReferencedDigests?: `sha256:${string}`[];
  decisionGrade?: boolean;
}

export function isFactsConsistencyInput(input: unknown): input is FactsConsistencyVectorInput {
  if (typeof input !== "object" || input === null) return false;
  const record = input as Record<string, unknown>;
  return "item" in record && "recordBytes" in record;
}

export interface ItemVectorInput {
  item: AnnouncedItem;
  fetchedBytes?: string;
  citedEntryReachable?: boolean;
  decisionGrade?: boolean;
}

export function isItemInput(input: unknown): input is ItemVectorInput {
  if (typeof input !== "object" || input === null) return false;
  return "item" in (input as Record<string, unknown>);
}

export interface DerivationConsistencyVectorInput {
  item: AnnouncedItem;
  /**
   * The item's own record bytes, seeded into `RecordFetcher` so `verifyItem`
   * step 1 (`fetch` + re-hash, §10.4) can succeed ahead of the derivation
   * check under test -- present whenever the vector's `item.record.digest`
   * is digest-consistent with these bytes (finding, M4: the derivation-
   * consistency vectors originally carried a digest with no seeded preimage
   * anywhere in the harness, which made step 1 throw before step 4 was ever
   * reached; the fixtures were corrected to carry matching bytes).
   */
  recordBytes?: unknown;
}
