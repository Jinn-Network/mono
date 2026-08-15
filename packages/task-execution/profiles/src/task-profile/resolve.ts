import { ProfilesError } from "../errors.js";
import { sealTaskProfile } from "./seal.js";
import type { TaskProfileDocument } from "./schema.js";

/** The minimal shape this module needs from a ResourceDescriptor (§6.4). */
export interface ProfileDescriptor {
  uri?: string;
  digest?: Record<string, string>;
}

export interface ProfileStore {
  get(digest: `sha256:${string}`): TaskProfileDocument | undefined;
}

/**
 * Resolution (design §6.2): backend support means (URI, resolvable digest). Throws
 * `unsupported-profile`, naming the unresolvable digest, when the descriptor carries no sha256
 * digest or the store lacks that digest — a backend never validates against a differently-
 * digested cache for the same URI. Additionally re-seals the resolved document and refuses it if
 * its own digest does not match the pinned digest (a store bug, not a legitimate resolution).
 */
export function resolveProfile(descriptor: ProfileDescriptor, store: ProfileStore): TaskProfileDocument {
  const hex = descriptor.digest?.sha256;
  const uriLabel = descriptor.uri ?? "<unknown URI>";
  if (hex === undefined) {
    throw new ProfilesError(
      "unsupported-profile",
      `profile descriptor for "${uriLabel}" carries no sha256 digest to resolve.`,
    );
  }
  const digest = `sha256:${hex}` as const;
  const doc = store.get(digest);
  if (doc === undefined) {
    throw new ProfilesError(
      "unsupported-profile",
      `profile digest ${digest} for "${uriLabel}" is not resolvable in the store.`,
    );
  }
  const actual = sealTaskProfile(doc).digest;
  if (actual !== digest) {
    throw new ProfilesError(
      "unsupported-profile",
      `profile URI "${uriLabel}" resolved to a document whose digest ${actual} does not match `
        + `the pinned digest ${digest}.`,
    );
  }
  return doc;
}
