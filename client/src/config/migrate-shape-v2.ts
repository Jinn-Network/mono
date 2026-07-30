/**
 * Boot-time config shape-v2 auto-migration. Additive, atomic, idempotent
 * (stage-1 contract 4): new keys (`claimPolicy`, `executionWiring`,
 * `posting`) are written beside `joinedSolverNets`; legacy keys survive
 * until stage 5; the write is temp-file + rename; re-running is a no-op via
 * `configShapeVersion`.
 *
 * See `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md`
 * Task 3.
 *
 * Amendment (coordinator amendment 1, binding on this file): spec §9's
 * "behavior-identical on day one" is the binding sentence — CLAIM_NOTHING is
 * the posture for an *unconfigured* predicate, not for the migration of a
 * configured operator. The migration writes NO `spendCapWei`/`aiUnitCap`
 * fields at all; the host's USD rolling-window gates (kept per spec §6.5)
 * remain the operative spend bound, exactly today's behavior. Caps are set
 * later, explicitly, on the Claim policy & wiring page (Task 17).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backupConfigFile, writeConfigFileAtomic } from './atomic-write.js';
import {
  CONFIG_SHAPE_VERSION,
  type ExecutionWiringConfigEntry,
  type PostingConfigEntry,
} from './shape-v2.js';

export interface ConfigMigrationReport {
  readonly migrated: boolean;
  readonly wiringEntries: number;
  readonly postingEntries: number;
  readonly backupPath?: string;
}

export interface MigrateConfigOptions {
  readonly configPath: string;
  /** Directory holding launched SolverNet records; default `<configDir>/solvernets/launched`. */
  readonly launchedRecordsDir?: string;
  readonly now?: () => Date;
}

interface JoinedEntry {
  readonly manifestCid: string;
  readonly roles?: readonly string[];
  readonly harness?: string;
  readonly model?: string;
  readonly plugins?: readonly string[];
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_MODEL_FALLBACK = 'claude-haiku-4-5-20251001';

/**
 * A legacy joined entry may carry no per-net `model` (the daemon fell back to
 * the operator's top-level `claudeModel` at solve time — see
 * `ctx.solverNet?.model ?? this.config.claudeModel` in e.g.
 * `harnesses/impls/claude-mcp-prediction/index.ts`). `ExecutionWiringConfigEntrySchema.model`
 * requires a non-empty string, so the migration must resolve that same
 * fallback at migration time rather than writing `''`.
 */
function wiringFromJoined(
  joined: Record<string, JoinedEntry>,
  operatorClaudeModel: string | undefined,
): ExecutionWiringConfigEntry[] {
  return Object.entries(joined)
    .filter(([, entry]) => (entry.roles ?? []).includes('solver'))
    .map(([manifestCid, entry]) => ({
      workKind: manifestCid,
      harness: entry.harness ?? 'claude-code',
      model: entry.model ?? operatorClaudeModel ?? DEFAULT_MODEL_FALLBACK,
      plugins: [...(entry.plugins ?? [])],
      credentialRef: `${entry.harness ?? 'claude-code'}-default`,
      isolationPolicy: 'process',
      legacyManifestDigest: manifestCid,
    }));
}

function postingFromLaunched(directory: string): PostingConfigEntry[] {
  if (!existsSync(directory)) return [];
  const entries: PostingConfigEntry[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    const record = readJson(path);
    if (record === undefined || record['status'] !== 'launched') continue;
    const manifestCid = String(record['manifestCid'] ?? name.replace(/\.json$/u, ''));
    entries.push({
      workKind: manifestCid,
      launchedRecordPath: path,
      generatorEnabled: record['generatorEnabled'] === true,
      legacyManifestDigest: manifestCid,
    });
  }
  return entries;
}

export function migrateConfigShapeV2(options: MigrateConfigOptions): ConfigMigrationReport {
  const raw = readJson(options.configPath);
  if (raw === undefined) {
    return { migrated: false, wiringEntries: 0, postingEntries: 0 };
  }
  if (raw['configShapeVersion'] === CONFIG_SHAPE_VERSION) {
    const wiring = Array.isArray(raw['executionWiring']) ? raw['executionWiring'].length : 0;
    const posting = Array.isArray(raw['posting']) ? raw['posting'].length : 0;
    return { migrated: false, wiringEntries: wiring, postingEntries: posting };
  }

  const joined = (raw['joinedSolverNets'] ?? {}) as Record<string, JoinedEntry>;
  const launchedDir =
    options.launchedRecordsDir ?? join(dirname(options.configPath), 'solvernets', 'launched');
  const operatorClaudeModel =
    typeof raw['claudeModel'] === 'string' ? (raw['claudeModel'] as string) : undefined;
  const executionWiring = wiringFromJoined(joined, operatorClaudeModel);
  const posting = postingFromLaunched(launchedDir);

  // Amendment (coordinator amendment 1): no spendCapWei/aiUnitCap fields are
  // written. A configured operator's existing joinedSolverNets predicate is
  // what today's claim behavior already runs on; the host's USD
  // rolling-window gates stay the operative spend bound until the operator
  // sets explicit per-claim caps.
  const claimPolicy = {
    mode: 'match-legacy-manifest-digest' as const,
  };

  const backupPath = backupConfigFile(options.configPath, options.now);
  writeConfigFileAtomic(options.configPath, {
    ...raw,
    configShapeVersion: CONFIG_SHAPE_VERSION,
    claimPolicy,
    executionWiring,
    posting,
  });

  return {
    migrated: true,
    wiringEntries: executionWiring.length,
    postingEntries: posting.length,
    ...(backupPath === undefined ? {} : { backupPath }),
  };
}
