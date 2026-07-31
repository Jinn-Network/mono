import { describe, expect, test } from "vitest";

import { TRAJECTORY_RECORD_IDENTIFIER_PROPERTY } from "@jinn-network/evidence-trajectory";

import { loadTrajectoryRecord, trajectoryReferenceFromRecordBytes } from "./link.js";

const DIGEST = `sha256:${"d".repeat(64)}` as const;

const crate = (identifier: unknown): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      "@context": ["https://w3id.org/ro/crate/1.3/context"],
      "@graph": [
        { "@id": "./", "@type": "Dataset" },
        {
          "@id": "trace/feed.ndjson",
          "@type": "File",
          sha256: "e".repeat(64),
          ...(identifier === undefined ? {} : { identifier }),
        },
      ],
    }),
  );

describe("trajectoryReferenceFromRecordBytes", () => {
  test("reads the digest from the trace entity's identifier", () => {
    const bytes = crate([
      { "@type": "PropertyValue", propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY, value: DIGEST },
    ]);
    expect(trajectoryReferenceFromRecordBytes(bytes)).toEqual({ digest: DIGEST });
  });

  test("accepts a single identifier object as well as a list", () => {
    const bytes = crate({
      "@type": "PropertyValue",
      propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
      value: DIGEST,
    });
    expect(trajectoryReferenceFromRecordBytes(bytes)).toEqual({ digest: DIGEST });
  });

  test("returns null when no trajectory identifier is present", () => {
    expect(trajectoryReferenceFromRecordBytes(crate(undefined))).toBeNull();
    expect(
      trajectoryReferenceFromRecordBytes(
        crate([{ "@type": "PropertyValue", propertyID: "https://example.test/other", value: DIGEST }]),
      ),
    ).toBeNull();
  });

  test("returns null rather than throwing on unreadable bytes", () => {
    expect(trajectoryReferenceFromRecordBytes(new Uint8Array([0xff]))).toBeNull();
    expect(trajectoryReferenceFromRecordBytes(new TextEncoder().encode("not json"))).toBeNull();
    expect(trajectoryReferenceFromRecordBytes(new TextEncoder().encode("{}"))).toBeNull();
  });

  test("rejects a malformed digest value", () => {
    expect(
      trajectoryReferenceFromRecordBytes(
        crate([
          {
            "@type": "PropertyValue",
            propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
            value: "sha256:not-a-digest",
          },
        ]),
      ),
    ).toBeNull();
  });
});

describe("loadTrajectoryRecord", () => {
  test("parses the stored artifact under C1's schema", async () => {
    const { buildTrajectoryRecord } = await import("./trajectory.js");
    const { parseSessionFeed } = await import("./feed.js");
    const { readFile } = await import("node:fs/promises");
    const feedBytes = new Uint8Array(
      await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url)),
    );
    const built = buildTrajectoryRecord(parseSessionFeed(feedBytes), feedBytes);
    const repository = {
      getArtifact: async () => built.bytes,
    } as unknown as Parameters<typeof loadTrajectoryRecord>[0];
    const record = await loadTrajectoryRecord(repository, { digest: built.digest });
    expect(record.traceId).toBe(built.traceId);
  });

  test("throws when the artifact is absent", async () => {
    const repository = {
      getArtifact: async () => null,
    } as unknown as Parameters<typeof loadTrajectoryRecord>[0];
    await expect(loadTrajectoryRecord(repository, { digest: DIGEST })).rejects.toThrow(/not present/u);
  });
});
