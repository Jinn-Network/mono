/**
 * Local launched + draft persistence store for SolverNets.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §6.1, §6.2.
 *
 * Layout (under the user's `~/.jinn-client/`):
 *   solvernets/
 *     launched/<solverNetId>.json   → LaunchedSolverNetRecord
 *     drafts/<draftId>.json         → DraftSolverNetRecord
 *
 * Mirrors the precedent set by `operator/src/earning/store.ts` (atomic
 * tmp-then-rename writes; corrupted files logged and skipped, never
 * thrown). The store accepts a `baseDir` override so tests never touch
 * the real `~/.jinn-client/` tree.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import path from 'path';
import { z } from 'zod/v3';
import {
  SolverNetManifestV1Schema,
  type SolverNetManifestV1,
} from '@jinn-network/sdk/solvernets';
import { resolveDefaultStateDir } from '../state-dir.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const HexString = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/u, 'must be a 0x-prefixed hex string') as unknown as z.ZodType<`0x${string}`>;

const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u, 'must be a 0x-prefixed 20-byte hex address') as unknown as z.ZodType<`0x${string}`>;

const TimestampedError = z.object({
  message: z.string(),
  at: z.string(),
});

const LaunchProgressSchema = z.object({
  phase: z.enum(['pinning', 'recording', 'broadcasting', 'confirming', 'spawning']),
  txHash: HexString.optional(),
  txError: TimestampedError.optional(),
  attemptCount: z.number().int().nonnegative(),
});

const LifecycleProgressSchema = z.object({
  phase: z.enum(['broadcasting', 'confirming']),
  target: z.enum(['paused', 'launched', 'retired']),
  txHash: HexString.optional(),
  txError: TimestampedError.optional(),
  attemptCount: z.number().int().nonnegative(),
});

const GeneratorStateSchema = z.object({
  lastPollAt: z.string().optional(),
  lastPollSummary: z.record(z.string(), z.unknown()).optional(),
  lastError: TimestampedError.optional(),
});

const RegistrySchema = z.object({
  metadataTxHash: HexString.optional(),
  metadataBlockNumber: z.number().int().nonnegative().optional(),
});

/**
 * Identifier characters safe for use as on-disk filenames across POSIX and
 * Windows. Rejects path separators (`/`, `\`), path-traversal segments
 * (`..`), control chars, and shell metacharacters. Alphanumeric + dash +
 * underscore + dot are allowed.
 *
 * Without this guard, an id like `'launcher-1/prediction-001'` creates
 * subdirectories that `listJsonFiles` cannot recurse into — records vanish
 * from `loadOwnedRecords` after daemon restart even though their files
 * exist on disk (jinn-mono-qwdc.34).
 */
const SafeIdChar = /^[A-Za-z0-9._-]+$/u;
const SafeId = z
  .string()
  .min(1)
  .regex(SafeIdChar, {
    message:
      'must contain only alphanumeric, dash, underscore, or dot (no path separators or shell metachars)',
  })
  .refine((s) => s !== '.' && s !== '..', {
    message: 'must not be "." or ".."',
  });

/**
 * Local persistent record for a SolverNet the launcher daemon owns. Mirrors
 * the spec §6.2 shape exactly.
 *
 * `generatorConfig` is the per-record hot-applyable runtime config the
 * launcher edits via `PATCH /v1/solvernets/launched/:id/generator-config`
 * (Task 14). Stored as an opaque blob — the precise shape lives with the
 * solver-type's runtime-config interface (e.g.
 * `PredictionV1GeneratorRuntimeConfig`). The endpoint validates against
 * that interface before persisting; the store treats it as JSON.
 */
export const LaunchedSolverNetRecordSchema = z.object({
  schemaVersion: z.literal('solvernet.launched.v1'),
  solverNetId: SafeId,
  manifestCid: z.string().min(1),
  manifestPath: z.string().optional(),
  manifestHash: HexString,

  launcherAgentId: z.string().min(1),
  launcherSafeAddress: Address,
  launchedAt: z.string(),

  status: z.enum(['launching', 'launched', 'paused', 'retired', 'failed']),
  statusUpdatedAt: z.string(),

  generatorEnabled: z.boolean(),
  generatorState: GeneratorStateSchema.optional(),
  generatorConfig: z.record(z.string(), z.unknown()).optional(),

  launchProgress: LaunchProgressSchema.optional(),
  lifecycleProgress: LifecycleProgressSchema.optional(),

  registry: RegistrySchema,
});

export type LaunchedSolverNetRecord = z.infer<typeof LaunchedSolverNetRecordSchema>;

/**
 * Local persistent record for a Create-flow draft. Most fields are optional
 * because drafts are partial-by-construction — `completedSteps` tracks which
 * sections of the wizard have been filled in and is the source of truth for
 * resumability.
 */
export const DraftSolverNetRecordSchema = z.object({
  schemaVersion: z.literal('solvernet.draft.v1'),
  draftId: SafeId,

  templateContractId: z.string().optional(),
  templateContractVersion: z.string().optional(),

  name: z.string().optional(),
  description: z.string().optional(),

  // Generator config is opaque here — its precise shape lives with each
  // template (e.g. prediction-v1-auto). The store only persists/loads the
  // blob; validation against a specific template happens at form-submit time.
  generatorConfig: z.record(z.string(), z.unknown()).optional(),

  solutionPriceWei: z.string().optional(),
  verdictPriceWei: z.string().optional(),

  openRoles: z.array(z.enum(['solver', 'evaluator'])).optional(),

  completedSteps: z.array(
    z.enum(['define', 'reviewContract', 'configureGenerator', 'configurePricing']),
  ),

  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DraftSolverNetRecord = z.infer<typeof DraftSolverNetRecordSchema>;

// ── Path constants ─────────────────────────────────────────────────────────

export const DEFAULT_JINN_CLIENT_DIR = resolveDefaultStateDir();
const SOLVERNETS_SUBDIR = 'solvernets';
const LAUNCHED_SUBDIR = 'launched';
const DRAFTS_SUBDIR = 'drafts';
const MANIFESTS_SUBDIR = 'manifests';

function resolveLaunchedDir(baseDir: string): string {
  return path.join(baseDir, SOLVERNETS_SUBDIR, LAUNCHED_SUBDIR);
}

function resolveDraftsDir(baseDir: string): string {
  return path.join(baseDir, SOLVERNETS_SUBDIR, DRAFTS_SUBDIR);
}

function resolveManifestsDir(baseDir: string): string {
  return path.join(baseDir, SOLVERNETS_SUBDIR, MANIFESTS_SUBDIR);
}

// ── Atomic write helper ────────────────────────────────────────────────────

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the tmp file if rename failed.
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

// ── Generic load helpers ───────────────────────────────────────────────────

/**
 * List `.json` files in a directory. Returns [] when the directory does
 * not yet exist (the daemon lazy-creates). Uses try/catch on `readdir`
 * rather than a pre-`existsSync` check to avoid a TOCTOU race where the
 * directory disappears between the check and the read.
 *
 * Tmp files produced by `writeJsonAtomic` are named
 * `<name>.json.tmp-<pid>-<ts>-<rand>` and are excluded by the
 * `.endsWith('.json')` check — no separate `.tmp` filter needed.
 *
 * Dot-prefixed names are also excluded: AppleDouble `._*.json` companion
 * files land in the dir when operator state is seeded from a macOS-produced
 * tarball, and an `._*` sidecar carrying valid-looking JSON would otherwise
 * be listed and mis-validated (or spam an error log per load).
 */
async function listJsonFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter(name => name.endsWith('.json') && !name.startsWith('.'));
}

async function readAndParse<T>(
  filePath: string,
  schema: z.ZodType<T>,
  context: string,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    console.error(`[solvernet-store] Failed to read ${context} at ${filePath}:`, err);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[solvernet-store] Invalid JSON at ${filePath}; skipping:`, err);
    return null;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    console.error(
      `[solvernet-store] Schema validation failed at ${filePath}; skipping:`,
      result.error.issues,
    );
    return null;
  }
  return result.data;
}

async function loadAllValid<T>(
  dir: string,
  schema: z.ZodType<T>,
  context: string,
): Promise<T[]> {
  const files = await listJsonFiles(dir);
  const out: T[] = [];
  for (const name of files) {
    const record = await readAndParse(path.join(dir, name), schema, context);
    if (record) out.push(record);
  }
  return out;
}

async function deleteIfExists(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;
  await rm(filePath, { force: true });
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface SolverNetStore {
  // Launched records
  loadOwnedRecords(): Promise<LaunchedSolverNetRecord[]>;
  loadRecord(solverNetId: string): Promise<LaunchedSolverNetRecord | null>;
  writeRecord(record: LaunchedSolverNetRecord): Promise<void>;
  deleteRecord(solverNetId: string): Promise<void>;
  writeManifestCache(
    manifestCid: string,
    manifest: SolverNetManifestV1,
  ): Promise<string>;
  loadManifestCache(manifestPath: string): Promise<SolverNetManifestV1 | null>;

  // Drafts
  loadDraft(draftId: string): Promise<DraftSolverNetRecord | null>;
  writeDraft(record: DraftSolverNetRecord): Promise<void>;
  listDrafts(): Promise<DraftSolverNetRecord[]>;
  deleteDraft(draftId: string): Promise<void>;
}

export interface SolverNetStoreOptions {
  /**
   * Override the root directory under which `solvernets/launched/` and
   * `solvernets/drafts/` live. Defaults to `~/.jinn-client`. Tests should
   * always supply a tmpdir here to avoid touching the real home directory.
   */
  baseDir?: string;
}

export function createSolverNetStore(opts: SolverNetStoreOptions = {}): SolverNetStore {
  const baseDir = opts.baseDir ?? resolveDefaultStateDir();
  const launchedDir = resolveLaunchedDir(baseDir);
  const draftsDir = resolveDraftsDir(baseDir);
  const manifestsDir = resolveManifestsDir(baseDir);

  function assertSafeId(id: string, kind: 'solverNetId' | 'draftId' | 'manifestCid'): void {
    const result = SafeId.safeParse(id);
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? 'invalid id';
      throw new Error(`Invalid ${kind} ${JSON.stringify(id)}: ${message}`);
    }
  }
  function launchedPath(solverNetId: string): string {
    assertSafeId(solverNetId, 'solverNetId');
    return path.join(launchedDir, `${solverNetId}.json`);
  }
  function draftPath(draftId: string): string {
    assertSafeId(draftId, 'draftId');
    return path.join(draftsDir, `${draftId}.json`);
  }
  function manifestCachePath(manifestCid: string): string {
    assertSafeId(manifestCid, 'manifestCid');
    return path.join(manifestsDir, `${manifestCid}.json`);
  }

  return {
    async loadOwnedRecords() {
      return loadAllValid(launchedDir, LaunchedSolverNetRecordSchema, 'launched record');
    },

    async loadRecord(solverNetId) {
      return readAndParse(launchedPath(solverNetId), LaunchedSolverNetRecordSchema, 'launched record');
    },

    async writeRecord(record) {
      const validated = LaunchedSolverNetRecordSchema.parse(record);
      await writeJsonAtomic(launchedPath(validated.solverNetId), validated);
    },

    async deleteRecord(solverNetId) {
      await deleteIfExists(launchedPath(solverNetId));
    },

    async writeManifestCache(manifestCid, manifest) {
      const validated = SolverNetManifestV1Schema.parse(manifest);
      const filePath = manifestCachePath(manifestCid);
      await writeJsonAtomic(filePath, validated);
      return filePath;
    },

    async loadManifestCache(manifestPath) {
      const resolved = path.resolve(manifestPath);
      const allowedRoot = path.resolve(manifestsDir);
      if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) {
        console.error(
          `[solvernet-store] Refusing to read manifest cache outside ${allowedRoot}: ${manifestPath}`,
        );
        return null;
      }
      return readAndParse(
        resolved,
        SolverNetManifestV1Schema,
        'solvernet manifest cache',
      );
    },

    async loadDraft(draftId) {
      return readAndParse(draftPath(draftId), DraftSolverNetRecordSchema, 'draft record');
    },

    async writeDraft(record) {
      const validated = DraftSolverNetRecordSchema.parse(record);
      await writeJsonAtomic(draftPath(validated.draftId), validated);
    },

    async listDrafts() {
      return loadAllValid(draftsDir, DraftSolverNetRecordSchema, 'draft record');
    },

    async deleteDraft(draftId) {
      await deleteIfExists(draftPath(draftId));
    },
  };
}
