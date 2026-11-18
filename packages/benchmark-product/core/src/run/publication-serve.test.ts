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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  type SourceHead,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import { parseWellKnownDocument } from "@jinn-network/record-discovery-serve";
import { RUN_MEDIA_TYPE, RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import type { DsseEnvelope } from "@jinn-network/trust-core";
import { createWorkspaceLayout } from "../workspace/workspace.js";
import { publicationServeRoot, runsDir, runStatePath } from "../workspace/layout.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import {
  createWorkspacePublicationSource,
  refreshWorkspacePublicationHead,
  refreshWorkspacePublicationWellKnown,
  resolveWorkspacePublicationSourceName,
  withWorkspacePublicationSourceLock,
  type WorkspacePublicationHeadRefresh,
} from "./publication-source.js";
import { startPublicationArchiveServer, type PublicationArchiveServer } from "./publication-serve.js";
import { PUBLICATION_LOCK_INDEX_PATH } from "./publication-lock-index.js";
import { createPublicationState, writeRunState } from "./state.js";

const SOURCE_NAME = "colophon-benchmarks";
const RECORD_KIND = "https://spec.jinn.network/records/task/v1";

function workspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createWorkspaceLayout(dir, "2026-08-13T12:00:00Z");
  return dir;
}

/** Announces `label` with its own exact bytes, exactly as the product's own announce path does. */
async function announce(
  workspaceDir: string,
  label: string,
  timestamp: string,
  typed: { readonly kind: string; readonly mediaType: string } = { kind: RECORD_KIND, mediaType: "text/plain" },
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(label);
  await withWorkspacePublicationSourceLock(workspaceDir, async () => {
    const source = createWorkspacePublicationSource(workspaceDir, SOURCE_NAME);
    await source.writer.recover();
    return source.writer.append({
      timestamp,
      announcement: {
        announcementId: label,
        action: "available",
        record: { kind: typed.kind, digest: `sha256:${sha256Hex(bytes)}`, mediaType: typed.mediaType },
      },
      record: { bytes, contentType: typed.mediaType },
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
      expect(server.wellKnown).toBe("published");

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

  test("serves the lock index beside the archive, and chain verification never reaches it (#3398)", async () => {
    const workspaceDir = workspace("publication-serve-lock-index-");
    const lockBytes = await announce(workspaceDir, "lock", "2026-08-13T12:00:00Z", { kind: RUN_RECORD_KIND, mediaType: RUN_MEDIA_TYPE });
    await announce(workspaceDir, "task", "2026-08-13T12:01:00Z");
    writeRunState(workspaceDir, "draft-1", {
      draftId: "draft-1",
      specSha256: "a".repeat(64),
      owner: loadOrCreateReportSigningKey(workspaceDir).keyId,
      runSha256: sha256Hex(lockBytes),
      publication: createPublicationState(),
    });
    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
    try {
      const response = await fetch(`${server.url}${PUBLICATION_LOCK_INDEX_PATH}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      // Rewritten on regeneration, so never marked immutable the way digest paths are.
      expect(response.headers.get("cache-control")).toBe("no-cache");
      const indexBytes = new Uint8Array(await response.arrayBuffer());
      const index = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes)) as { locks: { lockSha256: string }[] };
      // The Task announcement is not a lock; only the Run record is listed.
      expect(index.locks.map((lock) => lock.lockSha256)).toEqual([sha256Hex(lockBytes)]);
      expect((await fetch(`${server.url}${PUBLICATION_LOCK_INDEX_PATH}`, { method: "POST" })).status).toBe(405);

      // A cold consumer's walk and source-chain-verification are untouched by the index, and no
      // announcement in the verified chain names its bytes.
      const listed = parseWellKnownDocument(await getJson(`${server.url}${WELL_KNOWN_PATH}`)).sources[0]!;
      const headEnvelope = JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(await getBytes(`${server.url}${listed.headPath}`))) as DsseEnvelope;
      const head = parseSourceHead(JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(parseWireDsseEnvelope(headEnvelope).payloadBytes)));
      const entries = await coldWalk(server.url, SOURCE_NAME, listed.archiveRoot);
      const outcome = await verifySourceChain({
        head,
        headSignature: headEnvelope,
        entries: (async function* () { for (const signed of entries) yield signed; })(),
        ports: verificationPorts(workspaceDir, new Date(head.issuedAt)),
      });
      expect(outcome.status).toBe("ok");
      const digests = entries.flatMap((signed) => signed.entry.announcements)
        .flatMap((announcement) => (announcement.action === "available" ? [announcement.record.digest] : []));
      expect(digests).toHaveLength(2);
      expect(digests).not.toContain(`sha256:${sha256Hex(indexBytes)}`);
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
      expect(server.wellKnown).toBe("not-announced");
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

  // Root ignores the mode bits below, so the induced failure would not occur; the behavior under
  // test is the reporting, not the permission check.
  const asNonRoot = typeof process.getuid === "function" && process.getuid() !== 0 ? test : test.skip;
  asNonRoot("reports a failed well-known refresh apart from a source that never announced", async () => {
    const workspaceDir = workspace("publication-serve-refresh-failed-");
    await announce(workspaceDir, "only", "2026-08-13T12:00:00Z");
    // Any failure to write the derived document takes this path -- lock contention against an
    // in-flight announce is the common one; an unwritable well-known directory is simply the one
    // a test can induce without racing a 30-second lock timeout.
    const wellKnownDir = join(publicationServeRoot(workspaceDir), dirname(WELL_KNOWN_PATH).slice(1));
    chmodSync(wellKnownDir, 0o500);
    let server: PublicationArchiveServer | undefined;
    try {
      server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
      // Not `not-announced`: this source HAS announced, and the document being served may now
      // name a superseded archive page -- the opposite operator response from "nothing yet".
      expect(server.wellKnown).toBe("refresh-failed");
      expect(server.refreshFailure).toBeDefined();
      // It serves what is on disk regardless: the signed chain is readable and complete.
      expect((await fetch(`${server.url}${headPath(SOURCE_NAME)}`)).status).toBe(200);
    } finally {
      await server?.close();
      chmodSync(wellKnownDir, 0o700);
    }
  });


  test("refuses a directory that is not a Colophon workspace before creating anything in it", async () => {
    // The whole point of the refusal: `loadOrCreateReportSigningKey` is load-OR-CREATE, so a
    // mistyped `--workspace` used to mint a signing identity at the wrong path and exit 0.
    const notAWorkspace = mkdtempSync(join(tmpdir(), "publication-serve-not-a-workspace-"));
    await expect(startPublicationArchiveServer({ workspaceDir: notAWorkspace, sourceName: SOURCE_NAME, port: 0 }))
      .rejects.toThrow(/not a workspace/);
    // Nothing was created: no signing key, no serving root, no venue directory.
    expect(readdirSync(notAWorkspace)).toEqual([]);
  });

  test("announces a progress line before the refresh so a long wait reads as work", async () => {
    const workspaceDir = workspace("publication-serve-progress-");
    await announce(workspaceDir, "only", "2026-08-13T12:00:00Z");
    const lines: string[] = [];
    const server = await startPublicationArchiveServer({
      workspaceDir, sourceName: SOURCE_NAME, port: 0, onProgress: (line) => lines.push(line),
    });
    try {
      expect(lines[0]).toContain("refreshing");
      expect(lines[0]).toContain(SOURCE_NAME);
      // Ordering is the assertion: the line must precede the outcome it explains the wait for.
      expect(server.wellKnown).toBe("published");
    } finally {
      await server.close();
    }
  });

  test("names lock contention as the cause while it waits, and still binds", async () => {
    const workspaceDir = workspace("publication-serve-contended-");
    await announce(workspaceDir, "only", "2026-08-13T12:00:00Z");
    const lines: string[] = [];
    // Hold the source lock across the start so the acquire inside the refresh is contended.
    const held = withWorkspacePublicationSourceLock(workspaceDir, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    });
    const server = await startPublicationArchiveServer({
      workspaceDir, sourceName: SOURCE_NAME, port: 0, onProgress: (line) => lines.push(line),
    });
    try {
      await held;
      expect(lines.some((line) => /lock/i.test(line))).toBe(true);
      // Bind ordering and the three-way outcome are untouched by the reporting.
      expect(server.wellKnown).toBe("published");
    } finally {
      await server.close();
    }
  });

  test("a throwing onProgress sink cannot fail the serve it only describes (#3848)", async () => {
    const workspaceDir = workspace("publication-serve-throwing-sink-");
    await announce(workspaceDir, "only", "2026-08-13T12:00:00Z");
    let calls = 0;
    const server = await startPublicationArchiveServer({
      workspaceDir, sourceName: SOURCE_NAME, port: 0,
      onProgress: () => { calls += 1; throw new Error("sink is broken"); },
    });
    try {
      // The sink was genuinely invoked, so the guard -- not an absent call -- is what held.
      expect(calls).toBeGreaterThan(0);
      expect(server.wellKnown).toBe("published");
      expect(server.url).toMatch(/^http:\/\//);
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

describe("workspace publication source name", () => {
  function writeRunPublicationSource(workspaceDir: string, draftId: string, name: string): void {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    // Only the publication block is read; a partial document keeps the fixture honest about
    // exactly which field the resolution rule consults.
    writeFileSync(runStatePath(workspaceDir, draftId), JSON.stringify({
      publication: { source: { agentKeyRef: "workspace-owner", name } },
    }), "utf8");
  }

  test("falls back to the default name for a workspace with no runs", () => {
    const workspaceDir = workspace("publication-source-name-none-");
    expect(resolveWorkspacePublicationSourceName(workspaceDir)).toBe(SOURCE_NAME);
  });

  test("uses the one configured name rather than the constant", () => {
    const workspaceDir = workspace("publication-source-name-one-");
    writeRunPublicationSource(workspaceDir, "draft-a", "house-benchmarks");
    writeRunPublicationSource(workspaceDir, "draft-b", "house-benchmarks");
    expect(resolveWorkspacePublicationSourceName(workspaceDir)).toBe("house-benchmarks");
  });

  test("refuses rather than guessing when configured names disagree", () => {
    const workspaceDir = workspace("publication-source-name-many-");
    writeRunPublicationSource(workspaceDir, "draft-a", "house-benchmarks");
    writeRunPublicationSource(workspaceDir, "draft-b", "guest-benchmarks");
    expect(() => resolveWorkspacePublicationSourceName(workspaceDir))
      .toThrow(/guest-benchmarks[\s\S]*house-benchmarks|house-benchmarks[\s\S]*guest-benchmarks/);
  });
});

// #4187: a source with nothing new to announce re-signs its head before `refreshBy` lapses, so a
// reader arriving during the idle window never fetches a stale head. Design record:
// docs/superpowers/specs/2026-09-09-idle-head-heartbeat-design.md.
describe("idle source head heartbeat (#4187)", () => {
  const HOUR_MS = 60 * 60 * 1_000;
  const hoursAgo = (hours: number, plusMs = 0): string => new Date(Date.now() - hours * HOUR_MS + plusMs).toISOString();

  function decodeHead(bytes: Uint8Array): { readonly bytes: Uint8Array; readonly envelope: DsseEnvelope; readonly head: SourceHead } {
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as DsseEnvelope;
    const head = parseSourceHead(JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(parseWireDsseEnvelope(envelope).payloadBytes)));
    return { bytes, envelope, head };
  }

  function headOnDisk(workspaceDir: string) {
    return decodeHead(new Uint8Array(readFileSync(join(publicationServeRoot(workspaceDir), headPath(SOURCE_NAME).slice(1)))));
  }

  /** The runbook's cold-sync check: well-known, head, walk to genesis, chain verification at `now`. */
  async function coldCheck(server: PublicationArchiveServer, workspaceDir: string, ports = verificationPorts(workspaceDir, new Date())) {
    const listed = parseWellKnownDocument(await getJson(`${server.url}${WELL_KNOWN_PATH}`)).sources[0]!;
    const served = decodeHead(await getBytes(`${server.url}${listed.headPath}`));
    const entries = await coldWalk(server.url, SOURCE_NAME, listed.archiveRoot);
    const outcome = await verifySourceChain({
      head: served.head,
      headSignature: served.envelope,
      entries: (async function* () { for (const signed of entries) yield signed; })(),
      ports,
    });
    return { served, entries, outcome };
  }

  /** A run whose publication stage froze its announcement time and has not announced yet. */
  function writeRunWithStage(workspaceDir: string, draftId: string, state: "in-progress" | "complete", announcedAt: string): void {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    writeFileSync(runStatePath(workspaceDir, draftId), JSON.stringify({
      publication: {
        source: { agentKeyRef: "workspace-owner", name: SOURCE_NAME },
        registration: { state, announcedAt },
        accounting: { state: "not-started" },
        report: { state: "not-started" },
      },
    }), "utf8");
  }

  test("re-signs a lapsed head at the same position, so the cold-sync check passes", async () => {
    const workspaceDir = workspace("publication-serve-heartbeat-lapsed-");
    for (const [index, label] of ["first", "second", "third"].entries()) {
      await announce(workspaceDir, label, `2026-08-13T12:0${index}:00Z`);
    }
    const idle = headOnDisk(workspaceDir);
    // Round-10: the head was last signed with the last announcement and has since lapsed.
    expect(Date.parse(idle.head.refreshBy)).toBeLessThan(Date.now());

    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
    try {
      const { served, entries, outcome } = await coldCheck(server, workspaceDir);
      expect(outcome.status).toBe("ok");
      expect(entries).toHaveLength(3);
      expect(server.headRefresh).toMatchObject({ status: "refreshed", previous: { issuedAt: idle.head.issuedAt, refreshBy: idle.head.refreshBy } });
      // Only the two instants move; the chain position the head commits to does not.
      expect(served.head).toEqual({ ...idle.head, issuedAt: served.head.issuedAt, refreshBy: served.head.refreshBy });
      expect(Date.parse(served.head.refreshBy) - Date.parse(served.head.issuedAt)).toBe(24 * HOUR_MS);
      expect(Date.parse(served.head.refreshBy)).toBeGreaterThan(Date.now());
    } finally {
      await server.close();
    }
  });

  test("leaves a head with more than half its window remaining byte-identical", async () => {
    const workspaceDir = workspace("publication-serve-heartbeat-fresh-");
    await announce(workspaceDir, "only", hoursAgo(11));
    const before = headOnDisk(workspaceDir);

    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
    try {
      expect(server.headRefresh).toMatchObject({ status: "not-due", current: { issuedAt: before.head.issuedAt } });
      expect(await getBytes(`${server.url}${headPath(SOURCE_NAME)}`)).toEqual(before.bytes);
    } finally {
      await server.close();
    }
  });

  test("a reader holding the re-signed head still refuses a replay of the head it replaced", async () => {
    const workspaceDir = workspace("publication-serve-heartbeat-replay-");
    // Idle for 13 of its 24 hours: due, and the head it is about to replace is still fresh, so
    // freshness cannot be what refuses the replay below.
    await announce(workspaceDir, "only", hoursAgo(13));
    const superseded = headOnDisk(workspaceDir);

    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
    try {
      expect(server.headRefresh?.status).toBe("refreshed");
      const ports = verificationPorts(workspaceDir, new Date());
      const { served, outcome } = await coldCheck(server, workspaceDir, ports);
      expect(outcome.status).toBe("ok");
      expect(served.head.sequence).toBe(superseded.head.sequence);
      expect(served.head.entry).toBe(superseded.head.entry);

      // A rollback mirror replays the earlier signature over the same position.
      const replay = await verifySourceChain({
        head: superseded.head,
        headSignature: superseded.envelope,
        entries: (async function* () { /* a returning reader is fed nothing above its mark */ })(),
        ports: { ...ports, firstAdoption: false },
      });
      expect(replay).toEqual({ status: "broken-chain", at: "issued-at-monotonicity" });
    } finally {
      await server.close();
    }
  });

  test("a record announced after a re-sign advances the chain as it always has", async () => {
    const workspaceDir = workspace("publication-serve-heartbeat-append-");
    await announce(workspaceDir, "first", "2026-08-13T12:00:00Z");
    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
    try {
      expect(server.headRefresh?.status).toBe("refreshed");
      const resigned = headOnDisk(workspaceDir);
      await announce(workspaceDir, "second", new Date(Date.parse(resigned.head.issuedAt) + 1).toISOString());

      const { served, entries, outcome } = await coldCheck(server, workspaceDir);
      expect(outcome.status).toBe("ok");
      expect(entries.map((signed) => signed.entry.sequence)).toEqual(["0000000000000001", "0000000000000002"]);
      expect(served.head.sequence).toBe("0000000000000002");
      expect(served.head.entry).not.toBe(resigned.head.entry);
    } finally {
      await server.close();
    }
  });

  test("re-signs on its tick a head that falls due while serving, reporting each change once", async () => {
    const workspaceDir = workspace("publication-serve-heartbeat-tick-");
    const reported: WorkspacePublicationHeadRefresh[] = [];
    const server = await startPublicationArchiveServer({
      workspaceDir, sourceName: SOURCE_NAME, port: 0, headRefreshIntervalMs: 50,
      onHeadRefresh: (outcome) => reported.push(outcome),
    });
    try {
      expect(server.headRefresh).toEqual({ status: "no-position" });
      await announce(workspaceDir, "late", hoursAgo(13));
      const deadline = Date.now() + 10_000;
      while (!reported.some((outcome) => outcome.status === "not-due")) {
        if (Date.now() > deadline) throw new Error(`no re-sign was reported: ${JSON.stringify(reported.map((outcome) => outcome.status))}`);
        await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      }
      // Many ticks ran; only the changes were reported.
      expect(reported.map((outcome) => outcome.status)).toEqual(["no-position", "refreshed", "not-due"]);
      expect((await coldCheck(server, workspaceDir)).outcome.status).toBe("ok");
    } finally {
      await server.close();
    }
  });

  // The refresh checks the head and writes it in two steps; what keeps an announcement from landing
  // between them is that it holds the same source lock every announcement holds (#5334).
  test("a due refresh waits on a held source lock, says so, and writes nothing until release", async () => {
    const workspaceDir = workspace("publication-serve-heartbeat-locked-");
    await announce(workspaceDir, "first", "2026-08-13T12:00:00Z");
    const before = headOnDisk(workspaceDir);

    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const holder = withWorkspacePublicationSourceLock(workspaceDir, async () => { holding(); await released; });
    await held;

    let contended!: () => void;
    const reported = new Promise<"contended">((resolve) => { contended = () => resolve("contended"); });
    let settled = false;
    const refresh = refreshWorkspacePublicationHead(workspaceDir, SOURCE_NAME, contended)
      .finally(() => { settled = true; });
    try {
      expect(await Promise.race([reported, refresh.then((outcome) => outcome.status)])).toBe("contended");
      // Several of the acquire's 10ms polls later, it is still waiting and the head is untouched.
      await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
      expect(settled).toBe(false);
      expect(headOnDisk(workspaceDir).bytes).toEqual(before.bytes);
    } finally {
      release();
      await holder;
    }

    expect((await refresh).status).toBe("refreshed");
    const after = headOnDisk(workspaceDir);
    expect(after.bytes).not.toEqual(before.bytes);
    expect(after.head).toEqual({ ...before.head, issuedAt: after.head.issuedAt, refreshBy: after.head.refreshBy });
  });

  // Every publication stage announces a record it has not yet announced at its planned time or
  // after the served head, whichever is later, so a head re-signed past a time a stage froze no
  // longer stops that stage from finishing; the stage suites show each one finishing after a
  // re-sign (#5389). The heartbeat therefore reads no run documents: neither a stage left
  // `in-progress` nor a run document that cannot be read keeps the head from being re-signed.
  test("re-signs while a publication stage is in-progress and a run document cannot be read (#5389)", async () => {
    const workspaceDir = workspace("publication-serve-heartbeat-in-progress-");
    await announce(workspaceDir, "first", "2026-08-13T12:00:00Z");
    writeRunWithStage(workspaceDir, "draft-frozen", "in-progress", "2026-08-14T09:00:00.000Z");
    writeFileSync(runStatePath(workspaceDir, "draft-torn"), "{", "utf8");
    const before = headOnDisk(workspaceDir);

    const server = await startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0 });
    try {
      expect(server.headRefresh).toMatchObject({ status: "refreshed", previous: { issuedAt: before.head.issuedAt } });
      const { served, outcome } = await coldCheck(server, workspaceDir);
      expect(outcome.status).toBe("ok");
      expect(served.head).toEqual({ ...before.head, issuedAt: served.head.issuedAt, refreshBy: served.head.refreshBy });
    } finally {
      await server.close();
    }
  });

  test("an interval of 0 turns the heartbeat off and serves the head as it was", async () => {
    const workspaceDir = workspace("publication-serve-heartbeat-off-");
    await announce(workspaceDir, "first", "2026-08-13T12:00:00Z");
    const before = headOnDisk(workspaceDir);
    const reported: WorkspacePublicationHeadRefresh[] = [];

    const server = await startPublicationArchiveServer({
      workspaceDir, sourceName: SOURCE_NAME, port: 0, headRefreshIntervalMs: 0, onHeadRefresh: (outcome) => reported.push(outcome),
    });
    try {
      expect(server.headRefresh).toBeUndefined();
      expect(await getBytes(`${server.url}${headPath(SOURCE_NAME)}`)).toEqual(before.bytes);
      expect(reported).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("rejects an interval a timer cannot honor before binding anything", async () => {
    const workspaceDir = workspace("publication-serve-heartbeat-interval-");
    for (const headRefreshIntervalMs of [-1, 1.5, 2 ** 31]) {
      await expect(startPublicationArchiveServer({ workspaceDir, sourceName: SOURCE_NAME, port: 0, headRefreshIntervalMs }))
        .rejects.toThrow(/headRefreshIntervalMs/);
    }
  });
});
