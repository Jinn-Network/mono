import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createWorkspaceLayout } from "../workspace/workspace.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { createPublicationState } from "./state.js";
import {
  createWorkspacePublicationHttpHandler,
  createWorkspacePublicationSource,
  withWorkspacePublicationSourceLock,
} from "./publication-source.js";

describe("workspace public source composition", () => {
  test("is local-first and uses one stable workspace did:key", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "publication-source-"));
    createWorkspaceLayout(workspaceDir, "2026-08-13T12:00:00Z");
    expect(createPublicationState().mode).toBe("local");
    const first = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const second = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    expect(first.source.agent).toMatch(/^did:key:z/);
    expect(second.source).toEqual(first.source);
  });

  test("serializes concurrent source appends without a lost update", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "publication-concurrent-"));
    createWorkspaceLayout(workspaceDir, "2026-08-13T12:00:00Z");
    const append = (label: string, timestamp: string) => withWorkspacePublicationSourceLock(workspaceDir, async () => {
      const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
      await source.writer.recover();
      const bytes = new TextEncoder().encode(label);
      return source.writer.append({
        timestamp,
        announcement: {
          announcementId: label,
          action: "available",
          record: {
            kind: "https://spec.jinn.network/records/task/v1",
            digest: `sha256:${sha256Hex(bytes)}`,
            mediaType: "text/plain",
          },
        },
        record: { bytes, contentType: "text/plain" },
      });
    });
    const receipts = await Promise.all([
      append("one", "2026-08-13T12:00:00Z"),
      append("two", "2026-08-13T12:00:01Z"),
    ]);
    expect(new Set(receipts.map((receipt) => receipt.sequence))).toEqual(new Set(["0000000000000001", "0000000000000002"]));
    const state = await createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks").writer.readState();
    expect(Object.keys(state?.announcements ?? {}).sort()).toEqual(["one", "two"]);
  });

  test("serves exact immutable publication artifacts", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "publication-http-"));
    createWorkspaceLayout(workspaceDir, "2026-08-13T12:00:00Z");
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const bytes = new TextEncoder().encode("exact bytes");
    const digest = `sha256:${sha256Hex(bytes)}` as const;
    await source.artifactStore.putExact({ digest, bytes, mediaType: "text/plain" });
    const response = await createWorkspacePublicationHttpHandler(workspaceDir)(
      new Request(`http://loopback.test/publication-artifacts/sha256/${digest.slice(7)}`),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});
