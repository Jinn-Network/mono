import { mkdtempSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createWorkspaceLayout } from "../workspace/workspace.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { createPublicationState } from "./state.js";
import {
  createWorkspacePublicationHttpHandler,
  createWorkspacePublicationSource,
  normalizePublicArchiveBaseUrl,
  publicArchiveUrl,
  withWorkspacePublicationSourceLock,
} from "./publication-source.js";

describe("workspace public source composition", () => {
  test("joins root and nested archive mounts without discarding the mount", () => {
    expect(publicArchiveUrl("https://example.test", "/records/sha256/abc")).toBe("https://example.test/records/sha256/abc");
    expect(publicArchiveUrl("https://example.test/publication/", "/records/sha256/abc")).toBe("https://example.test/publication/records/sha256/abc");
    expect(normalizePublicArchiveBaseUrl("https://example.test/publication///")).toBe("https://example.test/publication");
    expect(() => normalizePublicArchiveBaseUrl("https://user:secret@example.test/publication")).toThrow(/credentials/);
    expect(() => normalizePublicArchiveBaseUrl("https://example.test/publication?workspace=private")).toThrow(/query/);
    expect(() => normalizePublicArchiveBaseUrl("https://example.test/publication/%2e%2e/private")).toThrow(/confined/);
    expect(() => normalizePublicArchiveBaseUrl("https://example.test/publication/%2fprivate")).toThrow(/confined/);
    expect(() => normalizePublicArchiveBaseUrl("https://example.test/publication\\private")).toThrow(/confined/);
    expect(() => publicArchiveUrl("https://example.test/publication", "/records/%2e%2e/private")).toThrow(/confined/);
  });
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

  test("refuses encoded traversal and symlinked objects or content-type sidecars", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "publication-http-confinement-"));
    createWorkspaceLayout(workspaceDir, "2026-08-13T12:00:00Z");
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const bytes = new TextEncoder().encode("inside");
    const digest = `sha256:${sha256Hex(bytes)}` as const;
    await source.artifactStore.putExact({ digest, bytes, mediaType: "text/plain" });
    const handler = createWorkspacePublicationHttpHandler(workspaceDir);
    for (const path of ["/%2e%2e/private", "/publication-artifacts/%2e%2e/private", "/publication-artifacts/sha256/%2e%2e%2fprivate"]) {
      expect((await handler(new Request(`http://loopback.test${path}`))).status).toBe(404);
    }
    const object = join(workspaceDir, "publication", "public", "publication-artifacts", "sha256", digest.slice(7));
    const outside = join(workspaceDir, "outside-secret");
    writeFileSync(outside, bytes);
    unlinkSync(object);
    symlinkSync(outside, object);
    expect((await handler(new Request(`http://loopback.test/publication-artifacts/sha256/${digest.slice(7)}`))).status).toBe(404);

    unlinkSync(object);
    writeFileSync(object, bytes);
    const sidecar = `${object}.content-type`;
    unlinkSync(sidecar);
    symlinkSync(outside, sidecar);
    expect((await handler(new Request(`http://loopback.test/publication-artifacts/sha256/${digest.slice(7)}`))).status).toBe(404);

    unlinkSync(sidecar);
    writeFileSync(sidecar, "text/plain\r\nx-injected: yes");
    const invalidMime = await handler(new Request(`http://loopback.test/publication-artifacts/sha256/${digest.slice(7)}`));
    expect(invalidMime.status).toBe(404);
    expect(invalidMime.headers.has("x-injected")).toBe(false);
  });

  test("never serves outside bytes while an object is concurrently replaced by a symlink", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "publication-http-race-"));
    createWorkspaceLayout(workspaceDir, "2026-08-13T12:00:00Z");
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const inside = new TextEncoder().encode("inside-race");
    const secret = new TextEncoder().encode("outside-secret-race");
    const digest = `sha256:${sha256Hex(inside)}` as const;
    await source.artifactStore.putExact({ digest, bytes: inside, mediaType: "text/plain" });
    const object = join(workspaceDir, "publication", "public", "publication-artifacts", "sha256", digest.slice(7));
    const outside = join(workspaceDir, "outside-race");
    writeFileSync(outside, secret);
    const handler = createWorkspacePublicationHttpHandler(workspaceDir);
    const url = `http://loopback.test/publication-artifacts/sha256/${digest.slice(7)}`;
    const reads = Array.from({ length: 64 }, () => handler(new Request(url)));
    for (let index = 0; index < 32; index += 1) {
      const replacement = `${object}.replacement-${index}`;
      if (index % 2 === 0) writeFileSync(replacement, inside);
      else symlinkSync(outside, replacement);
      renameSync(replacement, object);
      await Promise.resolve();
    }
    for (const response of await Promise.all(reads)) {
      expect([200, 404, 409]).toContain(response.status);
      const observed = new Uint8Array(await response.arrayBuffer());
      expect(observed).not.toEqual(secret);
      if (response.status === 200) expect(observed).toEqual(inside);
    }
  });

  test("reads source-writer records from their exact recordPath namespace", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "publication-record-reader-"));
    createWorkspaceLayout(workspaceDir, "2026-08-13T12:00:00Z");
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const bytes = new TextEncoder().encode("writer-owned record bytes");
    const digest = `sha256:${sha256Hex(bytes)}` as const;
    await source.writer.append({
      timestamp: "2026-08-13T12:00:00Z",
      announcement: { announcementId: "writer-record", action: "available", record: { kind: "https://spec.jinn.network/records/submission/v1", digest, mediaType: "application/json" } },
      record: { bytes, contentType: "application/json" },
    });
    expect(await source.recordStore.getExact(digest)).toEqual(bytes);
    expect(await source.artifactStore.getExact(digest)).toBeUndefined();
  });
});
