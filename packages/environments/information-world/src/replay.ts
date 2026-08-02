import { sha256Hex } from "./hashing.js";
import {
  InvalidRequestError,
  canonicalRequestKeyFromParts,
  canonicalRequestParts,
  type CanonicalizableRequest,
} from "./request-key.js";
import { InvalidDocumentError } from "./sealing.js";
import type { CorpusEntry, InformationWorldRecord } from "./schema.js";

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

function integrityPath(entry: CorpusEntry): string {
  return `corpus.entries.${entry.requestKey}`;
}

export async function buildReplayIndex(
  world: InformationWorldRecord,
  options: ReplayIndexOptions,
): Promise<ReplayIndex> {
  const declaredOrigins = new Set(world.corpus.origins);
  const allowlist = new Set(options.allowlist ?? world.corpus.origins);
  for (const origin of allowlist) {
    if (!declaredOrigins.has(origin)) {
      throw new CorpusIntegrityError(
        "allowlist",
        `allowlist names origin ${origin}, which this world does not declare`,
      );
    }
  }

  const entries = new Map<string, CorpusEntry>();
  const bodies = new Map<string, Uint8Array>();
  for (const entry of world.corpus.entries) {
    const path = integrityPath(entry);
    let loaded: Uint8Array;
    try {
      loaded = await options.artifacts.read(entry.response.body);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CorpusIntegrityError(path, `corpus body could not be read: ${detail}`);
    }
    if (!(loaded instanceof Uint8Array)) {
      throw new CorpusIntegrityError(path, "corpus reader did not return Uint8Array bytes");
    }

    const actualDigest = `sha256:${sha256Hex(loaded)}`;
    if (actualDigest !== entry.response.body.digest) {
      throw new CorpusIntegrityError(
        path,
        `corpus body hashes to ${actualDigest}, not ${entry.response.body.digest}`,
      );
    }
    const declaredSize = entry.response.body.sizeBytes;
    if (declaredSize !== undefined && declaredSize !== loaded.byteLength) {
      throw new CorpusIntegrityError(
        path,
        `corpus body has ${loaded.byteLength} bytes, not declared size ${declaredSize}`,
      );
    }

    entries.set(entry.requestKey, entry);
    bodies.set(entry.requestKey, loaded.slice());
  }

  return {
    world,
    allowlist,
    budget: options.budget,
    entry: (key) => entries.get(key),
    bodyOf: (key) => {
      const body = bodies.get(key);
      if (body === undefined) {
        throw new CorpusIntegrityError(`corpus.entries.${key}`, "no verified body for this key");
      }
      return body.slice();
    },
  };
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
  const { budget } = index;
  if (budget !== undefined && consumed.requests >= budget.maxRequests) {
    return { kind: "budget-exhausted", limit: "requests" };
  }

  let key: string;
  let origin: string;
  try {
    const parts = canonicalRequestParts(request, index.world.requestKeyPolicy);
    key = canonicalRequestKeyFromParts(parts, index.world.requestKeyPolicy);
    origin = parts.origin;
  } catch (error) {
    if (error instanceof InvalidRequestError) return { kind: "miss", reason: "unkeyable" };
    throw error;
  }

  if (!index.allowlist.has(origin)) return { kind: "off-allowlist", origin };

  const entry = index.entry(key);
  if (entry === undefined) return { kind: "miss", reason: "uncaptured" };

  if (budget !== undefined && consumed.bytes + index.bodyOf(key).byteLength > budget.maxResponseBytes) {
    return { kind: "budget-exhausted", limit: "bytes" };
  }

  return { kind: "hit", entry };
}
