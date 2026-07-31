import { describe, expect, test } from "vitest";

import * as runtime from "./index.js";

describe("public surface", () => {
  test("exports exactly the runtime's public names", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "CORPUS_ERROR_CODES",
      "CORPUS_PROJECTOR_VERSION",
      "CORPUS_SYNC_LOCK_FORMAT",
      "CorpusMirrorError",
      "DEFAULT_CORPUS_PRODUCER_PURPOSE",
      "ENVIRONMENT_KEYS",
      "FAMILY_BY_RECORD_KIND",
      "HIGH_WATER_MARK_FORMAT",
      "MIRROR_REPOSITORY_ID",
      "PluginRuntimeError",
      "RUNTIME_ERROR_CODES",
      "RUNTIME_VERSION",
      "RuntimeConfigFileSchema",
      "UNVERIFIED_CHAIN_ACKNOWLEDGEMENT",
      "adaptAnnouncementEntry",
      "composeAdmission",
      "createCorpusCapability",
      "createCorpusFilesystem",
      "createCorpusMirror",
      "createCorpusReader",
      "createCorpusRepositoryResolver",
      "createCorpusRetrieval",
      "createDeniedProducerAdmission",
      "createDriverChainVerification",
      "createFileHighWaterMarkStore",
      "createFollowedSourceAdmission",
      "createLineLogger",
      "createMirroringRepository",
      "createPluginRuntime",
      "createRejectingChainVerification",
      "createServingPlaneRepository",
      "createSilentLogger",
      "createTrustPolicyAdmission",
      "createUnverifiedChainVerification",
      "openCorpusMirrorStore",
      "producerIdOf",
      "resolveRuntimeConfig",
      "sourceIdOf",
      "summarizeHealth",
      "tryAcquireSyncLock",
      "withCorpusMirrorStore",
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
