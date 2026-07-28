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
