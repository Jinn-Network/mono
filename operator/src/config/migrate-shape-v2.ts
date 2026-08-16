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
 *
 * One-swap M1 (umbrella #2461, DR-2026-08-05): the dark native sections
 * (`evaluator`, `identityStores`, `trustRootsPath`,
 * `trustPolicyGenesisDigest`, `finality` — see `config/native-sections.ts`)
 * are deliberately NOT written here, and this file is unchanged by that
 * milestone. There is nothing to derive them from: no legacy key holds a
 * deployment-module digest, a role identity-store path, or a trust-roots
 * catalog, so any value this migration invented would be a guess that reads
 * as operator intent. They are operator-authored, absent until authored, and
 * absent is a valid state. `configShapeVersion` therefore does not move —
 * M1 changes what the loader ACCEPTS, not what the migration WRITES, so an
 * already-v2 file is byte-identical across it (covered by
 * `test/config/native-sections-loader.test.ts`).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keccak256, toBytes } from 'viem';
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
  readonly contract?: { readonly id?: string; readonly version?: string };
  readonly solverType?: string;
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

function workKindFromJoined(manifestCid: string, entry: JoinedEntry): string {
  if (typeof entry.solverType === 'string' && entry.solverType.length > 0) {
    return entry.solverType;
  }
  const contractId = entry.contract?.id;
  const contractVersion = entry.contract?.version;
  if (typeof contractId === 'string' && typeof contractVersion === 'string') {
    return `${contractId}.${contractVersion}`;
  }
  return manifestCid;
}

/**
 * A legacy joined entry may carry no per-net `model` (the daemon fell back to
 * the operator's top-level `claudeModel` at solve time — see
 * `ctx.solverNet?.model ?? this.config.claudeModel` in e.g.
 * `harnesses/impls/claude-mcp-prediction/index.ts`). `ExecutionWiringConfigEntrySchema.model`
 * requires a non-empty string, so the migration must resolve that same
 * fallback at migration time rather than writing `''`.
 */
function parseSolverTypeRef(
  solverType: string | undefined,
  fallbackId: string,
): { id: string; version: string } {
  if (typeof solverType !== 'string') {
    return { id: fallbackId, version: 'v1' };
  }
  const dot = solverType.lastIndexOf('.');
  if (dot <= 0 || dot === solverType.length - 1) {
    return { id: fallbackId, version: 'v1' };
  }
  return { id: solverType.slice(0, dot), version: solverType.slice(dot + 1) };
}

function joinedFromLegacySolverNets(raw: Record<string, unknown>): Record<string, JoinedEntry> {
  const legacy = raw['solverNets'];
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return {};
  const joined: Record<string, JoinedEntry> = {};
  for (const [name, entryRaw] of Object.entries(legacy as Record<string, unknown>)) {
    if (!entryRaw || typeof entryRaw !== 'object') continue;
    const entry = entryRaw as {
      solverType?: string;
      roles?: readonly string[];
      harness?: string;
      model?: string;
      plugins?: readonly string[];
    };
    const contract = parseSolverTypeRef(entry.solverType, name);
    const rolesIn = Array.isArray(entry.roles) && entry.roles.length > 0 ? entry.roles : ['solving'];
    const roles: Array<'solver' | 'evaluator'> = [];
    for (const role of rolesIn) {
      if (role === 'solving') roles.push('solver');
      else if (role === 'evaluating') roles.push('evaluator');
    }
    if (roles.length === 0) roles.push('solver');
    joined[`legacy:${name}`] = {
      manifestCid: `legacy:${name}`,
      roles,
      ...(typeof entry.harness === 'string' ? { harness: entry.harness } : {}),
      ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
      plugins: Array.isArray(entry.plugins) ? [...entry.plugins] : [],
      contract,
      solverType: entry.solverType,
    };
  }
  return joined;
}

function joinedFromRaw(raw: Record<string, unknown>): Record<string, JoinedEntry> {
  const joined = (raw['joinedSolverNets'] ?? {}) as Record<string, JoinedEntry>;
  if (Object.keys(joined).length > 0) return joined;
  return joinedFromLegacySolverNets(raw);
}

export function wiringFromJoined(
  joined: Record<string, JoinedEntry>,
  operatorClaudeModel: string | undefined,
): ExecutionWiringConfigEntry[] {
  return Object.entries(joined)
    .filter(([, entry]) => (entry.roles ?? []).includes('solver'))
    .map(([manifestCid, entry]) => ({
      workKind: workKindFromJoined(manifestCid, entry),
      harness: entry.harness ?? 'claude-code',
      model: entry.model ?? operatorClaudeModel ?? DEFAULT_MODEL_FALLBACK,
      plugins: [...(entry.plugins ?? [])],
      credentialRef: `${entry.harness ?? 'claude-code'}-default`,
      isolationPolicy: 'process',
      // Must be the on-chain digest hex, not the CID string — cards carry
      // `keccak256(toBytes(manifestCid))` from TaskCreated.
      legacyManifestDigest: keccak256(toBytes(manifestCid)),
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

  const joined = joinedFromRaw(raw);
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
  const rest = { ...raw };
  delete rest['solverNets'];
  delete rest['joinedSolverNets'];
  writeConfigFileAtomic(options.configPath, {
    ...rest,
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
