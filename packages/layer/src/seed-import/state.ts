/**
 * Seed-import idempotency state (issue #1771, folding the idempotency AC
 * originally scoped to #1772/R2 — R4 has no dependency on R1 so it ships
 * here; see the #1771 PR body for the rationale).
 *
 * Both seed lanes (skill seeds in `execute.ts`, evidence-episode seeds in
 * `episode-execute.ts`) publish through this shared store: a small
 * identity -> {contentHash, envelopeRef} map that each `execute*()` consults
 * before publishing. Re-running an import over unchanged content is a no-op
 * (a `skipped` row; no new envelope); re-running over CHANGED content
 * republishes and points the new record's provenance at the prior
 * `envelopeRef` via `supersedes` — skills carry it in
 * `SkillArtifactV1.provenance.supersedes` (operator/src/types/skill-artifact.ts,
 * already schema'd for this, issue #1462); episodes carry it in the
 * `seed.attribution` step attribute (episode-fetch.ts's step convention),
 * since the frozen `jinn.trace-envelope.v0` has no top-level field for it.
 *
 * File-backed by default (`~/.jinn-client/harness-layer/seed-import-state.json`,
 * mirroring `ledger.ts`'s convention) so real CLI runs persist across
 * invocations; tests inject `createMemorySeedImportState()`.
 *
 * Deliberately NOT a corpus query: idempotency here answers "did *I* already
 * publish this exact seed identity, unchanged?" — a question the operator's
 * own local state answers without a network round trip. It does not detect a
 * differently-identified duplicate already sitting in the shared corpus
 * (two seeds, two identities, same content) — that is the consumer-side
 * content-key dedup (rescope plan §3.3) and the testnet hygiene sweep
 * (#1776), not a publish-time concern.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '@jinn-network/core';
import { sha256Hex } from '../execution-publish.js';

export const DEFAULT_SEED_IMPORT_STATE_PATH = join(
  homedir(),
  '.jinn-client',
  'harness-layer',
  'seed-import-state.json',
);

export const SeedPublicationRecordSchema = z.strictObject({
  /** sha256 over the canonical JSON of the seed's meaningful content. */
  contentHash: z.string().min(1),
  /** The published wrapper envelope CID (the corpus ref) — the corpus's own identity for the record. */
  envelopeRef: z.string().min(1),
  publishedAt: z.iso.datetime(),
});
export type SeedPublicationRecord = z.infer<typeof SeedPublicationRecordSchema>;

const SeedImportStateFileSchema = z.record(z.string(), SeedPublicationRecordSchema);

export interface SeedImportStateStore {
  /** The prior publication of this identity, or undefined if never published. */
  get(identity: string): SeedPublicationRecord | undefined;
  /** Record identity's latest publication (overwrites any prior entry). */
  set(identity: string, record: SeedPublicationRecord): void;
}

/** In-memory store — tests, and any embedder that does not want on-disk state. */
export function createMemorySeedImportState(
  initial: Record<string, SeedPublicationRecord> = {},
): SeedImportStateStore {
  const state = new Map(Object.entries(initial));
  return {
    get: (identity) => state.get(identity),
    set: (identity, record) => {
      state.set(identity, SeedPublicationRecordSchema.parse(record));
    },
  };
}

export interface FileSeedImportStateOptions {
  /**
   * Optional sink for the fail-closed corrupt-state warning. The read still
   * throws; this hook only lets a CLI surface the same diagnostic separately.
   */
  onWarning?: (message: string) => void;
}

/**
 * File-backed store (JSON map, `~/.jinn-client/harness-layer/seed-import-state.json`
 * by default) — read-modify-write on every `set()`. Fine at seed-import's
 * scale (dozens to low hundreds of curated, human-approved entries via the
 * plan/execute gate), not a database.
 *
 * A corrupt/foreign state file is FAIL-CLOSED: reads and writes throw rather
 * than treating it as empty and destroying supersedes lineage. Persistence
 * writes a complete same-directory temp file and atomically renames it over
 * the destination, so interruption cannot leave a partial JSON document.
 */
export function createFileSeedImportState(
  path: string = DEFAULT_SEED_IMPORT_STATE_PATH,
  opts: FileSeedImportStateOptions = {},
): SeedImportStateStore {
  const warn = opts.onWarning;
  let warned = false;
  const read = (): Record<string, SeedPublicationRecord> => {
    if (!existsSync(path)) return {};
    try {
      return SeedImportStateFileSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
    } catch (cause) {
      const message = `[harness-layer] seed-import state at ${path} is unreadable; refusing to continue so publication lineage is preserved`;
      if (!warned) {
        warned = true;
        warn?.(message);
      }
      throw new Error(message, { cause });
    }
  };
  return {
    get(identity) {
      return read()[identity];
    },
    set(identity, record) {
      const all = read();
      all[identity] = SeedPublicationRecordSchema.parse(record);
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true });
      const tempPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      try {
        writeFileSync(tempPath, JSON.stringify(all, null, 2) + '\n', 'utf-8');
        renameSync(tempPath, path);
      } catch (cause) {
        try {
          rmSync(tempPath, { force: true });
        } catch {
          // Preserve the persistence failure that triggered cleanup.
        }
        throw cause;
      }
    },
  };
}

/**
 * Deterministic content fingerprint for idempotency: sha256 over the
 * RFC 8785 canonical JSON of the seed's meaningful fields (the caller
 * decides which fields are "meaningful" — e.g. excludes capture-time-only
 * fields like `capturedAt`). Two calls over the same logical content always
 * agree, regardless of key order.
 */
export function hashSeedContent(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
