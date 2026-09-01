// SPDX-License-Identifier: Apache-2.0

import { dirname } from "node:path";

import { z } from "zod";

import type { RuntimeLogger } from "../logger.js";
import { describeError, nodeErrorCode } from "./errors.js";
import type { CorpusFilesystem } from "./fs.js";
import { compareCodeUnitStrings } from "./order.js";

export const MIRROR_SYNC_STATUS_FORMAT = "jinn-corpus-mirror-sync-status/1" as const;
export const MIRROR_SYNC_STATUS_FILENAME = "mirror-sync-status.json";

const FailureSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  at: z.string().min(1),
});

const SourceStatusSchema = z.strictObject({
  lastSyncedAt: z.string().min(1).optional(),
  lastFailure: FailureSchema.optional(),
});

const StatusFileSchema = z.strictObject({
  format: z.literal(MIRROR_SYNC_STATUS_FORMAT),
  lastCycle: z
    .strictObject({
      completedAt: z.string().min(1),
      status: z.enum(["synced", "partial", "failed", "skipped-locked"]),
    })
    .optional(),
  sources: z.record(z.string(), SourceStatusSchema),
});

export type MirrorSyncFailure = z.infer<typeof FailureSchema>;
export type MirrorSourceSyncStatus = z.infer<typeof SourceStatusSchema>;
export type MirrorSyncStatusRecord = z.infer<typeof StatusFileSchema>;

export interface MirrorSyncStatusStore {
  read(): Promise<MirrorSyncStatusRecord | undefined>;
  write(value: MirrorSyncStatusRecord): Promise<void>;
}

/**
 * The mirror service's durable report of what it last did, keyed by
 * `"<agent>/<name>"` exactly as the high-water-mark document is, so the two
 * files describe the same sources under the same names.
 *
 * A corrupt or unrecognized file WARNS and reads as absent, deliberately
 * unlike `createFileHighWaterMarkStore`, which throws. That store's document
 * is the sync POSITION: treating its corruption as "never synced" would
 * silently replay every followed archive from genesis. This document is only a
 * report — losing it costs one cycle of freshness history, which the next
 * cycle rewrites — so refusing to start over it would trade a cheap loss for
 * an expensive one.
 */
export function createFileMirrorSyncStatusStore(options: {
  readonly filePath: string;
  readonly fs: CorpusFilesystem;
  readonly log: RuntimeLogger;
  readonly tempNonce?: () => string;
}): MirrorSyncStatusStore {
  const tempNonce = options.tempNonce ?? (() => crypto.randomUUID());

  function unreadable(reason: string): undefined {
    options.log.warn("corpus.mirror.status.unreadable", { path: options.filePath, reason });
    return undefined;
  }

  return {
    async read(): Promise<MirrorSyncStatusRecord | undefined> {
      let text: string;
      try {
        text = await options.fs.readFile(options.filePath, "utf8");
      } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") return undefined;
        return unreadable(describeError(error));
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch (error) {
        return unreadable(`not valid JSON: ${describeError(error)}`);
      }

      const parsed = StatusFileSchema.safeParse(decoded);
      if (!parsed.success) {
        return unreadable(`not a recognized ${MIRROR_SYNC_STATUS_FORMAT} document`);
      }
      return parsed.data;
    },

    async write(value: MirrorSyncStatusRecord): Promise<void> {
      const sources: Record<string, MirrorSourceSyncStatus> = {};
      for (const key of Object.keys(value.sources).sort(compareCodeUnitStrings)) {
        sources[key] = value.sources[key]!;
      }
      const body = `${JSON.stringify({ ...value, sources }, null, 2)}\n`;

      const temporaryPath = `${options.filePath}.${tempNonce()}.tmp`;
      try {
        await options.fs.mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
        await options.fs.unlink(temporaryPath).catch(() => undefined);
        const handle = await options.fs.open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(body, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await options.fs.rename(temporaryPath, options.filePath);
      } catch (error) {
        await options.fs.unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}
