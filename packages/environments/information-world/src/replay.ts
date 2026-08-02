import { sha256Hex } from "./hashing.js";
import {
  InvalidRequestError,
  canonicalRequestKeyFromParts,
  canonicalRequestParts,
  type CanonicalizableRequest,
} from "./request-key.js";
import { InvalidDocumentError } from "./sealing.js";
import {
  parseInformationWorldRecord,
  sealInformationWorldRecord,
  type CorpusEntry,
  type InformationWorldRecord,
} from "./schema.js";

/** The injected custody boundary for corpus bytes. */
export interface CorpusArtifactReader {
  read(descriptor: { readonly digest: string; readonly uri?: string }): Promise<Uint8Array>;
}

export interface RequestBudget {
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
}

export interface ReplayIndexOptions {
  readonly artifacts: CorpusArtifactReader;
  readonly allowlist?: readonly string[];
  readonly budget?: RequestBudget;
}

export interface ReplayIndex {
  readonly world: InformationWorldRecord;
  readonly allowlist: ReadonlySet<string>;
  readonly budget: RequestBudget | undefined;
  entry(key: string): CorpusEntry | undefined;
  bodyOf(key: string): Uint8Array;
}

export interface Consumed {
  readonly requests: number;
  readonly bytes: number;
}

export type ReplayOutcome =
  | { readonly kind: "hit"; readonly entry: CorpusEntry }
  | { readonly kind: "miss"; readonly reason: "uncaptured" | "unkeyable" }
  | { readonly kind: "off-allowlist"; readonly origin: string }
  | { readonly kind: "budget-exhausted"; readonly limit: "requests" | "bytes" };

/** A record cannot be replayed when one of its declared resources is not exact. */
export class CorpusIntegrityError extends InvalidDocumentError {
  constructor(path: string, message: string) {
    super([{ path, message }]);
    this.name = "CorpusIntegrityError";
  }
}

interface CapturedCorpusEntry {
  readonly entry: CorpusEntry;
  readonly key: string;
  readonly path: string;
  readonly digest: string;
  readonly declaredSize: number | undefined;
  readonly descriptor: Readonly<{ digest: string; uri?: string }>;
}

interface ReplayState {
  readonly world: InformationWorldRecord;
  readonly allowlist: ReadonlySet<string>;
  readonly budget: RequestBudget | undefined;
  readonly entries: ReadonlyMap<string, CorpusEntry>;
  readonly bodies: ReadonlyMap<string, Uint8Array>;
}

const replayStates = new WeakMap<object, ReplayState>();

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function detailOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown failure";
  }
}

function asIntegrityError(path: string, action: string, error: unknown): CorpusIntegrityError {
  try {
    if (error instanceof CorpusIntegrityError) return error;
  } catch {
    // A hostile thrown value must not bypass the construction failure boundary.
  }
  return new CorpusIntegrityError(path, `${action}: ${detailOf(error)}`);
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) freezeDeep(descriptor.value);
  }
  return Object.freeze(value);
}

function snapshotWorld(world: InformationWorldRecord): InformationWorldRecord {
  return freezeDeep(parseInformationWorldRecord(sealInformationWorldRecord(world)));
}

function snapshotBudget(value: RequestBudget | undefined): RequestBudget | undefined {
  if (value === undefined) return undefined;
  const { maxRequests, maxResponseBytes } = value;
  if (!isNonnegativeSafeInteger(maxRequests) || !isNonnegativeSafeInteger(maxResponseBytes)) {
    throw new CorpusIntegrityError(
      "budget",
      "maxRequests and maxResponseBytes must be nonnegative safe integers",
    );
  }
  return Object.freeze({ maxRequests, maxResponseBytes });
}

function readonlySet(values: ReadonlySet<string>): ReadonlySet<string> {
  const members = new Set(values);
  const snapshot = Object.freeze([...members]);
  let facade: ReadonlySet<string>;
  facade = Object.freeze({
    size: snapshot.length,
    has: (value: string): boolean => members.has(value),
    entries: () => snapshot.map((value) => [value, value] as [string, string])[Symbol.iterator](),
    keys: () => snapshot[Symbol.iterator](),
    values: () => snapshot[Symbol.iterator](),
    [Symbol.iterator]: () => snapshot[Symbol.iterator](),
    forEach: (
      callback: (value: string, valueAgain: string, set: ReadonlySet<string>) => void,
      thisArg?: unknown,
    ): void => {
      for (const value of snapshot) callback.call(thisArg, value, value, facade);
    },
  }) as ReadonlySet<string>;
  return facade;
}

function captureEntries(world: InformationWorldRecord): readonly CapturedCorpusEntry[] {
  return world.corpus.entries.map((entry) => {
    const key = entry.requestKey;
    const body = entry.response.body;
    const digest = body.digest;
    const declaredSize = body.sizeBytes;
    const descriptor = body.uri === undefined
      ? Object.freeze({ digest })
      : Object.freeze({ digest, uri: body.uri });
    return Object.freeze({
      entry,
      key,
      path: `corpus.entries.${key}`,
      digest,
      declaredSize,
      descriptor,
    });
  });
}

function snapshotConsumed(value: unknown): Consumed | undefined {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const { requests, bytes } = value as { requests?: unknown; bytes?: unknown };
    if (!isNonnegativeSafeInteger(requests) || !isNonnegativeSafeInteger(bytes)) return undefined;
    return { requests, bytes };
  } catch {
    return undefined;
  }
}

function stateFor(value: unknown): ReplayState | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  return replayStates.get(value);
}

export async function buildReplayIndex(
  world: InformationWorldRecord,
  options: ReplayIndexOptions,
): Promise<ReplayIndex> {
  let snapshot: InformationWorldRecord;
  let captured: readonly CapturedCorpusEntry[];
  let reader: CorpusArtifactReader;
  let read: CorpusArtifactReader["read"];
  let allowlist: ReadonlySet<string>;
  let budget: RequestBudget | undefined;
  try {
    snapshot = snapshotWorld(world);
    reader = options.artifacts;
    read = reader.read;
    if (typeof read !== "function") throw new TypeError("artifact reader must provide read()");

    const declaredOrigins = new Set(snapshot.corpus.origins);
    const requestedOrigins = options.allowlist === undefined
      ? [...snapshot.corpus.origins]
      : [...options.allowlist];
    const requested = new Set(requestedOrigins);
    for (const origin of requested) {
      if (!declaredOrigins.has(origin)) {
        throw new CorpusIntegrityError(
          "allowlist",
          `allowlist names origin ${origin}, which this world does not declare`,
        );
      }
    }
    allowlist = readonlySet(requested);
    budget = snapshotBudget(options.budget);
    captured = captureEntries(snapshot);
  } catch (error) {
    throw asIntegrityError("replay", "could not snapshot replay construction inputs", error);
  }

  const entries = new Map<string, CorpusEntry>();
  const bodies = new Map<string, Uint8Array>();
  for (const corpusEntry of captured) {
    try {
      const loaded = await read.call(reader, corpusEntry.descriptor);
      if (!(loaded instanceof Uint8Array)) {
        throw new TypeError("corpus reader did not return Uint8Array bytes");
      }
      const owned = Uint8Array.from(loaded);
      const actualDigest = `sha256:${sha256Hex(owned)}`;
      if (actualDigest !== corpusEntry.digest) {
        throw new CorpusIntegrityError(
          corpusEntry.path,
          `corpus body hashes to ${actualDigest}, not ${corpusEntry.digest}`,
        );
      }
      if (corpusEntry.declaredSize !== undefined && corpusEntry.declaredSize !== owned.byteLength) {
        throw new CorpusIntegrityError(
          corpusEntry.path,
          `corpus body has ${owned.byteLength} bytes, not declared size ${corpusEntry.declaredSize}`,
        );
      }
      entries.set(corpusEntry.key, corpusEntry.entry);
      bodies.set(corpusEntry.key, owned);
    } catch (error) {
      throw asIntegrityError(corpusEntry.path, "could not materialize corpus body", error);
    }
  }

  const state: ReplayState = Object.freeze({
    world: snapshot,
    allowlist,
    budget,
    entries,
    bodies,
  });
  const index = Object.freeze({
    world: snapshot,
    allowlist,
    budget,
    entry: (key: string): CorpusEntry | undefined => state.entries.get(key),
    bodyOf: (key: string): Uint8Array => {
      const body = state.bodies.get(key);
      if (body === undefined) {
        throw new CorpusIntegrityError(`corpus.entries.${key}`, "no verified body for this key");
      }
      return Uint8Array.from(body);
    },
  });
  replayStates.set(index, state);
  return index;
}

/**
 * Make the replay decision without I/O or mutation. The caller owns consumption accounting.
 * Order is intentional: a spent budget cannot be bypassed via an unkeyable or off-list request.
 */
export function resolveReplay(
  index: ReplayIndex,
  request: CanonicalizableRequest,
  consumed: Consumed,
): ReplayOutcome {
  const state = stateFor(index);
  const counters = snapshotConsumed(consumed);
  if (state === undefined || counters === undefined) return { kind: "miss", reason: "unkeyable" };

  const { budget } = state;
  if (budget !== undefined && counters.requests >= budget.maxRequests) {
    return { kind: "budget-exhausted", limit: "requests" };
  }

  let key: string;
  let origin: string;
  try {
    const parts = canonicalRequestParts(request, state.world.requestKeyPolicy);
    key = canonicalRequestKeyFromParts(parts, state.world.requestKeyPolicy);
    origin = parts.origin;
  } catch (error) {
    if (error instanceof InvalidRequestError) return { kind: "miss", reason: "unkeyable" };
    throw error;
  }

  if (!state.allowlist.has(origin)) return { kind: "off-allowlist", origin };

  const entry = state.entries.get(key);
  if (entry === undefined) return { kind: "miss", reason: "uncaptured" };

  if (budget !== undefined) {
    const body = state.bodies.get(key);
    if (body === undefined || body.byteLength > budget.maxResponseBytes - counters.bytes) {
      return { kind: "budget-exhausted", limit: "bytes" };
    }
  }

  return { kind: "hit", entry };
}
