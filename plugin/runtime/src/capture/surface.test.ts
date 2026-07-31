import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import * as api from "../index.js";

describe("public surface", () => {
  test("exports the capture capability and everything C6 and C7 consume", () => {
    for (const name of [
      "createCaptureCapability",
      "parseSessionFeed",
      "buildTrajectoryRecord",
      "buildTrajectorySpans",
      "trajectoryReferenceFromRecordBytes",
      "loadTrajectoryRecord",
      "sweepCaptureRetention",
      "readRetentionWatermark",
      "listStrandedSessionIds",
      "ensureOwnerOnlyDirectory",
      "ensureOwnerOnlyFile",
      "resolveCapturePaths",
      "sessionFeedPath",
      "withCaptureArchive",
      "SESSION_FEED_FORMAT_IRI",
      "SESSION_FEED_MEDIA_TYPE",
      "SESSION_FEED_VERSION",
      "TRAJECTORY_RECORD_IDENTIFIER_PROPERTY",
      "TRAJECTORY_BUILDER_ID",
      "TRAJECTORY_BUILDER_VERSION",
      "RETENTION_POLICY_STATEMENT",
      "SEAL_MARKER_FILENAME",
      "ARCHIVE_BUSY_ERROR_CODE",
      "derivationLinkPath",
      "writeTrajectoryDerivationAttestationLink",
      "readTrajectoryDerivationAttestationLink",
      "loadTrajectoryDerivationAttestation",
    ]) {
      expect(api, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  test("the README states the local privacy posture and names C6's obligation", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain("owner-only");
    expect(readme).toContain("does not scrub at capture time");
    expect(readme).toContain("jinn.trajectory.source.ordinal");
    expect(readme).toContain("input/session-task.json");
    expect(readme).toContain("results/session-summary.json");
  });

  test("the README names both recovery limits rather than leaving them to be discovered", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain("start of your next session");
    expect(readme).toContain("hard kill carries no end record");
    expect(readme).toContain("never open another");
  });

  test("capture registers only when BinIo.captureSigner is injected (F-C4-T13-2)", async () => {
    const bin = await readFile(new URL("../bin.ts", import.meta.url), "utf8");
    expect(bin).toContain("createCaptureCapability");
    expect(bin).toContain("captureSigner?: DsseSigner");
    expect(bin).toMatch(/if \(captureSigner === undefined\)[\s\S]*return \[\]/);

    const entryBlock = bin.slice(bin.indexOf("if (isProcessEntry())"));
    expect(entryBlock).not.toContain("captureSigner:");

    const { main } = await import("../bin.js");
    const out: string[] = [];
    const exit = await main(["health"], {}, {
      writeOut: (line) => out.push(line),
      writeErr: () => {},
      homeDirectory: "/tmp/test-home",
      untilShutdown: async () => {},
    });
    expect(exit).toBe(0);
    expect(JSON.parse(out[0]!).checks).toEqual([]);
  });

  test("the README names F-C4-T13-2 captureSigner gating", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain("F-C4-T13-2");
    expect(readme).toContain("captureSigner");
  });
});
