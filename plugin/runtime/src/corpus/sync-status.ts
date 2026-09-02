// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import type { RuntimeLogger } from "../logger.js";
import { writeFileAtomically } from "./atomic-write.js";
import { describeError, nodeErrorCode } from "./errors.js";
import type { CorpusFilesystem } from "./fs.js";
import { compareCodeUnitStrings } from "./order.js";

export const MIRROR_SYNC_STATUS_FORMAT = "jinn-corpus-mirror-sync-status/1" as const;
export const MIRROR_SYNC_STATUS_FILENAME = "mirror-sync-status.json";

/** The ceiling on each half of a recorded failure, shared by the writer and the schema. */
export const MAX_FAILURE_CHARS = 512;

/**
 * `code` and `message` are PEER-INFLUENCED: `message` is `describeError` over
 * a transport error, and `TransportRedirectError` embeds the peer-supplied
 * `Location` header verbatim. They reach a durable file and, through the
 * freshness row, an operator's console — so they are bounded here the way
 * every other untrusted-text egress in this package is bounded, and stripped
 * of control characters at the point they are recorded (`recordOutcome`).
 */
const FailureSchema = z.strictObject({
  code: z.string().min(1).max(MAX_FAILURE_CHARS),
  message: z.string().min(1).max(MAX_FAILURE_CHARS),
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
      /**
       * Set when the mirror synced but the public-plane index pass that
       * follows it threw. Recorded apart from `status` because the two report
       * different subsystems: the mirror really did sync, and folding an
       * index fault into `status` would send an operator looking at their
       * feed while `corpus_search` quietly answers over a stale index.
       */
      indexError: z.string().min(1).max(MAX_FAILURE_CHARS).optional(),
    })
    .optional(),
  sources: z.record(z.string(), SourceStatusSchema),
});

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

      await writeFileAtomically({ fs: options.fs, filePath: options.filePath, body, tempNonce });
    },
  };
}
