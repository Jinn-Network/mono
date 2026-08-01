import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordDigest, recordPath, WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";
import { writeRecord } from "@jinn-network/record-discovery-serve";

import { ContentAddressedConflictError, UnsafeBlobPathError, createFsBlobStore } from "./fs-blob-store.js";

const encoder = new TextEncoder();

describe("createFsBlobStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jinn-fs-blob-store-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips bytes and content type at a serving-plane path", async () => {
    const store = createFsBlobStore(root);
    const bytes = encoder.encode('{"protocol":"x"}');
    await store.put(WELL_KNOWN_PATH, bytes, "application/json");

    const read = await store.get(WELL_KNOWN_PATH);
    expect(read).toBeDefined();
    expect(new TextDecoder().decode(read!.bytes)).toBe('{"protocol":"x"}');
    expect(read!.contentType).toBe("application/json");
  });

  it("returns undefined for a path that was never written", async () => {
    const store = createFsBlobStore(root);
    expect(await store.get("/sources/feed/head")).toBeUndefined();
  });

  it("satisfies serve's BlobStore port -- writeRecord lands at the digest path", async () => {
    const store = createFsBlobStore(root);
    const bytes = encoder.encode("sealed-record-bytes");
    const { digest, path } = await writeRecord(store, bytes, "application/json");

    expect(digest).toBe(recordDigest(bytes));
    expect(path).toBe(recordPath(digest));
    const read = await store.get(path);
    expect(new TextDecoder().decode(read!.bytes)).toBe("sealed-record-bytes");
  });

  it("writes atomically -- no temporary file survives a completed put", async () => {
    const store = createFsBlobStore(root);
    await store.put("/sources/feed/entries/0000000000000001", encoder.encode("page"), "application/json");
    const entries = await readdir(join(root, "sources", "feed", "entries"));
    // The permanent content-type sidecar is expected alongside the object;
    // what atomicity forbids is a dangling ".tmp-*" file from a partial write.
    expect(entries.slice().sort()).toEqual(["0000000000000001", "0000000000000001.content-type"]);
  });

  it("is idempotent at a digest path for identical bytes", async () => {
    const store = createFsBlobStore(root);
    const bytes = encoder.encode("same-bytes");
    const digest = recordDigest(bytes);
    await store.put(recordPath(digest), bytes, "application/json");
    await store.put(recordPath(digest), bytes, "application/json");
    const read = await store.get(recordPath(digest));
    expect(new TextDecoder().decode(read!.bytes)).toBe("same-bytes");
  });

  it("refuses to overwrite a digest path with different bytes", async () => {
    const store = createFsBlobStore(root);
    const digest = recordDigest(encoder.encode("original"));
    await store.put(recordPath(digest), encoder.encode("original"), "application/json");
    await expect(store.put(recordPath(digest), encoder.encode("tampered"), "application/json"))
      .rejects.toBeInstanceOf(ContentAddressedConflictError);
  });

  it("overwrites the mutable head in place", async () => {
    const store = createFsBlobStore(root);
    await store.put("/sources/feed/head", encoder.encode("head-1"), "application/json");
    await store.put("/sources/feed/head", encoder.encode("head-2"), "application/json");
    const read = await store.get("/sources/feed/head");
    expect(new TextDecoder().decode(read!.bytes)).toBe("head-2");
  });

  it("rejects paths that escape the root", async () => {
    const store = createFsBlobStore(root);
    await expect(store.put("/../escaped", encoder.encode("x"), "text/plain"))
      .rejects.toBeInstanceOf(UnsafeBlobPathError);
    await expect(store.get("/sources/../../escaped")).rejects.toBeInstanceOf(UnsafeBlobPathError);
  });

  it("defaults an unknown content type when the sidecar is absent", async () => {
    const store = createFsBlobStore(root);
    await writeFile(join(root, "orphan"), "bare");
    const read = await store.get("/orphan");
    expect(read!.contentType).toBe("application/octet-stream");
    expect(await readFile(join(root, "orphan"), "utf8")).toBe("bare");
  });
});
