// SPDX-License-Identifier: Apache-2.0

import { dirname } from "node:path";

import type { CorpusFilesystem } from "./fs.js";

/**
 * Writes a whole file the only way either mirror document may be written:
 * into a uniquely-named temporary beside it, fsynced, then renamed over the
 * target.
 *
 * The mirror keeps two durable documents in the same directory — the sync
 * POSITION (`high-water-mark.ts`) and the sync REPORT (`sync-status.ts`) — and
 * both are read by a process that may start at any instant, including one
 * interrupted mid-write. A partially written position replays an archive from
 * genesis; a partially written report reads as corrupt. The recipe is the same
 * for both, so it lives here rather than twice.
 *
 * What deliberately stays with each caller is ERROR TRANSLATION: the position
 * store raises a typed `CorpusMirrorError` that fails a sync, the report store
 * warns and carries on. This helper throws whatever the filesystem threw.
 *
 * `mode` on the directory and `wx` plus `0o600` on the temporary are load
 * bearing: the temporary must never adopt an existing file (a symlink an
 * attacker planted at that path included), and neither document is readable by
 * anyone but the owner.
 */
export async function writeFileAtomically(options: {
  readonly fs: CorpusFilesystem;
  readonly filePath: string;
  readonly body: string;
  readonly tempNonce: () => string;
}): Promise<void> {
  const temporaryPath = `${options.filePath}.${options.tempNonce()}.tmp`;
  try {
    await options.fs.mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
    await options.fs.unlink(temporaryPath).catch(() => undefined);
    const handle = await options.fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(options.body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.fs.rename(temporaryPath, options.filePath);
  } catch (error) {
    await options.fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
