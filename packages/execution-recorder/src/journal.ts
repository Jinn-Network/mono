// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Sha256Digest } from "@jinn-network/evidence-repository";

import { assertRecorderOperationActive, ExecutionRecorderError } from "./errors.js";
import {
  WORKSPACE_FORMAT_VERSION,
  type JournalEntry,
  type JournalEvent,
} from "./journal-types.js";
import {
  prepareWorkspaceDirectories,
  recorderIoError,
  validateWorkspaceParentChain,
  type WorkspacePaths,
} from "./paths.js";
import type { ExecutionId } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EXECUTION_ID =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JOURNAL_FILE = /^(\d{12})\.json$/u;
const JOURNAL_EVENT_TYPES = new Set<JournalEvent["type"]>([
  "initialized",
  "input-captured",
  "runtime-observation-captured",
  "native-trace-attached",
  "finalization-prepared",
  "repository-artifact-written",
  "repository-record-written",
  "finalized",
]);

export interface WorkspaceMarker {
  readonly formatVersion: typeof WORKSPACE_FORMAT_VERSION;
  readonly executionId: ExecutionId;
}

export interface JournalHead {
  readonly revision: number;
  readonly digest: Sha256Digest | null;
}

export interface JournalReplay {
  readonly entries: readonly JournalEntry[];
  readonly head: JournalHead;
}

export interface AppendedJournalEntry {
  readonly entry: JournalEntry;
  readonly head: JournalHead;
}

export const EMPTY_JOURNAL_HEAD: JournalHead = {
  revision: 0,
  digest: null,
};

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function journalDigest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function markerBytes(marker: WorkspaceMarker): Uint8Array {
  return encoder.encode(`${JSON.stringify(marker)}\n`);
}

function entryBytes(entry: JournalEntry): Uint8Array {
  return encoder.encode(`${JSON.stringify(entry)}\n`);
}

function workspaceCorrupt(
  paths: WorkspacePaths,
  message: string,
  error?: unknown,
): ExecutionRecorderError {
  return new ExecutionRecorderError(
    "WORKSPACE_CORRUPT",
    message,
    { workspaceDir: paths.root },
    error === undefined ? undefined : { cause: error },
  );
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readWorkspaceFile(
  paths: WorkspacePaths,
  path: string,
  missingAllowed: boolean,
): Promise<Uint8Array | null> {
  let handle;
  try {
    await validateWorkspaceParentChain(paths, path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new ExecutionRecorderError(
        "UNSAFE_PATH",
        `Recorder workspace file must be regular and not a symlink: ${path}`,
        { workspaceDir: paths.root },
      );
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new ExecutionRecorderError(
        "UNSAFE_PATH",
        `Recorder workspace file changed while opening: ${path}`,
        { workspaceDir: paths.root },
      );
    }
    return new Uint8Array(await handle.readFile());
  } catch (error) {
    if (missingAllowed && nodeErrorCode(error) === "ENOENT") return null;
    if (error instanceof ExecutionRecorderError) throw error;
    throw recorderIoError(
      error,
      `Unable to read recorder workspace file: ${path}`,
    );
  } finally {
    await handle?.close();
  }
}

async function publishNewWorkspaceFile(
  paths: WorkspacePaths,
  path: string,
  bytes: Uint8Array,
  conflictMessage: string,
  signal?: AbortSignal,
): Promise<void> {
  const parent = dirname(path);
  const temporary = join(
    parent,
    `.${path.slice(parent.length + 1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertRecorderOperationActive(signal);
    try {
      await link(temporary, path);
      await syncDirectory(parent);
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") {
        throw new ExecutionRecorderError(
          "RECORDING_CONFLICT",
          conflictMessage,
          { workspaceDir: paths.root },
          { cause: error },
        );
      }
      throw error;
    }
    await unlink(temporary);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof ExecutionRecorderError) throw error;
    throw recorderIoError(
      error,
      `Unable to publish recorder workspace file: ${path}`,
    );
  }
}

function parseJson(
  paths: WorkspacePaths,
  bytes: Uint8Array,
  description: string,
): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw workspaceCorrupt(
      paths,
      `${description} is not valid UTF-8 JSON.`,
      error,
    );
  }
}

function parseMarker(
  paths: WorkspacePaths,
  bytes: Uint8Array,
): WorkspaceMarker {
  const value = parseJson(paths, bytes, "Recorder workspace marker");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw workspaceCorrupt(paths, "Recorder workspace marker is malformed.");
  }
  const candidate = value as {
    formatVersion?: unknown;
    executionId?: unknown;
  };
  if (candidate.formatVersion !== WORKSPACE_FORMAT_VERSION) {
    if (typeof candidate.formatVersion === "number") {
      throw new ExecutionRecorderError(
        "WORKSPACE_VERSION_UNSUPPORTED",
        `Recorder workspace format version is unsupported: ${String(candidate.formatVersion)}`,
        { workspaceDir: paths.root },
      );
    }
    throw workspaceCorrupt(paths, "Recorder workspace marker has no valid version.");
  }
  if (
    typeof candidate.executionId !== "string" ||
    !EXECUTION_ID.test(candidate.executionId)
  ) {
    throw workspaceCorrupt(
      paths,
      "Recorder workspace marker has no valid execution ID.",
    );
  }
  return candidate as WorkspaceMarker;
}

export async function readWorkspaceMarker(
  paths: WorkspacePaths,
  signal?: AbortSignal,
): Promise<WorkspaceMarker> {
  assertRecorderOperationActive(signal);
  const bytes = await readWorkspaceFile(paths, paths.marker, true);
  if (bytes === null) {
    throw new ExecutionRecorderError(
      "RECORDING_NOT_FOUND",
      `Execution recording workspace was not found: ${paths.root}`,
      { workspaceDir: paths.root },
    );
  }
  assertRecorderOperationActive(signal);
  return parseMarker(paths, bytes);
}

export async function initializeWorkspaceMarker(
  paths: WorkspacePaths,
  executionId: ExecutionId,
  signal?: AbortSignal,
): Promise<WorkspaceMarker> {
  assertRecorderOperationActive(signal);
  await prepareWorkspaceDirectories(paths);
  const marker: WorkspaceMarker = {
    formatVersion: WORKSPACE_FORMAT_VERSION,
    executionId,
  };
  const existing = await readWorkspaceFile(paths, paths.marker, true);
  if (existing !== null) {
    const parsed = parseMarker(paths, existing);
    if (parsed.executionId !== executionId) {
      throw new ExecutionRecorderError(
        "RECORDING_CONFLICT",
        "Recorder workspace belongs to a different execution.",
        { workspaceDir: paths.root },
      );
    }
    return parsed;
  }

  try {
    await publishNewWorkspaceFile(
      paths,
      paths.marker,
      markerBytes(marker),
      "Recorder workspace marker was created concurrently.",
      signal,
    );
  } catch (error) {
    if (
      error instanceof ExecutionRecorderError &&
      error.code === "RECORDING_CONFLICT"
    ) {
      const parsed = await readWorkspaceMarker(paths, signal);
      if (parsed.executionId === executionId) return parsed;
    }
    throw error;
  }
  return readWorkspaceMarker(paths, signal);
}

export function journalEntryPath(
  paths: WorkspacePaths,
  revision: number,
): string {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999_999_999_999) {
    throw new ExecutionRecorderError(
      "WORKSPACE_CORRUPT",
      `Journal revision is outside the supported range: ${revision}`,
      { workspaceDir: paths.root },
    );
  }
  return join(paths.journal, `${String(revision).padStart(12, "0")}.json`);
}

function parseEntry(
  paths: WorkspacePaths,
  bytes: Uint8Array,
  expectedRevision: number,
  expectedPreviousDigest: Sha256Digest | null,
): JournalEntry {
  const value = parseJson(paths, bytes, `Journal revision ${expectedRevision}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw workspaceCorrupt(paths, `Journal revision ${expectedRevision} is malformed.`);
  }
  const candidate = value as {
    formatVersion?: unknown;
    revision?: unknown;
    previousEntryDigest?: unknown;
    committedAt?: unknown;
    event?: unknown;
  };
  if (candidate.formatVersion !== WORKSPACE_FORMAT_VERSION) {
    if (typeof candidate.formatVersion === "number") {
      throw new ExecutionRecorderError(
        "WORKSPACE_VERSION_UNSUPPORTED",
        `Journal format version is unsupported: ${String(candidate.formatVersion)}`,
        { workspaceDir: paths.root },
      );
    }
    throw workspaceCorrupt(paths, `Journal revision ${expectedRevision} has no valid version.`);
  }
  const event =
    typeof candidate.event === "object" &&
    candidate.event !== null &&
    !Array.isArray(candidate.event)
      ? (candidate.event as Record<string, unknown>)
      : null;
  if (
    candidate.revision !== expectedRevision ||
    candidate.previousEntryDigest !== expectedPreviousDigest ||
    typeof candidate.committedAt !== "string" ||
    event === null ||
    !JOURNAL_EVENT_TYPES.has(
      event?.type as JournalEvent["type"],
    )
  ) {
    throw workspaceCorrupt(
      paths,
      `Journal revision ${expectedRevision} violates the immutable chain.`,
    );
  }
  if (
    candidate.previousEntryDigest !== null &&
    !SHA256_DIGEST.test(candidate.previousEntryDigest as string)
  ) {
    throw workspaceCorrupt(
      paths,
      `Journal revision ${expectedRevision} has an invalid predecessor digest.`,
    );
  }
  if (event === null || !validJournalEventPayload(event)) {
    throw workspaceCorrupt(
      paths,
      `Journal revision ${expectedRevision} has a malformed event payload.`,
    );
  }
  return candidate as JournalEntry;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_DIGEST.test(value);
}

function isStoredObjectReference(value: unknown): boolean {
  return (
    isObject(value) &&
    isDigest(value.digest) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0
  );
}

function validJournalEventPayload(
  event: Record<string, unknown>,
): boolean {
  switch (event.type) {
    case "initialized":
      return isObject(event.recording) && isDigest(event.declarationFingerprint);
    case "input-captured":
      return isObject(event.input) && isDigest(event.declarationFingerprint);
    case "runtime-observation-captured":
      return (
        isObject(event.observation) &&
        isDigest(event.declarationFingerprint)
      );
    case "native-trace-attached":
      return isObject(event.trace) && isDigest(event.declarationFingerprint);
    case "finalization-prepared":
      return (
        isDigest(event.intentFingerprint) &&
        typeof event.finalizedAt === "string" &&
        ["completed", "failed", "abandoned"].includes(
          event.outcome as string,
        ) &&
        typeof event.endedAt === "string" &&
        Array.isArray(event.results) &&
        isObject(event.nativeTrace) &&
        isStoredObjectReference(event.metadata) &&
        Array.isArray(event.artifactDigests) &&
        event.artifactDigests.every(isDigest)
      );
    case "repository-artifact-written":
      return isDigest(event.digest);
    case "repository-record-written":
      return (
        isObject(event.reference) &&
        [
          "execution-evidence",
          "result-evaluation",
          "execution-verification",
        ].includes(event.reference.family as string) &&
        isDigest(event.reference.digest)
      );
    case "finalized":
      return isObject(event.receipt);
    default:
      return false;
  }
}

export async function replayJournal(
  paths: WorkspacePaths,
  signal?: AbortSignal,
): Promise<JournalReplay> {
  assertRecorderOperationActive(signal);
  await readWorkspaceMarker(paths, signal);
  let names: string[];
  try {
    names = await readdir(paths.journal);
  } catch (error) {
    throw recorderIoError(
      error,
      `Unable to list recorder journal: ${paths.journal}`,
    );
  }
  const committed: { readonly name: string; readonly revision: number }[] = [];
  for (const name of names) {
    if (name.startsWith(".") && name.endsWith(".tmp")) continue;
    const match = JOURNAL_FILE.exec(name);
    if (!match) {
      throw workspaceCorrupt(
        paths,
        `Recorder journal contains an unexpected file: ${name}`,
      );
    }
    committed.push({ name, revision: Number(match[1]) });
  }
  committed.sort((left, right) => left.revision - right.revision);

  const entries: JournalEntry[] = [];
  let head: JournalHead = EMPTY_JOURNAL_HEAD;
  for (const file of committed) {
    assertRecorderOperationActive(signal);
    const expectedRevision = head.revision + 1;
    if (file.revision !== expectedRevision) {
      throw workspaceCorrupt(
        paths,
        `Recorder journal has a gap before revision ${file.revision}.`,
      );
    }
    const bytes = await readWorkspaceFile(
      paths,
      join(paths.journal, file.name),
      false,
    );
    if (bytes === null) {
      throw workspaceCorrupt(
        paths,
        `Journal revision disappeared during replay: ${file.revision}.`,
      );
    }
    const entry = parseEntry(paths, bytes, expectedRevision, head.digest);
    entries.push(entry);
    head = {
      revision: expectedRevision,
      digest: journalDigest(bytes),
    };
  }
  return { entries, head };
}

export async function appendJournalEntry(
  paths: WorkspacePaths,
  event: JournalEvent,
  expectedHead: JournalHead,
  committedAt = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<AppendedJournalEntry> {
  assertRecorderOperationActive(signal);
  const replay = await replayJournal(paths, signal);
  if (
    replay.head.revision !== expectedHead.revision ||
    replay.head.digest !== expectedHead.digest
  ) {
    throw new ExecutionRecorderError(
      "RECORDING_CONFLICT",
      "Recorder journal advanced since this writer last replayed it.",
      { workspaceDir: paths.root },
    );
  }
  const entry: JournalEntry = {
    formatVersion: WORKSPACE_FORMAT_VERSION,
    revision: expectedHead.revision + 1,
    previousEntryDigest: expectedHead.digest,
    committedAt,
    event,
  };
  const bytes = entryBytes(entry);
  await publishNewWorkspaceFile(
    paths,
    journalEntryPath(paths, entry.revision),
    bytes,
    `Journal revision ${entry.revision} was committed by another writer.`,
    signal,
  );
  return {
    entry,
    head: {
      revision: entry.revision,
      digest: journalDigest(bytes),
    },
  };
}
