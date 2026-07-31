// SPDX-License-Identifier: Apache-2.0

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  HighWaterMark,
  HighWaterMarkStore,
  SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import { z } from "zod";

import { CORPUS_ERROR_CODES, CorpusMirrorError, describeError, nodeErrorCode } from "./errors.js";
import { compareCodeUnitStrings } from "./order.js";

export const HIGH_WATER_MARK_FORMAT = "jinn-corpus-mirror-high-water-marks/1" as const;

const HighWaterMarkSchema = z.strictObject({
  sequence: z.string().regex(/^[0-9]{16}$/),
  entry: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  issuedAt: z.string().min(1),
});

const StateFileSchema = z.strictObject({
  format: z.literal(HIGH_WATER_MARK_FORMAT),
  marks: z.record(z.string(), HighWaterMarkSchema),
});

function sourceKey(source: SourceIdentity): string {
  return `${source.agent}/${source.name}`;
}

/**
 * A durable `HighWaterMarkStore`. `record-discovery-client` ships only an
 * in-memory implementation and documents it as unsuitable for anything but
 * short-lived processes; a session-scoped runtime that lost its position
 * every session would cold-sync every followed archive on every start.
 *
 * A corrupt or structurally invalid state file is an ERROR, not an absent
 * mark. Treating corruption as "never synced" would silently replay every
 * archive from genesis — a quiet, expensive failure mode. Because sync
 * failure never reaches the read path (see `read.ts`), failing loudly here
 * degrades relevance, never availability.
 */
export function createFileHighWaterMarkStore(options: {
  readonly filePath: string;
}): HighWaterMarkStore {
  let cache: Map<string, HighWaterMark> | undefined;

  async function load(): Promise<Map<string, HighWaterMark>> {
    if (cache !== undefined) return cache;

    let text: string;
    try {
      text = await readFile(options.filePath, "utf8");
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        cache = new Map();
        return cache;
      }
      throw new CorpusMirrorError(
        CORPUS_ERROR_CODES.highWaterMarkIo,
        `Unable to read the mirror state file at ${options.filePath}.`,
        { cause: error },
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      throw new CorpusMirrorError(
        CORPUS_ERROR_CODES.highWaterMarkCorrupt,
        `The mirror state file at ${options.filePath} is not valid JSON: ${describeError(error)}`,
        { cause: error },
      );
    }

    const parsed = StateFileSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new CorpusMirrorError(
        CORPUS_ERROR_CODES.highWaterMarkCorrupt,
        `The mirror state file at ${options.filePath} is not a recognized ${HIGH_WATER_MARK_FORMAT} document.`,
      );
    }

    cache = new Map(Object.entries(parsed.data.marks) as [string, HighWaterMark][]);
    return cache;
  }

  async function persist(marks: ReadonlyMap<string, HighWaterMark>): Promise<void> {
    const ordered: Record<string, HighWaterMark> = {};
    for (const key of [...marks.keys()].sort(compareCodeUnitStrings)) {
      ordered[key] = marks.get(key)!;
    }
    const body = `${JSON.stringify({ format: HIGH_WATER_MARK_FORMAT, marks: ordered }, null, 2)}\n`;

    const temporaryPath = `${options.filePath}.${String(process.pid)}.tmp`;
    try {
      await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
      await unlink(temporaryPath).catch(() => undefined);
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, options.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new CorpusMirrorError(
        CORPUS_ERROR_CODES.highWaterMarkIo,
        `Unable to write the mirror state file at ${options.filePath}.`,
        { cause: error },
      );
    }
  }

  return {
    async get(source: SourceIdentity): Promise<HighWaterMark | undefined> {
      return (await load()).get(sourceKey(source));
    },
    async put(source: SourceIdentity, value: HighWaterMark): Promise<void> {
      const marks = await load();
      marks.set(sourceKey(source), value);
      await persist(marks);
    },
  };
}
