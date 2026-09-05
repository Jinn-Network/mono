import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import type { DsseSigner } from "@jinn-network/trust-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { PluginRuntimeError } from "../errors.js";
import { createCaptureCapability } from "./capability.js";
import {
  derivationLinkPath,
  readTraceDerivationAttestationLink,
} from "./link.js";
import { resolveCapturePaths, sessionFeedPath } from "./paths.js";
import { SEAL_MARKER_FILENAME } from "./retention.js";

let home: string;

const testSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3]), keyid: "test-key" },
];

const context = () => ({
  config: resolveRuntimeConfig({ env: {}, homeDirectory: home }),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const capability = () =>
  createCaptureCapability({ producerVersion: "0.1.0", signer: testSigner });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-capture-capability-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("capture capability lifecycle", () => {
  test("is named and creates its staging tree on start", async () => {
    const capture = capability();
    expect(capture.name).toBe("capture");
    const ctx = context();
    await capture.start!(ctx);
    const paths = resolveCapturePaths(ctx.config);
    expect((await stat(paths.sessionsDirectory)).isDirectory()).toBe(true);
    expect((await stat(paths.workspacesDirectory)).isDirectory()).toBe(true);
    expect((await stat(paths.derivationLinksDirectory)).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(paths.captureDirectory)).mode & 0o777).toBe(0o700);
    }
  });

  test("start does not open the archive", async () => {
    const withArchive = vi.fn();
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: withArchive as never,
    });
    await capture.start!(context());
    expect(withArchive).not.toHaveBeenCalled();
  });

  test("refuses to operate before start", async () => {
    await expect(capability().openSession()).rejects.toMatchObject({
      code: "capture-not-started",
    });
  });

  test("emits only checks whose answer varies by install", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const checks = await capture.healthChecks!();
    expect(checks.map((check) => check.name)).toEqual(["capture-staging"]);
    expect(checks[0]?.ok).toBe(true);
    expect(checks[0]?.remedy).toBeNull();
  });

  test.skipIf(process.platform === "win32")(
    "capture-staging goes red when staging is readable by others, with a remedy",
    async () => {
      const capture = capability();
      const ctx = context();
      await capture.start!(ctx);
      const { chmod } = await import("node:fs/promises");
      await chmod(resolveCapturePaths(ctx.config).sessionsDirectory, 0o755);
      const [staging] = await capture.healthChecks!();
      expect(staging?.ok).toBe(false);
      expect(staging?.detail).toContain("readable by others");
      expect(staging?.remedy).toContain("chmod");
    },
  );

  test("capture-stranded appears only after a sweep actually dropped a feed, and names the right cause", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const paths = resolveCapturePaths(ctx.config);
    const { writeFile } = await import("node:fs/promises");

    await writeFile(
      paths.retentionWatermarkPath,
      `${JSON.stringify({
        retentionDays: 30,
        cutoff: "2026-06-30T12:00:00.000Z",
        sweptAt: "2026-07-30T12:00:00.000Z",
        droppedUnsealedSessions: 0,
        droppedRecoverableSessions: 0,
      })}\n`,
      { mode: 0o600 },
    );
    expect((await capture.healthChecks!()).map((check) => check.name)).toEqual([
      "capture-staging",
    ]);

    await writeFile(
      paths.retentionWatermarkPath,
      `${JSON.stringify({
        retentionDays: 30,
        cutoff: "2026-06-30T12:00:00.000Z",
        sweptAt: "2026-07-30T12:00:00.000Z",
        droppedUnsealedSessions: 2,
        droppedRecoverableSessions: 0,
      })}\n`,
      { mode: 0o600 },
    );
    const unsealable = await capture.healthChecks!();
    expect(unsealable.map((check) => check.name)).toEqual([
      "capture-staging",
      "capture-stranded",
    ]);
    expect(unsealable[1]?.ok).toBe(true);
    expect(unsealable[1]?.detail).toContain("without an end record");
    expect(unsealable[1]?.remedy).toBeNull();

    await writeFile(
      paths.retentionWatermarkPath,
      `${JSON.stringify({
        retentionDays: 30,
        cutoff: "2026-06-30T12:00:00.000Z",
        sweptAt: "2026-07-30T12:00:00.000Z",
        droppedUnsealedSessions: 2,
        droppedRecoverableSessions: 1,
      })}\n`,
      { mode: 0o600 },
    );
    const recoverable = await capture.healthChecks!();
    expect(recoverable[1]?.ok).toBe(false);
    expect(recoverable[1]?.detail).toContain("could have been sealed");
    expect(recoverable[1]?.remedy).toContain("three feeds per session");
  });
});

describe("openSession", () => {
  test("mints a session, creates its directory, and pre-creates the feed owner-only", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId, feedPath } = await capture.openSession();
    expect(feedPath).toBe(sessionFeedPath(resolveCapturePaths(ctx.config), sessionId));
    expect((await stat(feedPath)).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(feedPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("honors a caller-supplied session id and rejects an unsafe one", async () => {
    const capture = capability();
    await capture.start!(context());
    await expect(capture.openSession({ sessionId: "s-explicit" })).resolves.toMatchObject({
      sessionId: "s-explicit",
    });
    await expect(capture.openSession({ sessionId: "../escape" })).rejects.toBeInstanceOf(
      PluginRuntimeError,
    );
  });

  test("is idempotent for one session id and never truncates an existing feed", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const first = await capture.openSession({ sessionId: "s-1" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(first.feedPath, "{}\n", { flag: "a" });
    const second = await capture.openSession({ sessionId: "s-1" });
    expect(second.feedPath).toBe(first.feedPath);
    expect(await readFile(first.feedPath, "utf8")).toBe("{}\n");
  });

  test("costs no archive access when there is nothing stranded to recover", async () => {
    const withArchive = vi.fn();
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: withArchive as never,
    });
    await capture.start!(context());
    await capture.openSession({ sessionId: "s-first" });
    expect(withArchive).not.toHaveBeenCalled();
  });

  test("opens the archive with a short budget when a stranded feed exists", async () => {
    const seen: { busyTimeoutMs?: number } = {};
    const withArchive = vi.fn(async (options: { busyTimeoutMs: number }) => {
      seen.busyTimeoutMs = options.busyTimeoutMs;
      throw new PluginRuntimeError("capture-archive-busy", "held by a sibling");
    });
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: withArchive as never,
    });
    const ctx = context();
    await capture.start!(ctx);
    await capture.openSession({ sessionId: "s-stranded" });
    withArchive.mockClear();

    await expect(capture.openSession({ sessionId: "s-new" })).resolves.toMatchObject({
      sessionId: "s-new",
    });
    expect(withArchive).toHaveBeenCalledTimes(1);
    expect(seen.busyTimeoutMs).toBe(1_000);
    expect(ctx.log.info).not.toHaveBeenCalled();
  });

  test("names why a stranded feed could not be sealed instead of discarding the reason", async () => {
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: (async (
        _options: unknown,
        run: (runtime: unknown) => Promise<unknown>,
      ) => run({ catalog: undefined, repository: {} })) as never,
    });
    const ctx = context();
    await capture.start!(ctx);
    // A feed the parser refuses: recovery throws rather than returning diagnostics, and without
    // a named reason the session is later deleted with no record of why it was unsealable.
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-broken" });
    expect(sessionId).toBe("s-broken");
    await writeFile(feedPath, "{not json}\n");

    await capture.openSession({ sessionId: "s-new" });
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "capture recovery failed",
      expect.objectContaining({ sessionId: "s-broken" }),
    );
  });

  test("logs one line only when recovery actually seals something", async () => {
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: (async (
        _options: unknown,
        run: (runtime: unknown) => Promise<unknown>,
      ) => run({ catalog: undefined, repository: {} })) as never,
    });
    const ctx = context();
    await capture.start!(ctx);
    await capture.openSession({ sessionId: "s-stranded" });
    await capture.openSession({ sessionId: "s-new" });
    expect(ctx.log.info).not.toHaveBeenCalled();
  });
});

describe("abandonSession", () => {
  test("removes the staging directory and is safe to repeat", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId, feedPath } = await capture.openSession();
    await capture.abandonSession(sessionId);
    await expect(stat(feedPath)).rejects.toThrow();
    await expect(capture.abandonSession(sessionId)).resolves.toBeUndefined();
  });

  test("does not open the archive", async () => {
    const withArchive = vi.fn();
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: withArchive as never,
    });
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId } = await capture.openSession();
    await capture.abandonSession(sessionId);
    expect(withArchive).not.toHaveBeenCalled();
  });
});

describe("sealSession guards", () => {
  const passthrough = (async (
    _options: unknown,
    run: (runtime: unknown) => Promise<unknown>,
  ) => run({ catalog: undefined, repository: {} })) as never;

  test("refuses a session whose feed does not exist", async () => {
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: passthrough,
    });
    await capture.start!(context());
    await expect(capture.sealSession({ sessionId: "s-missing" })).rejects.toMatchObject({
      code: "capture-feed-missing",
    });
  });

  test("refuses a second concurrent seal of the same session", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: (async () => {
        await gate;
        throw new PluginRuntimeError("capture-archive-busy", "held");
      }) as never,
    });
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-race" });
    await copyFile(
      new URL("../../fixtures/capture/session.ndjson", import.meta.url),
      feedPath,
    );

    const first = capture.sealSession({ sessionId });
    await expect(capture.sealSession({ sessionId })).rejects.toMatchObject({
      code: "capture-session-busy",
    });
    release();
    await expect(first).rejects.toMatchObject({ code: "capture-archive-busy" });

    await expect(capture.sealSession({ sessionId })).rejects.toMatchObject({
      code: "capture-archive-busy",
    });
  });

  test("refuses an unclosed feed with no supplied outcome", async () => {
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: passthrough,
    });
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-open" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      feedPath,
      JSON.stringify({
        type: "session-open",
        v: 1,
        sessionId: "s-open",
        startedAt: "2026-07-30T09:00:00Z",
        atUnixNano: "1000",
        host: { name: "Hermes", version: "0.9.1" },
        model: { provider: "anthropic", name: "claude-opus-4.6" },
      }) + "\n",
    );
    await expect(capture.sealSession({ sessionId })).rejects.toMatchObject({
      code: "capture-outcome-unknown",
    });
  });
});

describe("sealSession amendment lifecycle", () => {
  test("writes attestation artifact, durable derivation link, and sealed marker", async () => {
    const repository = new InMemoryEvidenceRepository();
    const runtime = {
      repository,
      catalog: undefined,
      awaitIndexed: async (reference: EvidenceRecordReference) => ({
        status: "not-announced" as const,
        reference,
      }),
    };
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      signer: testSigner,
      withArchive: async (_options, run) => run(runtime as never),
    });
    const ctx = context();
    await capture.start!(ctx);
    const paths = resolveCapturePaths(ctx.config);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-golden" });
    await copyFile(
      new URL("../../fixtures/capture/session.ndjson", import.meta.url),
      feedPath,
    );

    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;

    const { capture: sealed } = result;
    expect(sealed.derivationAttestation.envelopeBytes.byteLength).toBeGreaterThan(0);
    expect(sealed.derivationAttestation.derivedAt).toBe("2026-07-30T09:00:06Z");

    const link = await readTraceDerivationAttestationLink(paths, sealed.record.digest);
    expect(link).toEqual({
      version: 1,
      executionDigest: sealed.record.digest,
      traceDigest: sealed.trace.digest,
      attestationDigest: sealed.derivationAttestation.digest,
      nativeTraceDigest: sealed.nativeTrace.reference.digest,
      derivedAt: "2026-07-30T09:00:06Z",
    });
    expect(derivationLinkPath(paths, sealed.record.digest)).toBe(
      join(paths.derivationLinksDirectory, sealed.record.digest.slice("sha256:".length) + ".json"),
    );

    const markerPath = join(paths.sessionsDirectory, sessionId, SEAL_MARKER_FILENAME);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    expect(marker.derivationAttestation).toBe(sealed.derivationAttestation.digest);
    expect(marker.trace).toBe(sealed.trace.digest);
  });
});
