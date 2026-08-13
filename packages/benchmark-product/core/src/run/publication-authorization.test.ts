import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createWorkspaceLayout } from "../workspace/workspace.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { createPublisherAuthorizationArtifact, verifyPublisherAuthorizationArtifact } from "./publication-authorization.js";
import { createWorkspacePublicationHttpHandler, createWorkspacePublicationSource } from "./publication-source.js";

describe("benchmark public source authorization", () => {
  test("uses one stable workspace did:key and a structurally-valid scoped authorization envelope", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-publication-"));
    createWorkspaceLayout(workspaceDir, "2026-08-13T12:00:00Z");
    const first = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const second = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    expect(first.source.agent).toMatch(/^did:key:z/);
    expect(second.source.agent).toBe(first.source.agent);

    const artifact = createPublisherAuthorizationArtifact({
      workspaceDir,
      owner: "urn:uuid:11111111-1111-4111-8111-111111111111",
      effectiveAt: "2026-08-13T12:00:00Z",
    });
    expect(verifyPublisherAuthorizationArtifact({
      workspaceDir,
      bytes: artifact.bytes,
      owner: artifact.owner,
      publisher: first.source.agent,
      effectiveNoLaterThan: "2026-08-13T12:00:01Z",
    })).toBe(true);
    expect(verifyPublisherAuthorizationArtifact({
      workspaceDir,
      bytes: artifact.bytes,
      owner: artifact.owner,
      publisher: first.source.agent,
      effectiveNoLaterThan: "2026-08-13T11:59:59Z",
    })).toBe(false);
  });

  test("serves exact immutable artifact bytes from the filesystem composition", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "benchmark-publication-http-"));
    createWorkspaceLayout(workspaceDir, "2026-08-13T12:00:00Z");
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const bytes = new TextEncoder().encode("exact public artifact");
    const digest = `sha256:${sha256Hex(bytes)}` as const;
    await source.artifactStore.putExact({ digest, bytes, mediaType: "text/plain" });
    const handler = createWorkspacePublicationHttpHandler(workspaceDir);
    const response = await handler(new Request(`http://loopback.test/publication-artifacts/sha256/${digest.slice(7)}`));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });
});
