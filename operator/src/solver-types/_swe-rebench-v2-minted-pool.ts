/**
 * Minted pool store + IPFS artifacts for task-creator instances.
 *
 * v1 artifacts are immutable historical records. v2 adds an explicit public
 * evaluator-environment binding for public-repository tasks; it deliberately
 * has a separate artifact type, so no previously published CID changes shape.
 * Gold patches remain local-only in both versions.
 */

import { chmod, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { z } from 'zod/v3';
import type { HfRow } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { canonicalJson } from '../util/canonical-json.js';
import type { PoolTask } from './_swe-rebench-v2-pool.js';
import {
  Eip191EnvironmentAttestationV1Schema,
  DigestQualifiedImageV1Schema,
  TrustedParserIdentityV1Schema,
  type Eip191EnvironmentAttestationV1,
  type TrustedParserIdentityV1,
} from '../task-creator/environment/contracts.js';
import {
  EVAL_SEMANTICS_VERSION,
  type ValidatedPoolEntry,
} from './_swe-rebench-v2-validated-pool.js';
import { DifferentialAdmissionPolicyV2 } from './_swe-rebench-v2-differential-admission.js';

const STORE_SCHEMA_VERSION_V1 = 'swe-rebench-v2-minted-pool.v1' as const;
const STORE_SCHEMA_VERSION_V2 = 'swe-rebench-v2-minted-pool.v2' as const;
export const SWE_REBENCH_V2_MINTED_POOL_ARTIFACT_TYPE = 'swe-rebench-v2-minted-pool.v1' as const;
export const SWE_REBENCH_V2_MINTED_POOL_V2_ARTIFACT_TYPE = 'swe-rebench-v2-minted-pool.v2' as const;
const MINTED_POOL_FILE = 'minted-pool.json';

type RowHashVersion = 1 | 2;
type Sha256 = `sha256:${string}`;

export interface MintedProvenance {
  synthetic: true;
  mintFamily: string;
  sourceLineageHash: string;
  sourceInstanceId?: string;
  minterSafe?: string;
  blindedUntil?: string;
  /** Recording operator's Safe (session-echo, Task 8) — feeds
   *  `syntheticClaimBlocked` (`_swe-rebench-v2-synthetic-claim.ts`) so the
   *  operator whose session produced the echo cannot claim it. */
  sourceSolverSafe?: string;
}

/** Published v1 row — no gold `patch` field. */
export interface MintedPoolRow extends Omit<HfRow, never> {
  instance_id: string;
  repo: string;
  problem_statement?: string;
  base_commit?: string;
  language?: string;
}

/**
 * Public references required to grade a v2 row. The signed environment spec
 * itself is fetched by CID at verdict time; the duplicated fields make the
 * artifact self-describing and are all covered by the public row hash.
 */
export interface MintedEnvironmentBindingV1 {
  environmentSpecCid: string;
  environmentHash: Sha256;
  attestation: Eip191EnvironmentAttestationV1;
  parser: TrustedParserIdentityV1;
  image: { reference: string; digest: Sha256 };
  platform: 'linux/amd64';
}

/** Immutable public pointer to the repeated causal evidence that hardened a v2 row. */
export interface DifferentialAdmissionReceiptReferenceV2 {
  admissionPolicyVersion: typeof DifferentialAdmissionPolicyV2.admissionPolicyVersion;
  receiptCid: string;
  receiptHash: Sha256;
}

/** Published v2 row — public grading fields + explicit environment binding. */
export interface MintedPoolRowV2 extends MintedPoolRow {
  base_commit: string;
  /** Public fix identity for hardened differential-admission rows. */
  fix_commit?: string;
  language: string;
  rowHashVersion: 2;
  environment: MintedEnvironmentBindingV1;
  /** Present for hardened public-repository rows; older immutable v2 rows remain readable. */
  differentialAdmission?: DifferentialAdmissionReceiptReferenceV2;
  /** Canonical SHA-256 over public grading fields and `environment`. */
  publicRowHash: Sha256;
}

export interface MintedPoolEntry {
  row: MintedPoolRow | MintedPoolRowV2;
  /** Omitted / 1 means the legacy v1 row contract. */
  rowHashVersion?: RowHashVersion;
  provenance: MintedProvenance;
  admission: ValidatedPoolEntry;
  /** Local transport bookkeeping, never included in a v2 public row hash. */
  hf_dataset: string;
  hf_split: string;
  mintedAt: string;
  /**
   * Per-entry publish marker (D2 tier-2). `true` only once the publish path
   * has backfilled this row into a published IPFS artifact
   * ({@link MintedPoolStore.setPublishedArtifact}). `false` for entries the
   * pipeline recorded without publish consent. `undefined` marks a legacy
   * entry written before this field existed — those are treated as published
   * iff the store carries a `publishedArtifactCid` (every pre-marker store
   * used uniform publish batches, so store-wide == per-entry for them).
   */
  published?: boolean;
}

interface MintedPoolFileV1 {
  schemaVersion: typeof STORE_SCHEMA_VERSION_V1;
  evalSemanticsVersion: string;
  updatedAt: string;
  publishedArtifactCid?: string;
  entries: Record<string, MintedPoolEntry>;
}

interface MintedPoolFileV2 {
  schemaVersion: typeof STORE_SCHEMA_VERSION_V2;
  evalSemanticsVersion: string;
  updatedAt: string;
  /** Keep pointers by artifact contract so a v2 publish cannot rewrite v1. */
  publishedArtifactCids: Partial<Record<RowHashVersion, string>>;
  entries: Record<string, MintedPoolEntry>;
}

type MintedPoolFile = MintedPoolFileV1 | MintedPoolFileV2;

export interface SweRebenchV2MintedPoolArtifactV1 {
  schemaVersion: typeof SWE_REBENCH_V2_MINTED_POOL_ARTIFACT_TYPE;
  evalSemanticsVersion: string;
  generatedAt: string;
  rows: MintedPoolRow[];
}

export interface SweRebenchV2MintedPoolArtifactV2 {
  schemaVersion: typeof SWE_REBENCH_V2_MINTED_POOL_V2_ARTIFACT_TYPE;
  evalSemanticsVersion: string;
  generatedAt: string;
  rows: MintedPoolRowV2[];
}

/** Compatibility alias for consumers which can route either immutable type. */
export type SweRebenchV2MintedPoolArtifact =
  | SweRebenchV2MintedPoolArtifactV1
  | SweRebenchV2MintedPoolArtifactV2;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const NonEmptyString = z.string().min(1);
const HfInstallConfigSchema = z.object({
  install: z.union([z.string(), z.array(z.string())]).optional(),
  test_cmd: z.union([z.string(), z.array(z.string())]),
  log_parser: NonEmptyString,
}).strict();

const MintedEnvironmentBindingV1Schema = z.object({
  environmentSpecCid: NonEmptyString,
  environmentHash: z.string().regex(SHA256_RE),
  attestation: Eip191EnvironmentAttestationV1Schema,
  parser: TrustedParserIdentityV1Schema,
  image: DigestQualifiedImageV1Schema,
  platform: z.literal('linux/amd64'),
}).strict().superRefine((binding, ctx) => {
  if (binding.attestation.environmentHash !== binding.environmentHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attestation', 'environmentHash'],
      message: 'attestation.environmentHash must match environmentHash',
    });
  }
});

/** Parse an operator-supplied explicit evaluator binding before minting. */
export function parseMintedEnvironmentBindingV1(raw: unknown): MintedEnvironmentBindingV1 {
  return MintedEnvironmentBindingV1Schema.parse(raw) as MintedEnvironmentBindingV1;
}

const DifferentialAdmissionReceiptReferenceV2Schema = z.object({
  admissionPolicyVersion: z.literal(DifferentialAdmissionPolicyV2.admissionPolicyVersion),
  receiptCid: NonEmptyString,
  receiptHash: z.string().regex(SHA256_RE),
}).strict();

const MintedPoolRowV2SchemaBase = z.object({
  instance_id: NonEmptyString,
  repo: NonEmptyString,
  problem_statement: z.string().optional(),
  base_commit: CommitSchema,
  fix_commit: CommitSchema.optional(),
  language: NonEmptyString,
  image_name: NonEmptyString,
  FAIL_TO_PASS: z.array(NonEmptyString),
  PASS_TO_PASS: z.array(NonEmptyString),
  test_patch: z.string(),
  install_config: HfInstallConfigSchema,
  rowHashVersion: z.literal(2),
  environment: MintedEnvironmentBindingV1Schema,
  differentialAdmission: DifferentialAdmissionReceiptReferenceV2Schema.optional(),
  publicRowHash: z.string().regex(SHA256_RE),
}).strict();

const MintedPoolRowV2Schema = MintedPoolRowV2SchemaBase.superRefine((row, ctx) => {
  if (row.differentialAdmission && !row.fix_commit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fix_commit'],
      message: 'hardened differential rows require a public fix_commit',
    });
  }
  if (row.image_name !== row.environment.image.reference) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['image_name'],
      message: 'image_name must match environment.image.reference',
    });
  }
  if (row.install_config.log_parser !== row.environment.parser.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['install_config', 'log_parser'],
      message: 'install_config.log_parser must match environment.parser.id',
    });
  }
  const expected = computeMintedPoolRowV2Hash(row as MintedPoolRowV2);
  if (row.publicRowHash !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicRowHash'],
      message: 'publicRowHash must match canonical public v2 row fields',
    });
  }
});

const MintedPoolArtifactV2Schema = z.object({
  schemaVersion: z.literal(SWE_REBENCH_V2_MINTED_POOL_V2_ARTIFACT_TYPE),
  evalSemanticsVersion: NonEmptyString,
  generatedAt: NonEmptyString,
  rows: z.array(MintedPoolRowV2Schema),
}).strict();

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tmp, file);
    if (process.platform !== 'win32') await chmod(file, 0o600);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * The row hash is intentionally a projection, rather than `hash(row)`: local
 * gold material and transport details (`hf_dataset`, `hf_split`, publish time)
 * are excluded even when a caller happens to carry them alongside the row.
 */
export function mintedPoolRowV2HashPayload(row: Omit<MintedPoolRowV2, 'publicRowHash'> | MintedPoolRowV2): object {
  return {
    instance_id: row.instance_id,
    repo: row.repo,
    ...(row.problem_statement !== undefined ? { problem_statement: row.problem_statement } : {}),
    base_commit: row.base_commit,
    ...(row.fix_commit !== undefined ? { fix_commit: row.fix_commit } : {}),
    language: row.language,
    image_name: row.image_name,
    FAIL_TO_PASS: row.FAIL_TO_PASS,
    PASS_TO_PASS: row.PASS_TO_PASS,
    test_patch: row.test_patch,
    install_config: row.install_config,
    rowHashVersion: 2,
    environment: row.environment,
    ...(row.differentialAdmission ? { differentialAdmission: row.differentialAdmission } : {}),
  };
}

export function computeMintedPoolRowV2Hash(row: Omit<MintedPoolRowV2, 'publicRowHash'> | MintedPoolRowV2): Sha256 {
  const digest = createHash('sha256').update(canonicalJson(mintedPoolRowV2HashPayload(row))).digest('hex');
  return `sha256:${digest}`;
}

export function isMintedPoolRowV2(row: MintedPoolRow | MintedPoolRowV2): row is MintedPoolRowV2 {
  return (row as Partial<MintedPoolRowV2>).rowHashVersion === 2;
}

export function hashMintedPoolArtifact(artifact: SweRebenchV2MintedPoolArtifact): Sha256 {
  const digest = createHash('sha256').update(canonicalJson(artifact)).digest('hex');
  return `sha256:${digest}`;
}

function entryRowHashVersion(entry: MintedPoolEntry): RowHashVersion {
  return entry.rowHashVersion === 2 || isMintedPoolRowV2(entry.row) ? 2 : 1;
}

/**
 * Shared export predicate for {@link MintedPoolStore.exportArtifact} and
 * {@link MintedPoolStore.exportArtifactV2}: an entry is exportable when it is a
 * scorable, non-discrimination-failing admission that also clears the tier-2
 * publish gate (D2) — `published !== false`, or named in `includeIds` (the
 * publish path passes rows it is publishing *right now*, before
 * `setPublishedArtifact` has stamped their marker). Both exporters must keep
 * this consent gate in lockstep, so it lives in one place.
 */
function isExportableEntry(entry: MintedPoolEntry, includeIds: Set<string>): boolean {
  return (
    entry.admission.scorable &&
    entry.admission.discrimination !== 'fail' &&
    (entry.published !== false || includeIds.has(entry.row.instance_id))
  );
}

function isV1File(raw: unknown): raw is MintedPoolFileV1 {
  return typeof raw === 'object' && raw !== null &&
    (raw as MintedPoolFileV1).schemaVersion === STORE_SCHEMA_VERSION_V1 &&
    typeof (raw as MintedPoolFileV1).evalSemanticsVersion === 'string' &&
    typeof (raw as MintedPoolFileV1).entries === 'object' && (raw as MintedPoolFileV1).entries !== null;
}

function isV2File(raw: unknown): raw is MintedPoolFileV2 {
  return typeof raw === 'object' && raw !== null &&
    (raw as MintedPoolFileV2).schemaVersion === STORE_SCHEMA_VERSION_V2 &&
    typeof (raw as MintedPoolFileV2).evalSemanticsVersion === 'string' &&
    typeof (raw as MintedPoolFileV2).entries === 'object' && (raw as MintedPoolFileV2).entries !== null &&
    typeof (raw as MintedPoolFileV2).publishedArtifactCids === 'object' && (raw as MintedPoolFileV2).publishedArtifactCids !== null;
}

export class MintedPoolStore {
  private readonly file: string;
  private cache: MintedPoolFileV2 | null = null;

  constructor(opts: { stateDir: string }) {
    this.file = resolvePath(join(opts.stateDir, MINTED_POOL_FILE));
  }

  private fresh(evalSemanticsVersion: string): MintedPoolFileV2 {
    return {
      schemaVersion: STORE_SCHEMA_VERSION_V2,
      evalSemanticsVersion,
      updatedAt: new Date().toISOString(),
      publishedArtifactCids: {},
      entries: {},
    };
  }

  /** In-memory migration retains the v1 CID under an explicit version key. */
  private migrateV1(file: MintedPoolFileV1): MintedPoolFileV2 {
    return {
      schemaVersion: STORE_SCHEMA_VERSION_V2,
      evalSemanticsVersion: file.evalSemanticsVersion,
      updatedAt: file.updatedAt,
      publishedArtifactCids: file.publishedArtifactCid ? { 1: file.publishedArtifactCid } : {},
      entries: file.entries,
    };
  }

  private async load(evalSemanticsVersion: string): Promise<MintedPoolFileV2> {
    if (this.cache && this.cache.evalSemanticsVersion === evalSemanticsVersion) return this.cache;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (isV2File(raw) && raw.evalSemanticsVersion === evalSemanticsVersion) {
        this.cache = raw;
        return raw;
      }
      if (isV1File(raw) && raw.evalSemanticsVersion === evalSemanticsVersion) {
        this.cache = this.migrateV1(raw);
        return this.cache;
      }
    } catch {
      // missing or malformed local state starts clean; published CIDs remain
      // independently immutable and are parsed on retrieval.
    }
    this.cache = this.fresh(evalSemanticsVersion);
    return this.cache;
  }

  async record(instanceId: string, entry: MintedPoolEntry, evalSemanticsVersion: string): Promise<void> {
    if (entryRowHashVersion(entry) === 2) {
      MintedPoolRowV2Schema.parse(entry.row);
    }
    const file = await this.load(evalSemanticsVersion);
    file.entries[instanceId] = entry;
    file.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.file, file);
    this.cache = file;
  }

  async getPublishedArtifactCid(evalSemanticsVersion: string, rowHashVersion?: RowHashVersion): Promise<string | null> {
    const file = await this.load(evalSemanticsVersion);
    if (rowHashVersion) return file.publishedArtifactCids[rowHashVersion] ?? null;
    return file.publishedArtifactCids[2] ?? file.publishedArtifactCids[1] ?? null;
  }

  /**
   * Back-fill only rows belonging to the published artifact version. A v2
   * publication therefore cannot retarget historical v1 rows or CIDs. After
   * IPFS publish, back-fill resolvable `hf_dataset` refs on the version-scoped
   * entries so posted tasks grade through RoutingTaskRowFetcher, and stamp the
   * per-entry `published` marker (D2 tier-2) — only the backfilled entries
   * become eligible for the postable union ({@link loadMintedPoolTasks}).
   */
  async setPublishedArtifact(
    evalSemanticsVersion: string,
    artifactCid: string,
    instanceIds?: string[],
    opts: { rowHashVersion?: RowHashVersion } = {},
  ): Promise<void> {
    const file = await this.load(evalSemanticsVersion);
    const rowHashVersion = opts.rowHashVersion ?? 1;
    file.publishedArtifactCids[rowHashVersion] = artifactCid;
    const hfDataset = mintedIpfsDatasetCid(artifactCid);
    const targets = instanceIds ? new Set(instanceIds) : new Set(Object.keys(file.entries));
    for (const id of targets) {
      const entry = file.entries[id];
      if (!entry || entryRowHashVersion(entry) !== rowHashVersion) continue;
      entry.hf_dataset = hfDataset;
      entry.published = true;
    }
    file.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.file, file);
    this.cache = file;
  }

  async getEntry(instanceId: string, evalSemanticsVersion: string): Promise<MintedPoolEntry | null> {
    const file = await this.load(evalSemanticsVersion);
    return file.entries[instanceId] ?? null;
  }

  async listEntries(evalSemanticsVersion: string): Promise<MintedPoolEntry[]> {
    const file = await this.load(evalSemanticsVersion);
    return Object.values(file.entries);
  }

  /**
   * Legacy v1 export; immutable historical publication contract. Entries
   * explicitly marked `published: false` are excluded — publishing their row
   * data would defeat the tier-2 consent gate (D2) — unless named in
   * `opts.includeIds` (the publish path passes the candidates it is publishing
   * *right now*, before `setPublishedArtifact` has stamped them). Legacy
   * entries with no marker are included, preserving pre-marker uniform-batch
   * behaviour.
   */
  async exportArtifact(evalSemanticsVersion: string, opts: { generatedAt?: string; includeIds?: string[] } = {}): Promise<SweRebenchV2MintedPoolArtifactV1> {
    const entries = await this.listEntries(evalSemanticsVersion);
    const includeIds = new Set(opts.includeIds ?? []);
    const rows = entries
      .filter((e) => entryRowHashVersion(e) === 1)
      .filter((e) => isExportableEntry(e, includeIds))
      .map((e) => e.row as MintedPoolRow)
      .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
    return {
      schemaVersion: SWE_REBENCH_V2_MINTED_POOL_ARTIFACT_TYPE,
      evalSemanticsVersion,
      generatedAt: opts.generatedAt ?? new Date().toISOString(),
      rows,
    };
  }

  /**
   * New explicit-environment export. It never silently downgrades a v2 row.
   * Applies the same tier-2 publish gate as {@link exportArtifact}: entries
   * marked `published: false` are excluded unless named in `opts.includeIds`.
   */
  async exportArtifactV2(evalSemanticsVersion: string, opts: { generatedAt?: string; includeIds?: string[] } = {}): Promise<SweRebenchV2MintedPoolArtifactV2> {
    const entries = await this.listEntries(evalSemanticsVersion);
    const includeIds = new Set(opts.includeIds ?? []);
    const rows = entries
      .filter((e) => entryRowHashVersion(e) === 2)
      .filter((e) => isExportableEntry(e, includeIds))
      .map((e) => MintedPoolRowV2Schema.parse(e.row) as MintedPoolRowV2)
      .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
    return {
      schemaVersion: SWE_REBENCH_V2_MINTED_POOL_V2_ARTIFACT_TYPE,
      evalSemanticsVersion,
      generatedAt: opts.generatedAt ?? new Date().toISOString(),
      rows,
    };
  }

  /** Gold patches keyed by instance_id — local only, never published. */
  async goldPatches(evalSemanticsVersion: string): Promise<Map<string, string>> {
    const file = await this.load(evalSemanticsVersion);
    const map = new Map<string, string>();
    for (const [id, entry] of Object.entries(file.entries)) {
      const patch = (entry as MintedPoolEntry & { goldPatch?: string }).goldPatch;
      if (typeof patch === 'string') map.set(id, patch);
    }
    return map;
  }
}

export function mintedIpfsDatasetCid(cid: string): string {
  return `ipfs://${cid}`;
}

export function parseMintedIpfsDataset(hfDataset: string): string | null {
  if (!hfDataset.startsWith('ipfs://')) return null;
  return hfDataset.slice('ipfs://'.length);
}

/** Strict v2 parsing; v1 stays structurally readable for immutable legacy CIDs. */
export function parseMintedPoolArtifact(raw: unknown): SweRebenchV2MintedPoolArtifact {
  if (!raw || typeof raw !== 'object') throw new Error('minted pool artifact must be an object');
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion === SWE_REBENCH_V2_MINTED_POOL_V2_ARTIFACT_TYPE) {
    return MintedPoolArtifactV2Schema.parse(raw) as SweRebenchV2MintedPoolArtifactV2;
  }
  if (o.schemaVersion !== SWE_REBENCH_V2_MINTED_POOL_ARTIFACT_TYPE) {
    throw new Error('invalid minted pool artifact schemaVersion');
  }
  if (typeof o.evalSemanticsVersion !== 'string' || typeof o.generatedAt !== 'string' || !Array.isArray(o.rows)) {
    throw new Error('invalid minted pool v1 artifact');
  }
  return raw as SweRebenchV2MintedPoolArtifactV1;
}

export function getDefaultMintedPoolStore(stateDir: string): MintedPoolStore {
  return new MintedPoolStore({ stateDir });
}

/** Pool tasks from admitted minted entries (generator union; quotas untouched).
 *  Only entries actually published (per-entry marker, D2 tier-2) enter the
 *  postable union; legacy entries with no marker fall back to the store-wide
 *  cid check. */
export async function loadMintedPoolTasks(
  store: MintedPoolStore,
  evalSemanticsVersion: string,
  artifactCid?: string,
): Promise<PoolTask[]> {
  const entries = await store.listEntries(evalSemanticsVersion);
  const cids: Record<RowHashVersion, string | null> = {
    1: artifactCid ?? await store.getPublishedArtifactCid(evalSemanticsVersion, 1),
    2: artifactCid ? null : await store.getPublishedArtifactCid(evalSemanticsVersion, 2),
  };
  return entries
    .filter((e) => e.admission.scorable && e.admission.discrimination !== 'fail')
    .flatMap((e) => {
      // Tier-2 publish gate (D2): an entry explicitly marked `published: false`
      // never enters the postable union. A marker-less legacy entry falls back
      // to the version-scoped published-CID check below (pre-marker stores used
      // uniform publish batches, so store-wide cid ≡ per-entry published).
      if (e.published === false) return [];
      const version = entryRowHashVersion(e);
      const cid = cids[version];
      if (!cid) return [];
      const row = e.row;
      return [{
        instance_id: row.instance_id,
        hf_dataset: mintedIpfsDatasetCid(cid),
        hf_split: e.hf_split || 'minted',
        repo: row.repo,
        base_commit: row.base_commit,
        patch: (e as MintedPoolEntry & { goldPatch?: string }).goldPatch ?? '',
        test_patch: row.test_patch,
        language: row.language ?? 'python',
        problem_statement: row.problem_statement,
      }];
    });
}

export { EVAL_SEMANTICS_VERSION };
