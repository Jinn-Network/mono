// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnitStrings } from "../order.js";
import { assertBareHex } from "../digest.js";
import { DerivationError } from "../errors.js";
import {
  assertEntryDigests,
  parsePoolEntryManifest,
  poolEntryConflictKeyBytes,
  poolEntryManifestBytes,
  type PoolEntry,
  type PoolEntrySummary,
  type SupplyPool,
} from "../pool.js";

const TASK_FILE = "task.sealed.json";
const SPEC_FILE = "evaluation-spec.sealed.json";
const MANIFEST_FILE = "entry.json";

export interface FilesystemSupplyPoolOptions {
  readonly dir: string;
  /**
   * Distinguishes concurrent staging directories. Required rather than defaulted: ambient
   * randomness is authority this package does not take (program §5 contract 4). Production
   * callers pass `() => randomUUID()`.
   */
  readonly uniqueSuffix: () => string;
}

function addressOf(taskDigest: string): string {
  return assertBareHex(
    taskDigest.startsWith("sha256:") ? taskDigest.slice("sha256:".length) : taskDigest,
    "task digest",
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Sealed pairs on disk, digest-addressed. Writes are atomic per entry: the three files are
 * staged in a scratch directory and the *directory* is renamed into place, so a reader
 * never observes a half-written entry.
 */
export function createFilesystemSupplyPool(options: FilesystemSupplyPoolOptions): SupplyPool {
  const entriesRoot = join(options.dir, "entries");
  const stagingRoot = join(options.dir, ".staging");

  async function readEntryAt(address: string): Promise<PoolEntry | undefined> {
    const directory = join(entriesRoot, address);
    const manifestBytes = await readIfPresent(join(directory, MANIFEST_FILE));
    if (manifestBytes === undefined) return undefined;
    const summary = parsePoolEntryManifest(manifestBytes);
    const taskBytes = await readIfPresent(join(directory, TASK_FILE));
    const evaluationSpecBytes = await readIfPresent(join(directory, SPEC_FILE));
    if (taskBytes === undefined || evaluationSpecBytes === undefined) {
      throw new DerivationError("pool-conflict", `pool entry ${address} is missing sealed bytes.`);
    }
    const entry: PoolEntry = { ...summary, taskBytes, evaluationSpecBytes };
    assertEntryDigests(entry);
    return entry;
  }

  return {
    async put(entry: PoolEntry): Promise<PoolEntrySummary> {
      assertEntryDigests(entry);
      const address = addressOf(entry.taskDigest);
      const manifestBytes = poolEntryManifestBytes(entry);

      const staging = join(stagingRoot, `${address}.${options.uniqueSuffix()}`);
      await mkdir(entriesRoot, { recursive: true });
      await mkdir(staging, { recursive: true });
      try {
        await writeFile(join(staging, TASK_FILE), entry.taskBytes);
        await writeFile(join(staging, SPEC_FILE), entry.evaluationSpecBytes);
        await writeFile(join(staging, MANIFEST_FILE), manifestBytes);
        await rename(staging, join(entriesRoot, address));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        // Address already taken: the same claim is idempotent, a different claim is a
        // conflict. A sealed pair is never rewritten (principles §5/§7). "Same claim"
        // deliberately excludes `receiptDigest` — see poolEntryConflictKeyBytes.
        await rm(staging, { recursive: true, force: true });
        const existingTask = await readIfPresent(join(entriesRoot, address, TASK_FILE));
        const existingSpec = await readIfPresent(join(entriesRoot, address, SPEC_FILE));
        const existingManifest = await readIfPresent(join(entriesRoot, address, MANIFEST_FILE));
        const identical =
          existingTask !== undefined
          && existingSpec !== undefined
          && existingManifest !== undefined
          && bytesEqual(existingTask, entry.taskBytes)
          && bytesEqual(existingSpec, entry.evaluationSpecBytes)
          && bytesEqual(
            poolEntryConflictKeyBytes(parsePoolEntryManifest(existingManifest)),
            poolEntryConflictKeyBytes(entry),
          );
        if (!identical) {
          throw new DerivationError(
            "pool-conflict",
            `pool already holds a different body at ${entry.taskDigest}.`,
          );
        }
        return parsePoolEntryManifest(existingManifest);
      }

      const { taskBytes: _taskBytes, evaluationSpecBytes: _specBytes, ...summary } = entry;
      return summary;
    },

    async get(taskDigest: string): Promise<PoolEntry | undefined> {
      return readEntryAt(addressOf(taskDigest));
    },

    async list(): Promise<readonly PoolEntrySummary[]> {
      let addresses: string[];
      try {
        addresses = await readdir(entriesRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const summaries: PoolEntrySummary[] = [];
      for (const address of addresses.sort(compareCodeUnitStrings)) {
        const manifestBytes = await readIfPresent(join(entriesRoot, address, MANIFEST_FILE));
        if (manifestBytes !== undefined) summaries.push(parsePoolEntryManifest(manifestBytes));
      }
      return summaries.sort((left, right) =>
        compareCodeUnitStrings(left.taskDigest, right.taskDigest));
    },
  };
}
