// SPDX-License-Identifier: Apache-2.0
/**
 * The archive lock index (#3398), over a real workspace with two registered locks.
 *
 * The index is presentation: it lists what the source chain already announced, links only to
 * bytes that are present in the served tree, and must never become part of anything that is
 * sealed, announced, or byte-compared. These tests pin all three.
 */

import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { archivePagePath } from "@jinn-network/record-discovery-protocol";
import { parseArchivePath } from "@jinn-network/record-discovery-transport-http";
import { PRODUCIBLE_ANCHOR_PROFILES } from "../anchor/profiles.js";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { buildRegistrationClosure, publicationConfigure, publicationRegister } from "../operations/publication-register.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { sampleInit } from "../operations/sample.js";
import { publicationServeRoot } from "../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import {
  PUBLICATION_LOCK_INDEX_FORMAT,
  PUBLICATION_LOCK_INDEX_PATH,
  buildWorkspacePublicationLockIndex,
  refreshWorkspacePublicationLockIndex,
} from "./publication-lock-index.js";
import { createWorkspacePublicationHttpHandler, createWorkspacePublicationSource } from "./publication-source.js";
import { readRunState, writeRunState } from "./state.js";

const SOURCE_NAME = "colophon-benchmarks";

let workspaceDir: string;
let server: Server | undefined;

beforeEach(() => { workspaceDir = mkdtempSync(join(tmpdir(), "lock-index-")); });
afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  rmSync(workspaceDir, { recursive: true, force: true });
});

function clock(): () => string {
  let tick = 0;
  return () => `2026-08-13T12:${String(Math.floor(tick / 60)).padStart(2, "0")}:${String(tick++ % 60).padStart(2, "0")}Z`;
}

function context(now: () => string): OperationContext {
  return { workspaceDir, principal: "sponsor-1", clock: now };
}

async function lockDraft(now: () => string, draftId: string): Promise<string> {
  expect(createDraft(context(now), { draftId, name: `Public sample ${draftId}` }).ok).toBe(true);
  expect((await sampleInit(context(now), { draftId })).ok).toBe(true);
  expect(armAdd(context(now), { draftId, armId: "a", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } }).ok).toBe(true);
  expect(armAdd(context(now), { draftId, armId: "b", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } }).ok).toBe(true);
  expect((await runQuote(context(now), { draftId })).ok).toBe(true);
  const locked = runLock(context(now), { draftId });
  if (!locked.ok) throw new Error(JSON.stringify(locked.error));
  return locked.result.runSha256;
}

async function serveWorkspace(): Promise<string> {
  const handler = createWorkspacePublicationHttpHandler(workspaceDir);
  server = createServer(async (request, response) => {
    const result = await handler(new Request(`http://127.0.0.1${request.url ?? "/"}`, { method: request.method }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

/** Two drafts, each locked and registered on the one workspace source, in that order. */
async function twoRegisteredLocks(): Promise<readonly [string, string]> {
  const now = clock();
  expect(initWorkspace(context(now)).ok).toBe(true);
  const first = await lockDraft(now, "draft-1");
  const second = await lockDraft(now, "draft-2");
  const base = await serveWorkspace();
  for (const draftId of ["draft-1", "draft-2"]) {
    expect((await publicationConfigure(context(now), { draftId, publicBaseUrl: base })).ok).toBe(true);
    const registered = await publicationRegister(context(now), { draftId });
    expect(registered.ok, JSON.stringify(registered)).toBe(true);
  }
  return [first, second];
}

function servedIndexBytes(): Uint8Array {
  return new Uint8Array(readFileSync(join(publicationServeRoot(workspaceDir), PUBLICATION_LOCK_INDEX_PATH)));
}

function servedIndex(): Record<string, any> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(servedIndexBytes()));
}

async function runReceipt(runSha256: string) {
  const source = createWorkspacePublicationSource(workspaceDir, SOURCE_NAME);
  const state = await source.writer.readState();
  const receipt = Object.values(state?.announcements ?? {})
    .find((entry) => entry.receipt.record?.digest === `sha256:${runSha256}`)?.receipt;
  if (receipt === undefined) throw new Error(`no announcement for ${runSha256}`);
  return { agent: source.source.agent, receipt };
}

describe("archive lock index", () => {
  test("registration writes an index listing every announced lock with its archive paths", async () => {
    const [first, second] = await twoRegisteredLocks();
    const index = servedIndex();
    expect(index.format).toBe(PUBLICATION_LOCK_INDEX_FORMAT);
    // The document says what it is in its own bytes, so a reader who meets it alone is told.
    expect(index.statement).toMatch(/generated by this archive's publisher/);
    expect(index.statement).toMatch(/not a registry/);
    expect(index.statement).toMatch(/not a trust claim/);

    const expected = [];
    for (const runSha256 of [first, second]) {
      const { agent, receipt } = await runReceipt(runSha256);
      expected.push({
        lockSha256: runSha256,
        source: { agent, name: SOURCE_NAME },
        sequence: receipt.sequence,
        entryPath: archivePagePath(SOURCE_NAME, receipt.page),
        runPath: `/records/${runSha256}`,
        anchors: [],
        bundles: [],
      });
    }
    // Announcement order: draft-1 registered first, so it holds the lower source sequence.
    expect(index.locks).toEqual(expected);
    // Every listed path resolves in the served tree; a row links, it never names absent bytes.
    for (const lock of index.locks) {
      expect(existsSync(join(publicationServeRoot(workspaceDir), lock.runPath))).toBe(true);
      expect(existsSync(join(publicationServeRoot(workspaceDir), lock.entryPath))).toBe(true);
    }
  });

  test("lists carried anchors and bundle identities, and links each only when its exact bytes are served", async () => {
    const [first] = await twoRegisteredLocks();
    const anchorBytes = new TextEncoder().encode("anchor-evidence fixture bytes");
    const anchorSha256 = sha256Hex(anchorBytes);
    const bundleManifest = new TextEncoder().encode("bundle manifest fixture bytes");
    const bundleIdentity = sha256Hex(bundleManifest);
    const provider = PRODUCIBLE_ANCHOR_PROFILES[0];
    const state = readRunState(workspaceDir, "draft-1")!;
    writeRunState(workspaceDir, "draft-1", {
      ...state,
      anchors: [{ subject: "lock", provider, recordSha256: anchorSha256 }],
      bundleIdentity,
    });

    expect(await refreshWorkspacePublicationLockIndex(workspaceDir)).toBe(true);
    let lock = servedIndex().locks.find((row: { lockSha256: string }) => row.lockSha256 === first);
    // Neither is in the served tree: the digests are listed, the paths are withheld.
    expect(lock.anchors).toEqual([{ subject: "lock", provider, recordSha256: anchorSha256, path: null }]);
    expect(lock.bundles).toEqual([{ identity: bundleIdentity, path: null }]);

    const source = createWorkspacePublicationSource(workspaceDir, SOURCE_NAME);
    await source.artifactStore.putExact({ digest: `sha256:${anchorSha256}`, bytes: anchorBytes, mediaType: "application/octet-stream" });
    // Bytes at the digest path that do not hash to the digest are not the bundle, so no link.
    writeFileSync(join(publicationServeRoot(workspaceDir), "publication-artifacts", "sha256", bundleIdentity), "not the manifest");
    expect(await refreshWorkspacePublicationLockIndex(workspaceDir)).toBe(true);
    lock = servedIndex().locks.find((row: { lockSha256: string }) => row.lockSha256 === first);
    expect(lock.anchors).toEqual([{
      subject: "lock", provider, recordSha256: anchorSha256, path: `/publication-artifacts/sha256/${anchorSha256}`,
    }]);
    expect(lock.bundles).toEqual([{ identity: bundleIdentity, path: null }]);
  });

  test("regenerating is deterministic and carries no clock", async () => {
    await twoRegisteredLocks();
    const written = servedIndexBytes();
    const rebuilt = await buildWorkspacePublicationLockIndex(workspaceDir);
    expect(rebuilt).toEqual(written);
    expect(await buildWorkspacePublicationLockIndex(workspaceDir)).toEqual(rebuilt);
    expect(await refreshWorkspacePublicationLockIndex(workspaceDir)).toBe(true);
    expect(servedIndexBytes()).toEqual(written);
    // No generation time: the only instants a row could carry are the records' own, and it
    // carries none of them either.
    expect(new TextDecoder().decode(written)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  test("the index enters no sealed, announced, or registration digest set", async () => {
    const [first, second] = await twoRegisteredLocks();
    const indexSha256 = sha256Hex(servedIndexBytes());

    // Not sealed: nothing a bundle or claim package is assembled from can reach it.
    expect(() => getSealedBytes(workspaceDir, indexSha256)).toThrow();
    // Not announced: the source chain names no record with its digest.
    const state = await createWorkspacePublicationSource(workspaceDir, SOURCE_NAME).writer.readState();
    const announced = Object.values(state?.announcements ?? {}).map((entry) => entry.receipt.record?.digest);
    expect(announced.length).toBeGreaterThan(0);
    expect(announced).not.toContain(`sha256:${indexSha256}`);
    // Not in any registration closure, recorded or rebuilt.
    for (const [draftId, runSha256] of [["draft-1", first], ["draft-2", second]] as const) {
      const digests = Object.values(readRunState(workspaceDir, draftId)!.publication!.registration.digests ?? {});
      expect(digests.length).toBeGreaterThan(0);
      expect(digests).not.toContain(indexSha256);
      const members = buildRegistrationClosure(workspaceDir, getSealedBytes(workspaceDir, runSha256), runSha256, "2026-08-13T12:00:00Z");
      expect(members.map((member) => member.digest)).not.toContain(`sha256:${indexSha256}`);
    }
    // Not in the Record Discovery grammar: no discovery consumer is ever routed to it.
    expect(parseArchivePath(PUBLICATION_LOCK_INDEX_PATH)).toBeUndefined();
  });

  test("writes nothing for a workspace that has announced no lock", async () => {
    expect(initWorkspace(context(clock())).ok).toBe(true);
    expect(await buildWorkspacePublicationLockIndex(workspaceDir)).toBeUndefined();
    expect(await refreshWorkspacePublicationLockIndex(workspaceDir)).toBe(false);
    expect(existsSync(join(publicationServeRoot(workspaceDir), PUBLICATION_LOCK_INDEX_PATH))).toBe(false);
  });
});
