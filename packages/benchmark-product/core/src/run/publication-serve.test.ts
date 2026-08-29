/**
 * The public serving path, proved against a real socket.
 *
 * The interesting assertion is not that the handler answers -- `publication-source.test.ts`
 * already covers that in process. It is that a consumer holding nothing but a base URL can reach
 * the well-known document, walk the archive to genesis, verify the chain under
 * `source-chain-verification`, and resolve every announced record's bytes. That is the acceptance
 * bar for a served source, and it is checked here over loopback HTTP with the platform's own
 * `fetch` rather than an in-process handler shim.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  WELL_KNOWN_PATH,
  archivePagePath,
  headPath,
  parseSourceHead,
  parseWireDsseEnvelope,
  recordPath,
  verifySourceChain,
  type AnnouncementEntry,
  type HighWaterMark,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import { parseWellKnownDocument } from "@jinn-network/record-discovery-serve";
import type { DsseEnvelope } from "@jinn-network/trust-core";
import { createWorkspaceLayout } from "../workspace/workspace.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import {
  createWorkspacePublicationSource,
  refreshWorkspacePublicationWellKnown,
  withWorkspacePublicationSourceLock,
} from "./publication-source.js";
import { startPublicationArchiveServer } from "./publication-serve.js";

const SOURCE_NAME = "colophon-benchmarks";
const RECORD_KIND = "https://spec.jinn.network/records/task/v1";

function workspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createWorkspaceLayout(dir, "2026-08-13T12:00:00Z");
  return dir;
}

/** Announces `label` with its own exact bytes, exactly as the product's own announce path does. */
async function announce(workspaceDir: string, label: string, timestamp: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(label);
  await withWorkspacePublicationSourceLock(workspaceDir, async () => {
    const source = createWorkspacePublicationSource(workspaceDir, SOURCE_NAME);
    await source.writer.recover();
    return source.writer.append({
      timestamp,
      announcement: {
        announcementId: label,
        action: "available",
        record: { kind: RECORD_KIND, digest: `sha256:${sha256Hex(bytes)}`, mediaType: "text/plain" },
      },
      record: { bytes, contentType: "text/plain" },
    });
  });
  return bytes;
}

async function getBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  expect(response.status, url).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

async function getJson(url: string): Promise<unknown> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await getBytes(url)));
}

interface WirePage {
  readonly prevArchive: string | null;
  readonly entries: readonly { readonly entry: AnnouncementEntry; readonly signature: DsseEnvelope }[];
}

/** `coldSync`'s walk: newest page first, back through `prevArchive`, returned oldest-first. */
async function coldWalk(
  base: string,
  sourceName: string,
  archiveRoot: string,
): Promise<{ entry: AnnouncementEntry; signature: DsseEnvelope }[]> {
  const newestFirst: WirePage[] = [];
  let path: string | undefined = archiveRoot;
  while (path !== undefined) {
    const page = await getJson(`${base}${path}`) as WirePage;
    newestFirst.push(page);
    path = page.prevArchive === null ? undefined : archivePagePath(sourceName, page.prevArchive);
  }
  return newestFirst.reverse().flatMap((page) => page.entries.map((signed) => ({ ...signed })));
}

function verificationPorts(workspaceDir: string, now: Date) {
  const key = loadOrCreateReportSigningKey(workspaceDir);
  const resolved = {
    keyid: key.keyId,
    publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
    algorithm: "ed25519",
  };
  const marks = new Map<string, HighWaterMark>();
  return {
    keys: {
      resolve: async () => [resolved],
      everBound: async (_agent: string, keyid: string) => keyid === key.keyId,
    },
    // The procedure corroborates entry signatures against a placeholder key that carries only a
    // keyid (step 5: "was this keyid ever bound?"), so the verifier resolves material by keyid
    // rather than trusting the candidate's `publicKey` field.
    sigs: {
      verify: async (pae: Uint8Array, signature: Uint8Array, candidate: { keyid: string }) =>
        candidate.keyid === key.keyId
        && cryptoVerify(null, Buffer.from(pae), key.publicKey, Buffer.from(signature)),
    },
    fresh: { isFresh: (refreshBy: string, at: Date) => new Date(refreshBy).getTime() > at.getTime() },
    hwm: {
      get: async (source: SourceIdentity) => marks.get(`${source.agent}${source.name}`),
      put: async (source: SourceIdentity, mark: HighWaterMark) => { marks.set(`${source.agent}${source.name}`, mark); },
    },
    now,
    firstAdoption: true,
  };
}

describe("public archive server", () => {
  test("a cold consumer discovers, verifies, and resolves the served source over HTTP", async () => {
    const workspaceDir = workspace("publication-serve-cold-");
    const announced = new Map<string, Uint8Array>();
    for (const [index, label] of ["first", "second", "third"].entries()) {
      announced.set(label, await announce(workspaceDir, label, `2026-08-13T12:0${index}:00Z`));
    }

    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
    try {
      expect(server.announced).toBe(true);

      // 1. Discovery: the base URL alone must name the source and its newest archive page.
      const wellKnown = parseWellKnownDocument(await getJson(`${server.url}${WELL_KNOWN_PATH}`));
      expect(wellKnown.sources).toHaveLength(1);
      const listed = wellKnown.sources[0]!;
      expect(listed.name).toBe(SOURCE_NAME);
      expect(listed.agent).toMatch(/^did:key:z/);
      expect(listed.headPath).toBe(headPath(SOURCE_NAME));

      // 2. The signed head, read once and used both as payload and as presented envelope.
      const headBytes = await getBytes(`${server.url}${listed.headPath}`);
      const headEnvelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headBytes)) as DsseEnvelope;
      const head = parseSourceHead(JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(parseWireDsseEnvelope(headEnvelope).payloadBytes)));
      expect(head.origin).toBe(`${listed.agent}/${SOURCE_NAME}`);

      // 3. Cold walk to genesis, then source-chain-verification over exactly what was served.
      const entries = await coldWalk(server.url, SOURCE_NAME, listed.archiveRoot);
      expect(entries.map((signed) => signed.entry.sequence)).toEqual([
        "0000000000000001",
        "0000000000000002",
        "0000000000000003",
      ]);
      const outcome = await verifySourceChain({
        head,
        headSignature: headEnvelope,
        entries: (async function* () { for (const signed of entries) yield signed; })(),
        ports: verificationPorts(workspaceDir, new Date(head.issuedAt)),
      });
      expect(outcome.status).toBe("ok");

      // 4. Every announced record resolves, byte for byte, at the location its digest implies.
      //    This producer announces no `locations` array -- the digest path IS the location, which
      //    is what lets the archive move hosts without invalidating a published record -- so the
      //    absence is asserted rather than looped over, since an empty loop would prove nothing.
      for (const signed of entries) {
        for (const announcement of signed.entry.announcements) {
          expect(announcement.action).toBe("available");
          if (announcement.action !== "available") continue;
          expect(announcement.locations).toBeUndefined();
          const bytes = await getBytes(`${server.url}${recordPath(announcement.record.digest)}`);
          expect(`sha256:${sha256Hex(bytes)}`).toBe(announcement.record.digest);
          expect(bytes).toEqual(announced.get(announcement.announcementId));
        }
      }
    } finally {
      await server.close();
    }
  });

  test("rebuilds a well-known document for a source that announced before this serving path", async () => {
    const workspaceDir = workspace("publication-serve-refresh-");
    await announce(workspaceDir, "only", "2026-08-13T12:00:00Z");
    expect(await refreshWorkspacePublicationWellKnown(workspaceDir, SOURCE_NAME)).toBe(true);

    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
    try {
      const wellKnown = parseWellKnownDocument(await getJson(`${server.url}${WELL_KNOWN_PATH}`));
      expect(wellKnown.sources[0]!.archiveRoot).toBe(archivePagePath(SOURCE_NAME, "0000000000000001"));
    } finally {
      await server.close();
    }
  });

  test("withholds the well-known document until the source has announced, and serves nothing else", async () => {
    const workspaceDir = workspace("publication-serve-empty-");
    expect(await refreshWorkspacePublicationWellKnown(workspaceDir, SOURCE_NAME)).toBe(false);
    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, host: "127.0.0.1", port: 0 });
    try {
      expect(server.announced).toBe(false);
      expect(server.port).toBeGreaterThan(0);
      expect((await fetch(`${server.url}${WELL_KNOWN_PATH}`)).status).toBe(404);
      expect((await fetch(`${server.url}/`)).status).toBe(404);
      expect((await fetch(`${server.url}/publication/../../etc/passwd`)).status).toBe(404);
    } finally {
      await server.close();
    }
    await expect(fetch(server.url)).rejects.toThrow();
  });

  test("answers a write method on an admitted path without mutating anything", async () => {
    const workspaceDir = workspace("publication-serve-method-");
    await announce(workspaceDir, "only", "2026-08-13T12:00:00Z");
    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
    try {
      const refused = await fetch(`${server.url}${headPath(SOURCE_NAME)}`, { method: "POST" });
      expect(refused.status).toBe(405);
      expect(refused.headers.get("allow")).toBe("GET, HEAD");
      const probe = await fetch(`${server.url}${headPath(SOURCE_NAME)}`, { method: "HEAD" });
      expect(probe.status).toBe(200);
      expect(new Uint8Array(await probe.arrayBuffer())).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test("rejects a port outside the valid range before binding anything", async () => {
    const workspaceDir = workspace("publication-serve-port-");
    await expect(startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 70_000 }))
      .rejects.toThrow(/port must be an integer/);
  });
});
