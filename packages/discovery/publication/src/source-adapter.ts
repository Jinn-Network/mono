import type { DurableSourceWriter } from "@jinn-network/record-discovery-serve";
import type { PublicationAnnouncementPort, PublicationRecord } from "./types.js";

/**
 * Adapts the durable, single-record Record Discovery append transaction to the
 * neutral plan executor. The source writer remains the authority for signing,
 * exact record storage, source-chain idempotency, and recovery.
 */
export function createDiscoverySourceAnnouncementPort(input: {
  readonly writer: DurableSourceWriter;
  readonly timestamp: (record: PublicationRecord) => string;
  readonly facts?: (record: PublicationRecord) => unknown;
}): PublicationAnnouncementPort {
  return {
    async announce({ idempotencyKey, record }) {
      if (record.authority.mode === "origin-reference") {
        throw new Error("An origin-reference record must never be reannounced through a local source.");
      }
      return input.writer.append({
        timestamp: input.timestamp(record),
        announcement: {
          announcementId: idempotencyKey,
          action: "available",
          record: { kind: record.kind, digest: record.digest, mediaType: record.mediaType },
          ...(input.facts === undefined ? {} : { facts: input.facts(record) }),
        },
        record: { bytes: new Uint8Array(record.bytes), contentType: record.mediaType },
      });
    },
  };
}
