import { z } from "zod";
import { MEDIA_WELL_KNOWN, RECORD_DISCOVERY_VERSION, WELL_KNOWN_PATH, sealJson } from "@jinn-network/record-discovery-protocol";

import type { BlobStore } from "./ports.js";

// The well-known discovery document (design §7 item 3): lists the sources a
// host serves. Its schema is part of the protocol, not implementation-
// discretionary -- it *introduces* sources, but acceptance is always policy
// plus `source-chain-verification` (introduction is never trust).

export interface WellKnownSourceEntry {
  agent: string;
  name: string;
  headPath: string;
  /**
   * Where this source's newest archive page lives, as a URL that MUST resolve
   * inside the serving root that served this document (§7 item 3).
   *
   * Normative, and enforced client-side since #3411: a consumer resolves this
   * against the serving root the OPERATOR configured and REFUSES an
   * `archiveRoot` that leaves it -- a different origin, an origin-relative path
   * that escapes the root's own path prefix, a non-HTTP(S) scheme, or embedded
   * credentials. So a producer that advertises `https://cdn.example/...` from
   * an archive served at `https://peer.example/...` is hard-refused, not
   * followed.
   *
   * The invariant is not new, only newly stated: `sync.ts` has always rebuilt
   * every archive page after the first as `servingRoot + path`, so a
   * cross-origin `archiveRoot` could only ever have worked for page one. Emit a
   * root-relative path (what every in-repo producer does) and containment holds
   * by construction.
   */
  archiveRoot: string;
  /** Declared confirmation depth for projections (§6.2). */
  confirmationDepth?: number;
  /** Declared substrate for projections (§6.2/§6.3). */
  substrate?: string;
}

export interface WellKnownDocument {
  protocol: string;
  sources: WellKnownSourceEntry[];
}

const WellKnownSourceEntrySchema = z.looseObject({
  agent: z.string().min(1),
  name: z.string().min(1),
  headPath: z.string().min(1),
  // Shape only. Containment (see `WellKnownSourceEntry.archiveRoot`) is
  // deliberately NOT a schema rule: it is relational -- it holds between this
  // value and the serving root that served the document, which the schema
  // cannot see. The consumer enforces it at resolution time
  // (`discovery/client`'s `resolveContainedUrl`), which is also the only place
  // that knows the root the operator actually configured.
  archiveRoot: z.string().min(1),
  confirmationDepth: z.number().int().nonnegative().optional(),
  substrate: z.string().min(1).optional(),
});

const WellKnownDocumentSchema = z.looseObject({
  protocol: z.literal(RECORD_DISCOVERY_VERSION),
  sources: z.array(WellKnownSourceEntrySchema),
});

/** Parses and validates a well-known discovery document against its in-protocol schema. */
export function parseWellKnownDocument(json: unknown): WellKnownDocument {
  return WellKnownDocumentSchema.parse(json) as WellKnownDocument;
}

/** Validates, then writes the sealed well-known document at the fixed `WELL_KNOWN_PATH`. */
export async function writeWellKnownDocument(store: BlobStore, document: WellKnownDocument): Promise<void> {
  parseWellKnownDocument(document);
  const { bytes } = sealJson(document);
  await store.put(WELL_KNOWN_PATH, bytes, MEDIA_WELL_KNOWN);
}
