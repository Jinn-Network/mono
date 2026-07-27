// SPDX-License-Identifier: Apache-2.0
import { EvidencePublicationError } from "./errors.js";
import { snapshotPreparedAnnouncement } from "./identities.js";
import type { PublicationOperation } from "./operation.js";
import type {
  AnnouncementMember,
  AnnouncementSink,
  PreparedPublicationPartition,
} from "./types.js";

function declaredPositiveLimit(
  value: number | undefined,
  role: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EvidencePublicationError(
      "SINK_PROTOCOL_VIOLATION",
      `${role} must be a positive safe integer when declared.`,
    );
  }
  return value;
}

function fitsDeclaredLimits(
  memberCount: number,
  frameBytes: number,
  sink: AnnouncementSink,
): boolean {
  const maxMembers = declaredPositiveLimit(
    sink.capabilities.maxMembersPerAnnouncement,
    "Sink maxMembersPerAnnouncement",
  );
  const maxBytes = declaredPositiveLimit(
    sink.capabilities.maxFrameBytes,
    "Sink maxFrameBytes",
  );
  return (
    (maxMembers === undefined || memberCount <= maxMembers) &&
    (maxBytes === undefined || frameBytes <= maxBytes)
  );
}

async function prepareCandidate(
  members: readonly AnnouncementMember[],
  destination: string,
  ordinal: number,
  sink: AnnouncementSink,
  operation: PublicationOperation,
) {
  operation.assertActive();
  const expectedMembers = members.map(({ reference }) => ({
    reference: { ...reference },
  }));
  const suppliedMembers = expectedMembers.map(({ reference }) => ({
    reference: { ...reference },
  }));
  const expectedContext = {
    destination,
    partitionOrdinal: ordinal,
  };
  const suppliedContext = { ...expectedContext };
  const untrusted = await sink.prepare(
    suppliedMembers,
    suppliedContext,
    operation.dependencyOptions,
  );
  operation.assertActive();
  return snapshotPreparedAnnouncement(
    untrusted,
    expectedMembers,
    sink.medium,
    sink.profile,
  );
}

export async function prepareAnnouncementPartitionsWithOperation(
  members: readonly AnnouncementMember[],
  destination: string,
  sink: AnnouncementSink,
  operation: PublicationOperation,
): Promise<readonly PreparedPublicationPartition[]> {
  operation.assertActive();
  if (!Array.isArray(members) || members.length === 0) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "Publication partitioning requires at least one record member.",
    );
  }

  const partitions: PreparedPublicationPartition[] = [];
  let nextMember = 0;

  while (nextMember < members.length) {
    const ordinal = partitions.length;
    let candidate: readonly AnnouncementMember[] = [];
    let best:
      | PreparedPublicationPartition
      | undefined;

    while (nextMember < members.length) {
      const nextCandidate = [
        ...candidate,
        members[nextMember]!,
      ];
      const prepared = await prepareCandidate(
        nextCandidate,
        destination,
        ordinal,
        sink,
        operation,
      );
      if (
        !fitsDeclaredLimits(
          nextCandidate.length,
          prepared.frameBytes.byteLength,
          sink,
        )
      ) {
        break;
      }
      candidate = nextCandidate;
      best = {
        ordinal,
        prepared,
        placement: { status: "unplaced" },
      };
      nextMember += 1;
    }

    if (best === undefined) {
      throw new EvidencePublicationError(
        "FRAME_TOO_LARGE",
        "A single exact announcement frame exceeds sink capabilities.",
      );
    }
    partitions.push(best);
  }

  return partitions;
}
