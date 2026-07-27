// SPDX-License-Identifier: Apache-2.0
import { createRecordReference } from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import {
  prepareAnnouncementPartitions,
} from "./partition.js";
import { hashExactBytes } from "./identities.js";
import {
  InMemoryAnnouncementSink,
} from "./testing.js";
import type { AnnouncementSink } from "./types.js";

function members(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    reference: createRecordReference(
      "execution-evidence",
      new Uint8Array([index + 1]),
    ),
  }));
}

describe("exact announcement partitioning", () => {
  test("greedily selects the largest exact prepared frame that fits", async () => {
    const sink = new InMemoryAnnouncementSink({
      medium: "https://publication.test/medium",
      profile: "https://publication.test/profiles/canonical-json/v1",
      maxMembersPerAnnouncement: 2,
      maxFrameBytes: 100_000,
    });

    const partitions = await prepareAnnouncementPartitions(
      members(5),
      "urn:jinn:publication-destination:partition-test",
      sink,
    );

    expect(partitions.map(({ prepared }) => prepared.members.length)).toEqual([
      2,
      2,
      1,
    ]);
    expect(partitions.map(({ ordinal }) => ordinal)).toEqual([0, 1, 2]);
    expect(sink.placementEffectCount).toBe(0);
  });

  test("uses exact sink frame bytes rather than record body sizes", async () => {
    const probe = new InMemoryAnnouncementSink({
      medium: "https://publication.test/medium",
      profile: "https://publication.test/profiles/canonical-json/v1",
    });
    const candidate = members(2);
    const prepared = await probe.prepare(candidate, {
      destination: "urn:jinn:publication-destination:partition-test",
      partitionOrdinal: 0,
    });
    const sink = new InMemoryAnnouncementSink({
      medium: probe.medium,
      profile: probe.profile,
      maxFrameBytes: prepared.frameSize - 1,
    });

    const partitions = await prepareAnnouncementPartitions(
      candidate,
      "urn:jinn:publication-destination:partition-test",
      sink,
    );

    expect(partitions).toHaveLength(2);
    expect(partitions.every(({ prepared }) =>
      prepared.frameSize <= prepared.frameBytes.byteLength
    )).toBe(true);
  });

  test("rejects a single exact frame that cannot fit", async () => {
    const sink = new InMemoryAnnouncementSink({
      medium: "https://publication.test/medium",
      profile: "https://publication.test/profiles/canonical-json/v1",
      maxFrameBytes: 1,
    });

    await expect(
      prepareAnnouncementPartitions(
        members(1),
        "urn:jinn:publication-destination:partition-test",
        sink,
      ),
    ).rejects.toMatchObject({ code: "FRAME_TOO_LARGE" });
  });

  test("honors cancellation around preparation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareAnnouncementPartitions(
        members(1),
        "urn:jinn:publication-destination:partition-test",
        new InMemoryAnnouncementSink({
          medium: "https://publication.test/medium",
          profile: "https://publication.test/profiles/canonical-json/v1",
        }),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });

  test("keeps the original caller signal when prepare silently tries to replace it", async () => {
    const controller = new AbortController();
    const replacement = new AbortController();
    const callerOptions = { signal: controller.signal };
    const frameBytes = Uint8Array.of(1, 2, 3);
    let receivedOptions: object | undefined;
    let mutationResult: boolean | undefined;
    const mutatingSink: AnnouncementSink = {
      medium: "https://publication.test/mutation-medium",
      profile: "https://publication.test/profiles/mutation/v1",
      capabilities: {},
      prepare: async (candidate, _context, options) => {
        receivedOptions = options;
        controller.abort();
        mutationResult = Reflect.set(
          options as object,
          "signal",
          replacement.signal,
        );
        return {
          medium: "https://publication.test/mutation-medium",
          profile: "https://publication.test/profiles/mutation/v1",
          members: candidate.map(({ reference }) => ({
            reference: { ...reference },
          })),
          frameBytes: Uint8Array.from(frameBytes),
          frameDigest: hashExactBytes(frameBytes),
          frameSize: frameBytes.byteLength,
        };
      },
      place: async () => {
        throw new Error("unexpected placement");
      },
      reconcile: async () => {
        throw new Error("unexpected reconciliation");
      },
    };

    await expect(
      prepareAnnouncementPartitions(
        members(1),
        "urn:jinn:publication-destination:partition-options",
        mutatingSink,
        callerOptions,
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    expect(receivedOptions).not.toBe(callerOptions);
    expect(Object.isFrozen(receivedOptions)).toBe(true);
    expect(mutationResult).toBe(false);
    expect(callerOptions.signal).toBe(controller.signal);
  });

  test("isolates prepared-member and context validation from sink mutation", async () => {
    const originalMembers = members(1);
    const originalReference = { ...originalMembers[0]!.reference };
    const destination = "urn:jinn:publication-destination:partition-mutation";
    const frameBytes = Uint8Array.of(1, 2, 3);
    const mutatingSink: AnnouncementSink = {
      medium: "https://publication.test/mutation-medium",
      profile: "https://publication.test/profiles/mutation/v1",
      capabilities: {},
      prepare: async (candidate, context) => {
        (
          candidate[0]!.reference as {
            digest: string;
          }
        ).digest =
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        (
          context as {
            destination: string;
            partitionOrdinal: number;
          }
        ).destination = "urn:jinn:publication-destination:mutated";
        (
          context as {
            destination: string;
            partitionOrdinal: number;
          }
        ).partitionOrdinal = 99;
        return {
          medium: "https://publication.test/mutation-medium",
          profile: "https://publication.test/profiles/mutation/v1",
          members: [{ reference: { ...originalReference } }],
          frameBytes: Uint8Array.from(frameBytes),
          frameDigest: hashExactBytes(frameBytes),
          frameSize: frameBytes.byteLength,
        };
      },
      place: async () => {
        throw new Error("unexpected placement");
      },
      reconcile: async () => {
        throw new Error("unexpected reconciliation");
      },
    };

    const partitions = await prepareAnnouncementPartitions(
      originalMembers,
      destination,
      mutatingSink,
    );

    expect(partitions[0]?.prepared.members).toEqual([
      { reference: originalReference },
    ]);
    expect(originalMembers[0]?.reference).toEqual(originalReference);
  });
});
