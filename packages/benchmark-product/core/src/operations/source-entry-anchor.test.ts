import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RFC3161_TSA_ANCHOR_PROFILE } from "@jinn-network/trust-core";
import { createFixtureAuthority, KIT_AUTHORITY_SEED } from "@jinn-network/trust-testing";
import { atomicWriteFileSync } from "../fs/atomic.js";
import {
  createWorkspacePublicationSource,
  withWorkspacePublicationSourceLock,
} from "../run/publication-source.js";
import { readEntryAnchorLedger } from "../run/entry-anchor-ledger.js";
import { createWorkspaceLayout } from "../workspace/workspace.js";
import { workspaceMetadataPath } from "../workspace/layout.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { formatEntryAnchorLine } from "./source-entry-anchor.js";

const TSA_ENDPOINT = "https://timestamp.invalid/tsr";
const authority = createFixtureAuthority(KIT_AUTHORITY_SEED);

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "entry-anchor-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function configureWorkspaceAnchoring(): void {
  const path = workspaceMetadataPath(workspaceDir);
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  atomicWriteFileSync(path, JSON.stringify({
    ...metadata,
    anchoring: [{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT }],
  }, null, 2));
}

describe("source entry anchoring", () => {
  test("does nothing when the workspace configures no provider", async () => {
    createWorkspaceLayout(workspaceDir, "2026-09-18T00:00:00Z");
    await withWorkspacePublicationSourceLock(workspaceDir, async () => {
      const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
      await source.writer.recover();
      const bytes = new TextEncoder().encode("run");
      await source.writer.append({
        timestamp: "2026-09-18T00:00:00.000Z",
        announcement: {
          announcementId: "run",
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
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    expect(readEntryAnchorLedger(workspaceDir, source.source.agent, "colophon-benchmarks").rows).toEqual([]);
    const state = await source.writer.readState();
    expect(Object.keys(state?.announcements ?? {})).toEqual(["run"]);
  });

  test("acquires an entry anchor after a substantive append and announces it on a dedicated later entry", async () => {
    createWorkspaceLayout(workspaceDir, "2026-09-18T00:00:00Z");
    configureWorkspaceAnchoring();
    const deps = {
      sources: {
        [RFC3161_TSA_ANCHOR_PROFILE]: {
          profile: RFC3161_TSA_ANCHOR_PROFILE,
          async obtainProof({ subjectSha256 }: { subjectSha256: string }) {
            return authority.mintTimeStampToken({
              subjectSha256,
              genTime: "20260918000000Z",
            }).tokenDer;
          },
        },
      },
    };
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks", deps);

    await withWorkspacePublicationSourceLock(workspaceDir, async () => {
      await source.writer.recover();
      const bytes = new TextEncoder().encode("run");
      await source.writer.append({
        timestamp: "2026-09-18T00:00:00.000Z",
        announcement: {
          announcementId: "run",
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

    const ledger = readEntryAnchorLedger(workspaceDir, source.source.agent, "colophon-benchmarks");
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]?.sequence).toBe("0000000000000001");
    expect(ledger.rows[0]?.announcedAnnouncementId).toMatch(/^entry-anchor:/);
    expect(ledger.rows[0]?.recordSha256).toMatch(/^[a-f0-9]{64}$/);

    const state = await source.writer.readState();
    const ids = Object.keys(state?.announcements ?? {}).sort();
    expect(ids).toHaveLength(2);
    expect(ids).toContain("run");
    const anchorId = ids.find((id) => id !== "run")!;
    expect(state?.announcements[anchorId]?.receipt.sequence).toBe("0000000000000002");
    expect(formatEntryAnchorLine({
      sequence: ledger.rows[0]!.sequence,
      provider: ledger.rows[0]!.provider,
      recordSha256: ledger.rows[0]!.recordSha256!,
      subjectSha256: ledger.rows[0]!.entryDigest,
      proofStatus: "present",
    })).toContain("0000000000000001");
  });

  test("a failed acquisition never blocks the append", async () => {
    createWorkspaceLayout(workspaceDir, "2026-09-18T00:00:00Z");
    configureWorkspaceAnchoring();
    await withWorkspacePublicationSourceLock(workspaceDir, async () => {
      const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks", {
        sources: {
          [RFC3161_TSA_ANCHOR_PROFILE]: {
            profile: RFC3161_TSA_ANCHOR_PROFILE,
            async obtainProof() { throw new Error("the authority is on fire"); },
          },
        },
      });
      await source.writer.recover();
      const bytes = new TextEncoder().encode("run");
      await source.writer.append({
        timestamp: "2026-09-18T00:00:00.000Z",
        announcement: {
          announcementId: "run",
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
    const source = createWorkspacePublicationSource(workspaceDir, "colophon-benchmarks");
    const state = await source.writer.readState();
    expect(Object.keys(state?.announcements ?? {})).toEqual(["run"]);
    expect(readEntryAnchorLedger(workspaceDir, source.source.agent, "colophon-benchmarks").rows).toEqual([]);
  });
});
