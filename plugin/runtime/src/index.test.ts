import { describe, expect, test } from "vitest";

import * as runtime from "./index.js";

describe("public surface", () => {
  test("exports exactly the runtime's public names", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "ARCHIVE_BUSY_ERROR_CODE",
      "CAPTURE_LICENSE",
      "ENVIRONMENT_KEYS",
      "PRODUCER_IRI",
      "PRODUCER_NAME",
      "PluginRuntimeError",
      "RETENTION_POLICY_STATEMENT",
      "RUNTIME_ERROR_CODES",
      "RUNTIME_VERSION",
      "RuntimeConfigFileSchema",
      "SEAL_MARKER_FILENAME",
      "SESSION_FEED_FORMAT_IRI",
      "SESSION_FEED_MEDIA_TYPE",
      "SESSION_FEED_VERSION",
      "SESSION_ID_PROPERTY",
      "TRAJECTORY_ARTIFACT_MEDIA_TYPE",
      "TRAJECTORY_BUILDER_ID",
      "TRAJECTORY_BUILDER_VERSION",
      "TRAJECTORY_RECORD_IDENTIFIER_PROPERTY",
      "assertSafeSessionId",
      "buildFinalizeInput",
      "buildStartInput",
      "buildTrajectoryRecord",
      "buildTrajectorySpans",
      "createCaptureCapability",
      "createLineLogger",
      "createPluginRuntime",
      "createSilentLogger",
      "derivationLinkPath",
      "ensureOwnerOnlyDirectory",
      "ensureOwnerOnlyFile",
      "executorIri",
      "listStrandedSessionIds",
      "loadTrajectoryDerivationAttestation",
      "loadTrajectoryRecord",
      "parseSessionFeed",
      "readRetentionWatermark",
      "readTrajectoryDerivationAttestationLink",
      "resolveCapturePaths",
      "resolveRuntimeConfig",
      "resolveSessionOutcome",
      "sessionDirectory",
      "sessionFeedPath",
      "sessionSummary",
      "summarizeHealth",
      "sweepCaptureRetention",
      "trajectoryReferenceFromRecordBytes",
      "withCaptureArchive",
      "workspaceDirectory",
      "writeTrajectoryDerivationAttestationLink",
    ]);
  });

  test("does not export the binary's entry point", () => {
    expect("main" in runtime).toBe(false);
    expect("BinIo" in runtime).toBe(false);
  });

  test("a consumer can build and run a runtime from the public surface alone", async () => {
    const config = runtime.resolveRuntimeConfig({ env: {}, homeDirectory: "/srv/consumer" });
    const instance = runtime.createPluginRuntime({ config });
    await instance.start();
    await expect(instance.health()).resolves.toEqual({
      ok: true,
      version: runtime.RUNTIME_VERSION,
      checks: [],
    });
    await instance.stop();
  });
});
