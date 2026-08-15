import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { resolveCapturePaths } from "./paths.js";
import {
  RETENTION_POLICY_STATEMENT,
  SEAL_MARKER_FILENAME,
  listStrandedSessionIds,
  readRetentionWatermark,
  sweepCaptureRetention,
} from "./retention.js";

let home: string;
const NOW = new Date("2026-07-30T12:00:00Z");
const dayMs = 86_400_000;

const paths = () => resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));

async function seedSession(
  id: string,
  ageDays: number,
  options: { readonly sealed?: boolean } = {},
): Promise<void> {
  const p = paths();
  const when = new Date(NOW.getTime() - ageDays * dayMs);
  for (const directory of [join(p.sessionsDirectory, id), join(p.workspacesDirectory, id)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "feed.ndjson"), "{}\n", { mode: 0o600 });
  }
  if (options.sealed !== false) {
    await writeFile(join(p.sessionsDirectory, id, SEAL_MARKER_FILENAME), "{}\n", { mode: 0o600 });
  }
  for (const directory of [join(p.sessionsDirectory, id), join(p.workspacesDirectory, id)]) {
    await utimes(directory, when, when);
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-capture-retention-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("sweepCaptureRetention", () => {
  test("removes staging older than the window and keeps the rest", async () => {
    await seedSession("old-one", 45);
    await seedSession("old-two", 31);
    await seedSession("fresh", 2);

    const report = await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });

    expect(report.cutoff).toBe("2026-06-30T12:00:00.000Z");
    expect(report.sweptSessions).toBe(2);
    expect(report.sweptWorkspaces).toBe(2);
    expect(report.retainedSessions).toBe(1);
    await expect(stat(join(paths().sessionsDirectory, "old-one"))).rejects.toThrow();
    await expect(stat(join(paths().sessionsDirectory, "fresh"))).resolves.toBeDefined();
    await expect(stat(join(paths().workspacesDirectory, "old-two"))).rejects.toThrow();
  });

  test("never removes a session the caller is still working on", async () => {
    await seedSession("active", 90);
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      keepSessionIds: ["active"],
    });
    expect(report.sweptSessions).toBe(0);
    expect(report.retainedSessions).toBe(1);
    await expect(stat(join(paths().sessionsDirectory, "active"))).resolves.toBeDefined();
  });

  test("writes an owner-only watermark that reads back", async () => {
    await sweepCaptureRetention({ paths: paths(), retentionDays: 7, now: NOW });
    const watermark = await readRetentionWatermark(paths());
    expect(watermark).toEqual({
      retentionDays: 7,
      cutoff: "2026-07-23T12:00:00.000Z",
      sweptAt: "2026-07-30T12:00:00.000Z",
      droppedUnsealedSessions: 0,
      droppedRecoverableSessions: 0,
    });
    if (process.platform !== "win32") {
      expect((await stat(paths().retentionWatermarkPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("returns null for a watermark that is absent or unreadable", async () => {
    expect(await readRetentionWatermark(paths())).toBeNull();
    await mkdir(paths().captureDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths().retentionWatermarkPath, "not json", { mode: 0o600 });
    expect(await readRetentionWatermark(paths())).toBeNull();
  });

  test("is idempotent and safe on an empty capture tree", async () => {
    const first = await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });
    const second = await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });
    expect(first.sweptSessions).toBe(0);
    expect(second).toEqual(first);
  });

  test("reports how many sealed captures fall outside the window without deleting them", async () => {
    const catalog = {
      findExecutions: async (query: { startedBefore?: string; limit?: number }) => {
        expect(query.startedBefore).toBe("2026-06-30T12:00:00.000Z");
        expect(query.limit).toBe(200);
        return { items: [{}, {}, {}] };
      },
    } as never;
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      catalog,
    });
    expect(report.sealedBeforeCutoff).toBe(3);
    expect(report.sealedCountTruncated).toBe(false);
  });

  test("marks the sealed count truncated when the catalog page fills", async () => {
    const catalog = {
      findExecutions: async () => ({ items: Array.from({ length: 200 }, () => ({})) }),
    } as never;
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      catalog,
    });
    expect(report.sealedBeforeCutoff).toBe(200);
    expect(report.sealedCountTruncated).toBe(true);
  });

  test("a catalog failure never fails the sweep", async () => {
    const catalog = {
      findExecutions: async () => {
        throw new Error("catalog unavailable");
      },
    } as never;
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      catalog,
    });
    expect(report.sealedBeforeCutoff).toBe(0);
  });

  test("lists stranded sessions oldest first, without touching the archive", async () => {
    await seedSession("sealed-one", 10);
    await seedSession("stranded-newer", 5, { sealed: false });
    await seedSession("stranded-older", 20, { sealed: false });
    await seedSession("active", 1, { sealed: false });

    expect(await listStrandedSessionIds(paths(), ["active"])).toEqual([
      "stranded-older",
      "stranded-newer",
    ]);
    expect(await listStrandedSessionIds(paths())).toEqual([
      "stranded-older",
      "stranded-newer",
      "active",
    ]);
  });

  test("listing strandeds on an absent staging tree is empty, not an error", async () => {
    await expect(listStrandedSessionIds(paths())).resolves.toEqual([]);
  });

  test("records the dropped counts in the watermark so the doctor need not re-walk", async () => {
    await seedSession("lost", 40, { sealed: false });
    await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });
    const watermark = await readRetentionWatermark(paths());
    expect(watermark?.droppedUnsealedSessions).toBe(1);
    expect(watermark?.droppedRecoverableSessions).toBe(0);
  });

  test("splits dropped feeds by whether they were ever sealable", async () => {
    // Sealable: carries a session-close line, so recovery simply never reached it.
    await seedSession("sealable", 40, { sealed: false });
    await writeFile(
      join(paths().sessionsDirectory, "sealable", "feed.ndjson"),
      [
        JSON.stringify({
          type: "session-open",
          v: 1,
          sessionId: "sealable",
          startedAt: "2026-06-01T09:00:00Z",
          atUnixNano: "1000",
          host: { name: "Hermes", version: "0.9.1" },
          model: { provider: "anthropic", name: "claude-opus-4.6" },
        }),
        JSON.stringify({
          type: "session-close",
          atUnixNano: "2000",
          endedAt: "2026-06-01T09:00:01Z",
          outcome: "completed",
          summary: "done",
        }),
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    // Cut short: no end record, so nothing could ever have sealed it.
    await seedSession("cut-short", 40, { sealed: false });
    await writeFile(
      join(paths().sessionsDirectory, "cut-short", "feed.ndjson"),
      JSON.stringify({ type: "user-turn", atUnixNano: "1000", text: "hi" }) + "\n",
      { mode: 0o600 },
    );

    const report = await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });
    expect(report.droppedUnsealedSessions).toBe(2);
    expect(report.droppedRecoverableSessions).toBe(1);
  });

  test("offers a stranded feed to recovery before evicting it, oldest first and bounded", async () => {
    await seedSession("stranded-old", 40, { sealed: false });
    await seedSession("stranded-new", 35, { sealed: false });
    await seedSession("stranded-third", 33, { sealed: false });
    await seedSession("stranded-fourth", 32, { sealed: false });
    const offered: string[] = [];

    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      maxRecoveries: 2,
      recover: async (sessionId) => {
        offered.push(sessionId);
        return sessionId === "stranded-old";
      },
    });

    expect(offered).toEqual(["stranded-old", "stranded-new"]);
    expect(report.recoveredSessions).toBe(1);
    // Everything past the window is evicted; the three that could not be sealed are counted.
    expect(report.sweptSessions).toBe(4);
    expect(report.droppedUnsealedSessions).toBe(3);
  });

  test("keeps a fresh unsealed feed even when recovery declines", async () => {
    await seedSession("fresh-unsealed", 1, { sealed: false });
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      recover: async () => false,
    });
    expect(report.sweptSessions).toBe(0);
    expect(report.droppedUnsealedSessions).toBe(0);
    expect(report.retainedSessions).toBe(1);
    await expect(stat(join(paths().sessionsDirectory, "fresh-unsealed"))).resolves.toBeDefined();
  });

  test("a throwing recovery is treated as a decline, never as a sweep failure", async () => {
    await seedSession("stranded", 40, { sealed: false });
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      recover: async () => {
        throw new Error("archive busy");
      },
    });
    expect(report.recoveredSessions).toBe(0);
    expect(report.droppedUnsealedSessions).toBe(1);
    // The seeded feed is a bare "{}" line, so it was never sealable.
    expect(report.droppedRecoverableSessions).toBe(0);
  });

  test("the stated policy says plainly that sealed records are not deleted", async () => {
    expect(RETENTION_POLICY_STATEMENT).toContain("never deleted");
    expect(RETENTION_POLICY_STATEMENT).toContain("excluded from retrieval");
    expect(await readFile(new URL("./retention.ts", import.meta.url), "utf8")).toContain(
      "append-only",
    );
  });
});
