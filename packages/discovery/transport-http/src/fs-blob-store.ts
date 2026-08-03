import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { BlobReader, ReadWriteBlobStore } from "./ports.js";

// The filesystem BlobStore (spec §6.2). It is the production
// implementation of BOTH halves of blob storage: `serve`'s write port
// (BlobStore.put) and this package's read port (BlobReader.get), so a
// single instance backs the source producer and the HTTP handler over
// one directory tree. Design §7's serving-root grammar maps onto the
// filesystem one-to-one: the path is the relative file path, digest
// paths are immutable and content-addressed, the head is the one file
// that is rewritten.
//
// Mutable writes are temp-file-plus-rename, while immutable writes use a
// completed temporary file plus an atomic hard-link create-or-confirm, so a reader (this process's
// handler, a static host, a mirror's rsync) never observes a partial
// object. `rename(2)` within one filesystem is atomic; the temporary
// file is created in the destination's own directory so the rename never
// crosses a device boundary.

const CONTENT_TYPE_SUFFIX = ".content-type";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const DIGEST_PATH_PREFIX = "/records/";

export class ContentAddressedConflictError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `Refusing to overwrite content-addressed path "${path}" with different bytes: `
        + "a digest path is immutable by construction (design §7 item 1).",
    );
    this.name = "ContentAddressedConflictError";
    this.path = path;
  }
}

export class UnsafeBlobPathError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Blob path "${path}" resolves outside the store root.`);
    this.name = "UnsafeBlobPathError";
    this.path = path;
  }
}

function resolveWithinRoot(rootDir: string, path: string): string {
  const root = resolve(rootDir);
  const resolved = resolve(root, `.${path.startsWith("/") ? path : `/${path}`}`);
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new UnsafeBlobPathError(path);
  return resolved;
}

async function readIfPresent(file: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomically(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.tmp-${randomBytes(8).toString("hex")}`);
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Completes a temporary file before atomically linking it into an absent immutable path. */
async function createOrConfirm(file: string, bytes: Uint8Array, conflictPath: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.tmp-immutable-${randomBytes(8).toString("hex")}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readIfPresent(file);
      if (existing === undefined || !sameBytes(existing, bytes)) {
        throw new ContentAddressedConflictError(conflictPath);
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Builds the filesystem-backed serving root at `rootDir`. Content types
 * ride beside each object in a `<path>.content-type` sidecar, written
 * before the object itself so an object is never visible without its
 * declared type; the archive path grammar (`paths.ts`) never matches a
 * sidecar, so sidecars are unreachable over HTTP.
 */
export function createFsBlobStore(rootDir: string): ReadWriteBlobStore {
  async function putImmutable(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const file = resolveWithinRoot(rootDir, path);
    const contentTypeBytes = new TextEncoder().encode(contentType);
    await createOrConfirm(`${file}${CONTENT_TYPE_SUFFIX}`, contentTypeBytes, path);
    await createOrConfirm(file, bytes, path);
  }

  const store: ReadWriteBlobStore = {
    async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
      const file = resolveWithinRoot(rootDir, path);
      if (path.startsWith(DIGEST_PATH_PREFIX)) {
        await putImmutable(path, bytes, contentType);
        return;
      }
      await writeAtomically(`${file}${CONTENT_TYPE_SUFFIX}`, new TextEncoder().encode(contentType));
      await writeAtomically(file, bytes);
    },

    async get(path: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
      const file = resolveWithinRoot(rootDir, path);
      const bytes = await readIfPresent(file);
      if (bytes === undefined) return undefined;
      const declared = await readIfPresent(`${file}${CONTENT_TYPE_SUFFIX}`);
      const contentType = declared === undefined
        ? DEFAULT_CONTENT_TYPE
        : new TextDecoder().decode(declared);
      return { bytes, contentType };
    },

    putImmutable,
  };
  return store;
}
