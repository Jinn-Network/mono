import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  EvidenceRepositoryError,
  assertRepositoryOperationActive,
} from "../errors.js";
import {
  createArtifactReference,
  createRecordReference,
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
} from "../references.js";
import {
  NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
  type Sha256Digest,
} from "../types.js";

export const FILESYSTEM_REPOSITORY_FORMAT = {
  format: "jinn-evidence-repository",
  version: 1,
  hashAlgorithm: "sha256",
} as const;

export interface FilesystemEvidenceRepositoryOptions {
  readonly rootDir: string;
}

interface RecordMarker {
  readonly version: 1;
  readonly family: EvidenceRecordFamily;
  readonly digest: Sha256Digest;
}

type ExistingContentFailure =
  | "CONTENT_CORRUPT"
  | "REFERENCE_CONFLICT"
  | "IO_FAILURE";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

class PublicationInProgressError extends Error {}

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function repositoryError(
  error: unknown,
  message: string,
  fallbackCode: "IO_FAILURE" | "CONTENT_CORRUPT" | "REFERENCE_CONFLICT",
): EvidenceRepositoryError {
  if (error instanceof EvidenceRepositoryError) {
    return error;
  }
  if (["EACCES", "EPERM"].includes(nodeErrorCode(error) ?? "")) {
    return new EvidenceRepositoryError("ACCESS_DENIED", message, {
      cause: error,
    });
  }
  return new EvidenceRepositoryError(fallbackCode, message, {
    cause: error,
  });
}

function assertOwned(stat: Awaited<ReturnType<typeof lstat>>, path: string): void {
  const uid = process.platform === "win32" ? undefined : process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new EvidenceRepositoryError(
      "IO_FAILURE",
      `Repository path is not owned by the current user: ${path}`,
    );
  }
}

async function secureDirectoryMode(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_DIRECTORY ?? 0),
    );
    const opened = await handle.stat();
    if (!opened.isDirectory()) {
      throw new EvidenceRepositoryError(
        "IO_FAILURE",
        `Repository path changed while opening: ${path}`,
      );
    }
    await handle.chmod(0o700);
  } finally {
    await handle?.close();
  }
}

async function prepareSafeDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new EvidenceRepositoryError(
        "IO_FAILURE",
        `Repository path must be a directory and not a symlink: ${path}`,
      );
    }
    assertOwned(stat, path);
    await secureDirectoryMode(path);
  } catch (error) {
    throw repositoryError(
      error,
      `Unable to prepare repository directory: ${path}`,
      "IO_FAILURE",
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function managedParentSegments(rootDir: string, path: string): readonly string[] {
  const parent = dirname(path);
  const relativeParent = relative(rootDir, parent);
  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${sep}`) ||
    isAbsolute(relativeParent)
  ) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      `Repository path escapes its root: ${path}`,
    );
  }
  return relativeParent === ""
    ? []
    : relativeParent.split(sep).filter(Boolean);
}

async function prepareManagedParentChain(
  rootDir: string,
  path: string,
): Promise<void> {
  await prepareSafeDirectory(rootDir);
  let current = rootDir;
  for (const segment of managedParentSegments(rootDir, path)) {
    current = join(current, segment);
    await prepareSafeDirectory(current);
  }
}

async function validateManagedParentChain(
  rootDir: string,
  path: string,
  missingAllowed: boolean,
  failureCode: ExistingContentFailure,
): Promise<boolean> {
  try {
    const rootStat = await lstat(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new EvidenceRepositoryError(
        failureCode,
        `Repository root is not a directory or is a symlink: ${rootDir}`,
      );
    }
    assertOwned(rootStat, rootDir);
  } catch (error) {
    throw repositoryError(
      error,
      `Unable to validate repository root: ${rootDir}`,
      failureCode,
    );
  }

  let current = rootDir;
  for (const segment of managedParentSegments(rootDir, path)) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new EvidenceRepositoryError(
          failureCode,
          `Repository path contains a non-directory or symlink: ${current}`,
        );
      }
      assertOwned(stat, current);
    } catch (error) {
      if (missingAllowed && nodeErrorCode(error) === "ENOENT") return false;
      throw repositoryError(
        error,
        `Unable to validate repository directory: ${current}`,
        failureCode,
      );
    }
  }
  return true;
}

async function readSafeRegularFile(
  rootDir: string,
  path: string,
  missingAllowed: boolean,
  failureCode: ExistingContentFailure,
  publicationRetry = 0,
): Promise<Uint8Array | null> {
  let handle;
  try {
    if (
      !(await validateManagedParentChain(
        rootDir,
        path,
        missingAllowed,
        failureCode,
      ))
    ) {
      return null;
    }
    const before = await lstat(path);
    if (before.nlink === 2) {
      throw new PublicationInProgressError();
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new EvidenceRepositoryError(
        failureCode,
        `Repository content is not a private regular file: ${path}`,
      );
    }
    assertOwned(before, path);

    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (opened.nlink === 2) {
      throw new PublicationInProgressError();
    }
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1
    ) {
      throw new EvidenceRepositoryError(
        failureCode,
        `Repository content changed while opening: ${path}`,
      );
    }
    return new Uint8Array(await handle.readFile());
  } catch (error) {
    if (error instanceof PublicationInProgressError && publicationRetry < 50) {
      return delay(1).then(() =>
        readSafeRegularFile(
          rootDir,
          path,
          missingAllowed,
          failureCode,
          publicationRetry + 1,
        ),
      );
    }
    if (missingAllowed && nodeErrorCode(error) === "ENOENT") return null;
    throw repositoryError(
      error,
      `Unable to read repository content: ${path}`,
      failureCode,
    );
  } finally {
    await handle?.close();
  }
}

async function publishExactFile(
  rootDir: string,
  path: string,
  bytes: Uint8Array,
  failureCode: ExistingContentFailure,
): Promise<"created" | "existing"> {
  const parent = dirname(path);
  await prepareManagedParentChain(rootDir, path);

  const existing = await readSafeRegularFile(
    rootDir,
    path,
    true,
    failureCode,
  );
  if (existing !== null) {
    if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new EvidenceRepositoryError(
        failureCode,
        `Existing repository content conflicts with the expected bytes: ${path}`,
      );
    }
    return "existing";
  }

  const temporaryPath = join(
    parent,
    `.${path.slice(parent.length + 1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryPublished = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(temporaryPath, path);
      temporaryPublished = true;
      await syncDirectory(parent);
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }

    await unlink(temporaryPath);
    await syncDirectory(parent);

    const published = await readSafeRegularFile(
      rootDir,
      path,
      false,
      failureCode,
    );
    if (
      published === null ||
      !Buffer.from(published).equals(Buffer.from(bytes))
    ) {
      throw new EvidenceRepositoryError(
        failureCode,
        `Published repository content does not match the expected bytes: ${path}`,
      );
    }
    return temporaryPublished ? "created" : "existing";
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (nodeErrorCode(cleanupError) !== "ENOENT") {
        throw repositoryError(
          cleanupError,
          `Unable to clean repository temporary file: ${temporaryPath}`,
          "IO_FAILURE",
        );
      }
    }
    throw repositoryError(
      error,
      `Unable to publish repository content: ${path}`,
      failureCode,
    );
  }
}

function digestParts(digest: Sha256Digest): readonly [string, string] {
  const hex = digest.slice("sha256:".length);
  return [hex.slice(0, 2), hex.slice(2)];
}

function markerBytes(reference: EvidenceRecordReference): Uint8Array {
  const marker: RecordMarker = {
    version: 1,
    family: reference.family,
    digest: reference.digest,
  };
  return textEncoder.encode(`${JSON.stringify(marker)}\n`);
}

function assertMarker(
  bytes: Uint8Array,
  reference: EvidenceRecordReference,
): void {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(bytes));
  } catch (error) {
    throw new EvidenceRepositoryError(
      "REFERENCE_CONFLICT",
      "Record marker is not valid UTF-8 JSON.",
      { cause: error },
    );
  }

  const expected: RecordMarker = {
    version: 1,
    family: reference.family,
    digest: reference.digest,
  };
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(value) !== JSON.stringify(expected)
  ) {
    throw new EvidenceRepositoryError(
      "REFERENCE_CONFLICT",
      "Record marker conflicts with the requested record reference.",
    );
  }
}

export class FilesystemEvidenceRepository implements EvidenceRepository {
  readonly capabilities =
    NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES;

  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  #objectPath(digest: Sha256Digest): string {
    const [prefix, suffix] = digestParts(digest);
    return join(this.#rootDir, "objects", "sha256", prefix, suffix);
  }

  #recordMarkerPath(reference: EvidenceRecordReference): string {
    const [prefix, suffix] = digestParts(reference.digest);
    return join(
      this.#rootDir,
      "records",
      reference.family,
      "sha256",
      prefix,
      `${suffix}.json`,
    );
  }

  async putRecord(
    family: EvidenceRecordFamily,
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    assertRepositoryOperationActive(options);
    const reference = createRecordReference(family, bytes);
    await publishExactFile(
      this.#rootDir,
      this.#objectPath(reference.digest),
      bytes,
      "CONTENT_CORRUPT",
    );
    assertRepositoryOperationActive(options);
    const status = await publishExactFile(
      this.#rootDir,
      this.#recordMarkerPath(reference),
      markerBytes(reference),
      "REFERENCE_CONFLICT",
    );
    assertRepositoryOperationActive(options);
    return { reference, size: bytes.byteLength, status };
  }

  async getRecord(
    untrustedReference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    assertRepositoryOperationActive(options);
    const reference = parseEvidenceRecordReference(untrustedReference);
    const marker = await readSafeRegularFile(
      this.#rootDir,
      this.#recordMarkerPath(reference),
      true,
      "REFERENCE_CONFLICT",
    );
    if (marker === null) return null;
    assertMarker(marker, reference);

    const bytes = await readSafeRegularFile(
      this.#rootDir,
      this.#objectPath(reference.digest),
      false,
      "CONTENT_CORRUPT",
    );
    if (
      bytes === null ||
      createArtifactReference(bytes).digest !== reference.digest
    ) {
      throw new EvidenceRepositoryError(
        "CONTENT_CORRUPT",
        `Stored record bytes do not match ${reference.digest}.`,
      );
    }
    assertRepositoryOperationActive(options);
    return bytes;
  }

  async putArtifact(
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
    assertRepositoryOperationActive(options);
    const reference = createArtifactReference(bytes);
    const status = await publishExactFile(
      this.#rootDir,
      this.#objectPath(reference.digest),
      bytes,
      "CONTENT_CORRUPT",
    );
    assertRepositoryOperationActive(options);
    return { reference, size: bytes.byteLength, status };
  }

  async getArtifact(
    untrustedReference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    assertRepositoryOperationActive(options);
    const reference = parseEvidenceArtifactReference(untrustedReference);
    const bytes = await readSafeRegularFile(
      this.#rootDir,
      this.#objectPath(reference.digest),
      true,
      "CONTENT_CORRUPT",
    );
    if (bytes === null) return null;
    if (createArtifactReference(bytes).digest !== reference.digest) {
      throw new EvidenceRepositoryError(
        "CONTENT_CORRUPT",
        `Stored artifact bytes do not match ${reference.digest}.`,
      );
    }
    assertRepositoryOperationActive(options);
    return bytes;
  }
}

async function initializeRepository(rootDir: string): Promise<void> {
  await prepareSafeDirectory(rootDir);
  await prepareSafeDirectory(join(rootDir, "objects"));
  await prepareSafeDirectory(join(rootDir, "objects", "sha256"));
  await prepareSafeDirectory(join(rootDir, "records"));

  const markerPath = join(rootDir, "repository.json");
  const expectedBytes = textEncoder.encode(
    `${JSON.stringify(FILESYSTEM_REPOSITORY_FORMAT)}\n`,
  );
  await publishExactFile(rootDir, markerPath, expectedBytes, "IO_FAILURE");
}

export async function createFilesystemEvidenceRepository(
  options: FilesystemEvidenceRepositoryOptions,
): Promise<FilesystemEvidenceRepository> {
  if (
    typeof options?.rootDir !== "string" ||
    options.rootDir.trim().length === 0
  ) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      "rootDir must be a non-empty filesystem path.",
    );
  }
  const rootDir = resolve(options.rootDir);
  await initializeRepository(rootDir);
  return new FilesystemEvidenceRepository(rootDir);
}
