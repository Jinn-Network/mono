import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { PluginRuntimeError } from "../errors.js";
import {
  assertSafeSessionId,
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  resolveCapturePaths,
  sessionDirectory,
  sessionFeedPath,
  workspaceDirectory,
} from "./paths.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-capture-paths-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const config = () => resolveRuntimeConfig({ env: {}, homeDirectory: home });

describe("capture paths", () => {
  test("derives every capture path under the runtime home", () => {
    const paths = resolveCapturePaths(config());
    expect(paths.captureDirectory).toBe(join(home, "capture"));
    expect(paths.sessionsDirectory).toBe(join(home, "capture", "sessions"));
    expect(paths.workspacesDirectory).toBe(join(home, "capture", "workspaces"));
    expect(paths.retentionWatermarkPath).toBe(join(home, "capture", "retention.json"));
  });

  test("session paths are per-session and the feed is named feed.ndjson", () => {
    const paths = resolveCapturePaths(config());
    expect(sessionDirectory(paths, "abc")).toBe(join(home, "capture", "sessions", "abc"));
    expect(sessionFeedPath(paths, "abc")).toBe(
      join(home, "capture", "sessions", "abc", "feed.ndjson"),
    );
    expect(workspaceDirectory(paths, "abc")).toBe(
      join(home, "capture", "workspaces", "abc"),
    );
  });

  test("rejects a session id that could escape the staging tree", () => {
    for (const candidate of ["", ".", "..", "a/b", "a\\b", "-lead", "A".repeat(129)]) {
      expect(() => assertSafeSessionId(candidate)).toThrow(PluginRuntimeError);
    }
    expect(() => assertSafeSessionId("0f2c-91ab")).not.toThrow();
    expect(() => assertSafeSessionId("ab")).not.toThrow(); // 2-char ids are valid (F-C4-P2)
  });

  test.skipIf(process.platform === "win32")(
    "creates directories owner-only and re-secures a loosened one",
    async () => {
      const target = join(home, "capture", "sessions", "s1");
      await ensureOwnerOnlyDirectory(target);
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      // A pre-existing, world-readable directory is tightened, not accepted.
      const { chmod } = await import("node:fs/promises");
      await chmod(target, 0o755);
      await ensureOwnerOnlyDirectory(target);
      expect((await stat(target)).mode & 0o777).toBe(0o700);
    },
  );

  test.skipIf(process.platform === "win32")(
    "creates files owner-only and re-secures a loosened one",
    async () => {
      const target = join(home, "capture", "sessions", "s2", "feed.ndjson");
      await ensureOwnerOnlyDirectory(join(home, "capture", "sessions", "s2"));
      await ensureOwnerOnlyFile(target);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      await writeFile(target, "x", "utf8");
      const { chmod } = await import("node:fs/promises");
      await chmod(target, 0o644);
      await ensureOwnerOnlyFile(target);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    },
  );

  test("capture config fields carry documented defaults and env overrides", () => {
    const defaults = config();
    expect(defaults.captureDirectory).toBe(join(home, "capture"));
    expect(defaults.captureRetentionDays).toBe(30);
    expect(defaults.captureArchiveBusyTimeoutMs).toBe(10_000);

    const overridden = resolveRuntimeConfig({
      env: {
        JINN_PLUGIN_CAPTURE_RETENTION_DAYS: "7",
        JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS: "2500",
      },
      homeDirectory: home,
    });
    expect(overridden.captureRetentionDays).toBe(7);
    expect(overridden.captureArchiveBusyTimeoutMs).toBe(2500);
  });

  test("rejects a non-positive retention window", () => {
    expect(() =>
      resolveRuntimeConfig({
        env: { JINN_PLUGIN_CAPTURE_RETENTION_DAYS: "0" },
        homeDirectory: home,
      }),
    ).toThrow(PluginRuntimeError);
  });
});
