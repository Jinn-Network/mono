// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import type {
  EvidenceRecordAnnouncementSource,
} from "@jinn-network/evidence-discovery";
import type {
  FilesystemEvidenceAnnouncementJournal,
} from "@jinn-network/evidence-discovery/journal";
import type {
  EvidenceRecordReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import type { SourceIdentity } from "@jinn-network/record-discovery-protocol";
import { formatOrigin, sealJson } from "@jinn-network/record-discovery-protocol";
import {
  createDurableSourceWriter,
  type CasSnapshot,
  type CasWriteResult,
  type DurableSourceAppendIntent,
  type DurableSourceSigner,
  type DurableSourceState,
  type DurableSourceWriter,
  type ReadableImmutableBlobStore,
  type SourceAppendIntentStore,
  type SourceStateStore,
} from "@jinn-network/record-discovery-serve";

import { LocalEvidenceRuntimeError, localRuntimeIoError } from "./errors.js";

interface StrategyClaim {
  readonly version: 1;
  readonly sourceId: string;
  readonly strategyId: string;
}

function revision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function nodeCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readManagedJson<T>(path: string): Promise<{ bytes: Uint8Array; value: T } | undefined> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new LocalEvidenceRuntimeError(
      "UNSAFE_PATH",
      `Public discovery state must be a singly-linked regular file: ${path}`,
    );
  }
  if (
    process.platform !== "win32"
    && process.getuid !== undefined
    && stats.uid !== process.getuid()
  ) {
    throw new LocalEvidenceRuntimeError(
      "UNSAFE_PATH",
      `Public discovery state is not owned by the current user: ${path}`,
    );
  }
  const bytes = await readFile(path);
  try {
    return { bytes, value: JSON.parse(new TextDecoder().decode(bytes)) as T };
  } catch (error) {
    throw new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      `Public discovery state is not valid JSON: ${path}`,
      { cause: error },
    );
  }
}

async function replaceManagedJson(path: string, directory: string, value: unknown): Promise<Uint8Array> {
  const bytes = sealJson(value).bytes;
  const temporary = join(directory, `.tmp-${randomUUID()}.json`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
    return bytes;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createManagedJson(
  path: string,
  directory: string,
  value: unknown,
): Promise<Uint8Array | undefined> {
  const bytes = sealJson(value).bytes;
  const temporary = join(directory, `.claim-${randomUUID()}.json`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (nodeCode(error) === "EEXIST") return undefined;
      throw error;
    }
    await rm(temporary);
    await syncDirectory(directory);
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

class FileCasStore<T> {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly directory: string,
    private readonly expectedSourceId: string,
  ) {}

  async read(sourceId: string): Promise<CasSnapshot<T> | undefined> {
    this.assertSource(sourceId);
    const stored = await readManagedJson<T>(this.path);
    return stored === undefined
      ? undefined
      : { revision: revision(stored.bytes), value: stored.value };
  }

  compareAndSwap(
    sourceId: string,
    expectedRevision: string | null,
    next: T | undefined,
  ): Promise<CasWriteResult> {
    this.assertSource(sourceId);
    const operation = this.#tail.then(async () => {
      const current = await readManagedJson<T>(this.path);
      const actualRevision = current === undefined ? null : revision(current.bytes);
      if (actualRevision !== expectedRevision) return { ok: false as const };
      if (next === undefined) {
        await rm(this.path, { force: true });
        await syncDirectory(this.directory);
        return { ok: true as const, revision: `deleted:${actualRevision ?? "empty"}` };
      }
      const bytes = await replaceManagedJson(this.path, this.directory, next);
      return { ok: true as const, revision: revision(bytes) };
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private assertSource(sourceId: string): void {
    if (sourceId !== this.expectedSourceId) {
      throw new LocalEvidenceRuntimeError(
        "RUNTIME_CORRUPT",
        "Public discovery state was addressed through a different source identity.",
      );
    }
  }
}

class FileStrategyStore implements LocalPublicSourceStrategyStore {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly directory: string,
    private readonly expectedSourceId: string,
  ) {}

  async read(sourceId: string): Promise<string | undefined> {
    if (sourceId !== this.expectedSourceId) {
      throw new LocalEvidenceRuntimeError(
        "RUNTIME_CORRUPT",
        "Public discovery strategy state was addressed through a different source identity.",
      );
    }
    const existing = await readManagedJson<StrategyClaim>(this.path);
    if (existing === undefined) return undefined;
    if (existing.value.version !== 1 || existing.value.sourceId !== sourceId) {
      throw new LocalEvidenceRuntimeError(
        "RUNTIME_CORRUPT",
        "Public discovery strategy ownership state is invalid.",
      );
    }
    return existing.value.strategyId;
  }

  claim(sourceId: string, strategyId: string): Promise<"claimed" | "existing" | "conflict"> {
    const operation = this.#tail.then(async () => {
      if (sourceId !== this.expectedSourceId) return "conflict" as const;
      const existing = await readManagedJson<StrategyClaim>(this.path);
      if (existing !== undefined) {
        return existing.value.version === 1
          && existing.value.sourceId === sourceId
          && existing.value.strategyId === strategyId
          ? "existing" as const
          : "conflict" as const;
      }
      const claim: StrategyClaim = { version: 1, sourceId, strategyId };
      const created = await createManagedJson(this.path, this.directory, claim);
      if (created !== undefined) return "claimed" as const;
      const winner = await readManagedJson<StrategyClaim>(this.path);
      return winner?.value.version === 1
        && winner.value.sourceId === sourceId
        && winner.value.strategyId === strategyId
        ? "existing" as const
        : "conflict" as const;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

const EMPTY_WITHDRAWALS: EvidenceRecordAnnouncementSource = {
  async *read() { /* no configured withdrawal source */ },
};

export interface LocalPublicDiscoveryBridgeState {
  readonly source: SourceIdentity;
  readonly journalCursor?: string;
  readonly withdrawalCursor?: string;
  readonly pending?: unknown;
}

export interface LocalPublicDiscoveryBridge {
  sync(): Promise<unknown>;
  readState(): Promise<LocalPublicDiscoveryBridgeState | undefined>;
}

export interface LocalPublicDiscoveryCasStore<State> {
  read(sourceId: string): Promise<CasSnapshot<State> | undefined>;
  compareAndSwap(
    sourceId: string,
    expectedRevision: string | null,
    next: State,
  ): Promise<CasWriteResult>;
}

export interface LocalPublicSourceStrategyStore {
  read(sourceId: string): Promise<string | undefined>;
  claim(
    sourceId: string,
    strategyId: string,
  ): Promise<"claimed" | "existing" | "conflict">;
}

/**
 * Structurally injected optional bridge boundary. Keeping the adapter factory outside this
 * package prevents the evidence-local-runtime package from adding the adapter to every native
 * role's dependency closure.
 */
export interface EvidenceJournalPublicDiscoveryBridgeContext {
  readonly source: SourceIdentity;
  readonly evidenceSourceId: string;
  readonly journal: EvidenceRecordAnnouncementSource;
  readonly withdrawals: EvidenceRecordAnnouncementSource;
  readonly records: {
    getRecord(reference: EvidenceRecordReference): Promise<Uint8Array | null>;
  };
  readonly writer: DurableSourceWriter;
  readonly writerIntents: {
    hasPending(sourceId: string): Promise<boolean>;
  };
  readonly openBridgeStateStore: <State>() => LocalPublicDiscoveryCasStore<State>;
  readonly strategies: LocalPublicSourceStrategyStore;
  readonly now: () => Date;
}

export type EvidenceJournalPublicDiscoveryBridgeFactory = (
  context: EvidenceJournalPublicDiscoveryBridgeContext,
) => LocalPublicDiscoveryBridge;

export interface OpenEvidenceJournalPublicDiscoveryOptions {
  readonly stateDir: string;
  readonly source: SourceIdentity;
  readonly evidenceSourceId: string;
  readonly journal: FilesystemEvidenceAnnouncementJournal;
  readonly repository: EvidenceRepository;
  readonly withdrawals?: EvidenceRecordAnnouncementSource;
  readonly signer: DurableSourceSigner;
  readonly blobs: ReadableImmutableBlobStore;
  readonly bridgeFactory: EvidenceJournalPublicDiscoveryBridgeFactory;
  readonly now?: () => Date;
  readonly refreshWithinMs?: number;
}

/**
 * Hosts the real filesystem evidence journal through the permanent local-to-public adapter.
 * The caller has already acquired the local runtime root lock and prepared `stateDir` privately.
 */
export function openEvidenceJournalPublicDiscovery(
  options: OpenEvidenceJournalPublicDiscoveryOptions,
): LocalPublicDiscoveryBridge {
  const sourceId = formatOrigin(options.source.agent, options.source.name);
  const sourceStates = new FileCasStore<DurableSourceState>(
    join(options.stateDir, "source-state.json"),
    options.stateDir,
    sourceId,
  );
  const sourceIntents = new FileCasStore<DurableSourceAppendIntent>(
    join(options.stateDir, "append-intent.json"),
    options.stateDir,
    sourceId,
  );
  const writer = createDurableSourceWriter({
    source: options.source,
    signer: options.signer,
    blobs: options.blobs,
    states: sourceStates as SourceStateStore,
    intents: sourceIntents as SourceAppendIntentStore,
    ...(options.refreshWithinMs === undefined
      ? {}
      : { refreshWithinMs: options.refreshWithinMs }),
  });
  return options.bridgeFactory({
    source: options.source,
    evidenceSourceId: options.evidenceSourceId,
    journal: options.journal,
    withdrawals: options.withdrawals ?? EMPTY_WITHDRAWALS,
    records: {
      async getRecord(reference) {
        return options.repository.getRecord(reference);
      },
    },
    writer,
    writerIntents: {
      async hasPending(requestedSourceId) {
        return (await sourceIntents.read(requestedSourceId)) !== undefined;
      },
    },
    openBridgeStateStore: <State>() => new FileCasStore<State>(
      join(options.stateDir, "bridge-state.json"),
      options.stateDir,
      sourceId,
    ),
    strategies: new FileStrategyStore(
      join(options.stateDir, "strategy.json"),
      options.stateDir,
      sourceId,
    ),
    now: options.now ?? (() => new Date()),
  });
}

/** Converts unexpected filesystem failures at the optional host boundary. */
export function publicDiscoveryRuntimeError(error: unknown): LocalEvidenceRuntimeError {
  if (error instanceof LocalEvidenceRuntimeError) return error;
  return localRuntimeIoError(error, "Public Record Discovery bridge failed.");
}
