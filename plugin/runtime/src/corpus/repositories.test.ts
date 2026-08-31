// SPDX-License-Identifier: Apache-2.0
import { recordDigest } from "@jinn-network/evidence-protocol";
import { createFilesystemEvidenceRepository } from "@jinn-network/evidence-repository/fs";
import type { Transport, TransportResponse } from "@jinn-network/record-discovery-client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CorpusMirrorError } from "./errors.js";
import {
  MIRROR_REPOSITORY_ID,
  createCorpusRepositoryResolver,
  createMirroringRepository,
  createServingPlaneRepository,
} from "./repositories.js";

const bytes = new TextEncoder().encode('{"hello":"world"}');
const digest = recordDigest(bytes);
const reference = { family: "execution-evidence", digest } as const;

function transportServing(body: Uint8Array, status = 200): Transport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string): Promise<TransportResponse> {
      calls.push(url);
      return { status, bytes: body };
    },
  };
}

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
  signingKeys: [],
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-repo-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("serving-plane repository", () => {
  test("fetches a record from the protocol's records path", async () => {
    const transport = transportServing(bytes);
    const repository = createServingPlaneRepository({ servingRoot: source.servingRoot, transport });
    await expect(repository.getRecord(reference)).resolves.toEqual(bytes);
    expect(transport.calls[0]).toBe(`https://archive.test/records/${digest.slice("sha256:".length)}`);
  });

  test("REFUSES bytes whose digest does not match the reference", async () => {
    const repository = createServingPlaneRepository({
      servingRoot: source.servingRoot,
      transport: transportServing(new TextEncoder().encode("tampered")),
    });
    await expect(repository.getRecord(reference)).rejects.toBeInstanceOf(CorpusMirrorError);
    await expect(repository.getRecord(reference)).rejects.toMatchObject({
      code: "corpus-record-digest-mismatch",
    });
  });

  test("returns null for a not-found response rather than throwing", async () => {
    const repository = createServingPlaneRepository({
      servingRoot: source.servingRoot,
      transport: transportServing(new Uint8Array(), 404),
    });
    await expect(repository.getRecord(reference)).resolves.toBeNull();
  });

  test("is read-only — writing refuses loudly", async () => {
    const repository = createServingPlaneRepository({
      servingRoot: source.servingRoot,
      transport: transportServing(bytes),
    });
    await expect(repository.putRecord("execution-evidence", bytes)).rejects.toMatchObject({
      code: "corpus-repository-read-only",
    });
  });

  test("returns null for artifacts — the serving plane defines no artifact path", async () => {
    const repository = createServingPlaneRepository({
      servingRoot: source.servingRoot,
      transport: transportServing(bytes),
    });
    await expect(repository.getArtifact({ digest })).resolves.toBeNull();
  });
});

describe("mirroring repository", () => {
  test("fetches upstream on a miss, writes locally, and serves locally thereafter", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const upstream = { getRecord: vi.fn(async () => bytes) } as unknown as Parameters<
      typeof createMirroringRepository
    >[0]["upstream"];
    const repository = createMirroringRepository({ upstream, local });

    await expect(repository.getRecord(reference)).resolves.toEqual(bytes);
    await expect(repository.getRecord(reference)).resolves.toEqual(bytes);
    expect((upstream.getRecord as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  test("returns null when upstream has nothing, and caches no negative result", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const upstream = { getRecord: vi.fn(async () => null) } as unknown as Parameters<
      typeof createMirroringRepository
    >[0]["upstream"];
    const repository = createMirroringRepository({ upstream, local });

    await expect(repository.getRecord(reference)).resolves.toBeNull();
    await expect(repository.getRecord(reference)).resolves.toBeNull();
    expect((upstream.getRecord as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  test("REFUSES to cache upstream bytes whose digest does not match", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const upstream = {
      getRecord: async () => new TextEncoder().encode("tampered"),
    } as unknown as Parameters<typeof createMirroringRepository>[0]["upstream"];
    const repository = createMirroringRepository({ upstream, local });

    await expect(repository.getRecord(reference)).rejects.toMatchObject({
      code: "corpus-record-digest-mismatch",
    });
    await expect(local.getRecord(reference)).resolves.toBeNull();
  });
});

describe("repository resolver", () => {
  test("resolves the mirror id to the local object store", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const resolver = createCorpusRepositoryResolver({
      sources: [source],
      local,
      transport: transportServing(bytes),
    });
    await expect(resolver.resolve(MIRROR_REPOSITORY_ID)).resolves.toBe(local);
  });

  test("resolves a configured source id to a mirroring repository over its serving root", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const transport = transportServing(bytes);
    const resolver = createCorpusRepositoryResolver({ sources: [source], local, transport });

    const repository = await resolver.resolve("archive.test/attempts");
    expect(repository).not.toBeNull();
    await expect(repository!.getRecord(reference)).resolves.toEqual(bytes);
    await expect(repository!.getRecord(reference)).resolves.toEqual(bytes);
    expect(transport.calls).toHaveLength(1);
  });

  test("returns null for an unconfigured repository id", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const resolver = createCorpusRepositoryResolver({
      sources: [source],
      local,
      transport: transportServing(bytes),
    });
    await expect(resolver.resolve("archive.evil/attempts")).resolves.toBeNull();
  });
});
