/**
 * SolverNet creation/launch HTTP routes.
 *
 * Spec: spec/2026-05-05-solvernet-creation-and-launch.md §6.1, §10.
 *
 * Registers under `/v1/solvernets/*`:
 *
 *   Drafts CRUD (Task 13):
 *     POST   /v1/solvernets/drafts              — create a new draft.
 *     GET    /v1/solvernets/drafts              — list owned drafts.
 *     GET    /v1/solvernets/drafts/:id          — load a single draft.
 *     PATCH  /v1/solvernets/drafts/:id          — update fields on a draft.
 *     DELETE /v1/solvernets/drafts/:id          — delete a draft.
 *
 *   Launch (Task 14):
 *     POST   /v1/solvernets/drafts/:id/launch                   — kick off LaunchAction.
 *     GET    /v1/solvernets/launched/:id                        — read current record.
 *     PATCH  /v1/solvernets/launched/:id/generator-config       — hot-apply config.
 *
 *   The `PATCH .../lifecycle` route (pause/resume/retire) retired with Wave-4
 *   D3 together with its transition state machine.
 *
 *   Catalog (Task 15):
 *     GET    /v1/solvernets/launched                            — list owned launched records.
 *     GET    /v1/solvernets/registry                            — list global launched SolverNets (cached).
 *     GET    /v1/solvernets/registry/:cid                       — fetch a manifest from the registry.
 *
 * Auth: route mounting is handled by server.ts (UI-token gate via
 * `requireUiToken`). This module assumes the gate is in place upstream
 * — the same posture as `setup-endpoints.ts` / `launcher-endpoints.ts`.
 *
 * Validation posture: drafts are partial-by-construction. Field-shape
 * validation runs (so we never persist garbage that breaks the loader),
 * but business-rule validation — "price must be set", "openRoles must be
 * non-empty" — runs only at the launch gate (POST /drafts/:id/launch),
 * so an operator can fill out the wizard out-of-order without the API
 * rejecting half-finished drafts.
 *
 * Launch behaviour (Task 14, see also spec §10):
 *
 *   - The endpoint synthesises an `UnsignedSolverNetManifestV1` from the
 *     draft + the configured launcher identity + the contract template
 *     resolved from the SDK's `getSolverNetContract({id, version})`.
 *   - Manifest signing is performed inside `LaunchAction.launch()` via the
 *     pre-signed `signature` stamp; for the API surface we sign right
 *     before invoking the action so the launch starts with a verifiable
 *     manifest.
 *   - The launch is fire-and-forget: we kick off the state machine in the
 *     background and return 202 with a poll URL so the SPA can render
 *     progress without blocking on IPFS pin + tx confirmation. We briefly
 *     wait for the initial record to land on disk (the launch action's
 *     first checkpoint) so the SPA's first poll always finds a record.
 */
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v3';
import {
  getSolverNetContract,
  type SolverNetManifestV1,
} from '@jinn-network/sdk/solvernets';
import {
  DraftSolverNetRecordSchema,
  LaunchedSolverNetRecordSchema,
  type DraftSolverNetRecord,
  type LaunchedSolverNetRecord,
  type SolverNetStore,
} from '../solvernets/store.js';
import {
  manifestHash,
  signManifest,
  type UnsignedSolverNetManifestV1,
} from '../solvernets/manifest.js';
import { LaunchAction } from '../solvernets/launch-state-machine.js';
import type {
  PendingGeneratorSpawn,
  SolverNetCatalogCache,
} from '../solvernets/daemon-init.js';
import {
  resolveLaunchedRecordContract,
  type LaunchedRecordContractRef,
} from '../solvernets/launched-record-contract.js';
import type { LauncherGeneratorStateSnapshot } from './launcher-status.js';
import type {
  SignerWithAgentEoa,
  SolverNetManifestSummary,
  SolverNetRegistryClient,
} from '../solvernets/registry-client.js';

/**
 * Optional Task-14 deps that turn on the launch + generator-config endpoints.
 * The drafts CRUD endpoints (Task 13) only need `store`; when this block is
 * omitted those routes still mount and the launch routes return 503.
 *
 * Wave-4 D3 (Task 18 of the cutover stage-3 plan, DR-2026-08-05 decision 1)
 * removed `lifecycleTransition` along with the `PATCH .../lifecycle` route: the
 * transition producer is retired, and pause/retire is now expressed as
 * `posting[].enabled` plus the work client's close (headless design §4.2).
 */
export interface SolverNetsLaunchDeps {
  launchAction: LaunchAction;
  /**
   * Live generator-state reader, keyed by `solverNetId`. Retained as an
   * optional seam only: Wave-4 D3 retired the launched-record generators, so
   * production never supplies it and responses always fall back to the
   * record's persisted `generatorState`. See #471.
   */
  getGeneratorState?: (solverNetId: string) => LauncherGeneratorStateSnapshot | undefined;
  /** Live mirror of the daemon's per-record refs. The generator-config
   * endpoint mutates `configRef.current` for the matching record so a
   * subsequent read sees the change without a disk reload. Lookups by
   * `solverNetId`. */
  pendingGenerators: { current: PendingGeneratorSpawn[] };
  /** Signer used by `launchAction.launch` (single-launcher daemon). */
  signer: SignerWithAgentEoa;
  /** Network embedded in the synthesised manifest's `network` field. */
  network: 'base-sepolia' | 'base';
  /** Launcher identity embedded in the manifest's `launcher` block. */
  launcher: {
    safeAddress: `0x${string}`;
    agentEoa: `0x${string}`;
    agentId: string;
  };
  /** Override `Date.now()` for deterministic timestamps in tests. */
  now?: () => Date;
}

export interface SolverNetsEndpointsDeps {
  store: SolverNetStore;
  /** Optional Task 14 launch + generator-config wiring. */
  launch?: SolverNetsLaunchDeps;
  /**
   * Optional Task 15 catalog cache (from `daemon-init.ts`). Surfaces the
   * global SolverNet registry to `GET /v1/solvernets/registry`. When omitted
   * the registry list endpoint returns 503; the owned-list endpoint
   * (`/launched`) still works because it reads only from `store`.
   */
  catalog?: SolverNetCatalogCache;
  /**
   * Optional Task 15 registry client. Used by `GET /v1/solvernets/registry/:cid`
   * to resolve a manifest body and its lifecycle status from the global
   * registry. Independently optional from `catalog` so a daemon could expose
   * one but not the other (in practice they ship together).
   */
  registry?: SolverNetRegistryClient;
}

/**
 * Overlay the live generator-state snapshot onto a launched record when a
 * reader is supplied. Wave-4 D3 retired the generators, so production supplies
 * none and the persisted `generatorState` is returned unchanged. See #471.
 */
function withLiveGeneratorState(
  record: LaunchedSolverNetRecord,
  getGeneratorState: SolverNetsLaunchDeps['getGeneratorState'],
): LaunchedSolverNetRecord {
  const live = getGeneratorState?.(record.solverNetId);
  if (!live) return record;
  return { ...record, generatorState: live };
}

// ── Draft CRUD validation schemas ──────────────────────────────────────────

// Zod schema for the editable subset of a draft. Mirrors
// `DraftSolverNetRecordSchema` from the store but drops the
// store-managed fields (`schemaVersion`, `draftId`, `createdAt`,
// `updatedAt`, `completedSteps` is editable by the UI).
//
// All fields are optional — POST with `{}` produces an empty draft, PATCH
// of a single field updates only that field. Wrong types → Zod fails fast,
// the route returns 400 with a structured error.
const DraftEditableSchema = z
  .object({
    templateContractId: z.string().optional(),
    templateContractVersion: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    generatorConfig: z.record(z.string(), z.unknown()).optional(),
    solutionPriceWei: z.string().optional(),
    verdictPriceWei: z.string().optional(),
    openRoles: z.array(z.enum(['solver', 'evaluator'])).optional(),
    completedSteps: z
      .array(z.enum(['define', 'reviewContract', 'configureGenerator', 'configurePricing']))
      .optional(),
  })
  .strict();

type DraftEditable = z.infer<typeof DraftEditableSchema>;

// Fields the API explicitly forbids in a request body. Surfaced here so the
// 400 message can name them rather than relying on `.strict()`'s generic
// "Unrecognized key" wording (which doesn't tell the SPA *why* a field is
// rejected — these are immutable, not just unknown).
const IMMUTABLE_FIELDS = ['draftId', 'createdAt', 'updatedAt', 'schemaVersion'] as const;

function rejectImmutableFields(
  body: unknown,
): { error: string; field: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  for (const f of IMMUTABLE_FIELDS) {
    if (f in (body as Record<string, unknown>)) {
      return { error: `\`${f}\` is immutable and cannot be set via the API`, field: f };
    }
  }
  return null;
}

function applyEditable(
  current: DraftSolverNetRecord,
  patch: DraftEditable,
  now: string,
): DraftSolverNetRecord {
  const next: DraftSolverNetRecord = { ...current, updatedAt: now };
  // Only assign keys that are explicitly present in the patch object so that
  // PATCH `{ name: 'x' }` doesn't clear `description` etc. The Zod schema's
  // `.optional()` would let `undefined` slip through, hence the explicit
  // `key in patch` check below.
  if ('templateContractId' in patch) next.templateContractId = patch.templateContractId;
  if ('templateContractVersion' in patch)
    next.templateContractVersion = patch.templateContractVersion;
  if ('name' in patch) next.name = patch.name;
  if ('description' in patch) next.description = patch.description;
  if ('generatorConfig' in patch) next.generatorConfig = patch.generatorConfig;
  if ('solutionPriceWei' in patch) next.solutionPriceWei = patch.solutionPriceWei;
  if ('verdictPriceWei' in patch) next.verdictPriceWei = patch.verdictPriceWei;
  if ('openRoles' in patch) next.openRoles = patch.openRoles;
  if ('completedSteps' in patch && patch.completedSteps !== undefined) {
    next.completedSteps = patch.completedSteps;
  }
  return next;
}

// ── Catalog query-string schemas (Task 15) ──────────────────────────────────

/**
 * Status filter shared by `/launched` (owned-list) and `/registry`
 * (global-list). The owned-list also accepts `launching`/`failed` because
 * those are local-only states that never make it to the registry; the
 * registry list is restricted to lifecycle-broadcast states.
 */
const OwnedStatusFilterSchema = z.enum([
  'launching',
  'launched',
  'paused',
  'retired',
  'failed',
]);

const RegistryStatusFilterSchema = z.enum(['launched', 'paused', 'retired']);

/**
 * Loose CIDv0 / CIDv1 sniff. We are not validating the full multihash —
 * that is the registry client's job — but rejecting trivial garbage here
 * (slashes from path traversal, hyphens, empty strings) keeps the IPFS
 * round-trip away from obvious attacks. CIDv0 = `Qm` + base58btc; CIDv1 in
 * the dag-pb codec we use here is base32-lower and starts with `bafy`.
 *
 * We accept any sufficiently-long alphanumeric tail without enforcing the
 * exact alphabet — the registry client's hash check against the on-chain
 * advertised hash is the canonical gate; this regex only filters obviously
 * non-CID inputs.
 */
// CIDv0 (Qm-base58) or CIDv1 (any multicodec — multibase prefix `b` is
// base32 lowercase alphanumeric). Earlier this regex anchored to `bafy`,
// the dag-pb codec prefix; the IPFS adapter actually pins manifests as
// raw bytes (codec `raw`), producing `bafkrei...`. See jinn-mono-wkzp.
// Loose by design — the registry client does the canonical decode. This only
// blocks obviously invalid/path-like input before an IPFS round-trip.
const CID_SHAPE_REGEX = /^(Qm[A-Za-z0-9]{10,}|b[A-Za-z0-9]{10,})$/u;

// ── Generator-config validation schemas ─────────────────────────────────────

/**
 * Zod schema mirroring `PredictionV1GeneratorRuntimeConfig` from
 * `solver-types/prediction-v1-auto.ts`. Kept narrow on purpose: only fields
 * the operator can hot-apply are accepted. Static-config fields (agent
 * identity, transport URLs) live in the daemon's static-config block and
 * are never mutated through this endpoint.
 *
 * `.strict()` rejects unknown keys so a typo in the SPA surfaces as 400
 * rather than silently dropping the field.
 */
const PredictionV1GeneratorConfigPatchSchema = z
  .object({
    cadenceMs: z.number().int().nonnegative().optional(),
    maxNewRoundsPerPoll: z.number().int().nonnegative().optional(),
    maxNewRoundsPerDay: z.number().int().nonnegative().optional(),
    maxOpenRounds: z.number().int().nonnegative().optional(),
    submissionWindowMs: z.number().int().nonnegative().optional(),
    allowlistConditionIds: z.array(z.string()).optional(),
    blocklistConditionIds: z.array(z.string()).optional(),
    minTimeToResolutionHours: z.number().nonnegative().optional(),
    maxTimeToResolutionHours: z.number().nonnegative().optional(),
    minLiquidityUsd: z.string().optional(),
    minVolume24hUsd: z.string().optional(),
    maxYesSpread: z.string().optional(),
    maxOrderbookAgeSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();

const SweRebenchV2GeneratorConfigPatchSchema = z
  .object({
    N_target_successes: z.number().int().positive().optional(),
    /** @deprecated #802 — abandon cap removed; tolerated on read, dropped on canonical write. */
    N_max_postings_per_task: z.number().int().positive().optional(),
    posting_window_ms: z.number().int().positive().optional(),
    post_batch_size: z.number().int().positive().optional(),
    maxClaimsPerOperator: z.number().int().positive().max(65_535).optional(),
    claimLeaseTtlSeconds: z.number().int().positive().optional(),
    admissionMode: z.enum(['required', 'python-floor']).optional(),
    /** @deprecated tolerated legacy key; ignored on canonical write. */
    cooldown_ms: z.number().int().nonnegative().optional(),
    /** @deprecated tolerated legacy nested shape; flattened on canonical write. */
    claimPolicy: z
      .object({
        maxClaims: z.number().int().positive().max(65_535).optional(),
        maxClaimsPerOperator: z.number().int().positive().max(65_535).optional(),
        claimLeaseTtlSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function isContractRefFor(
  contract: LaunchedRecordContractRef | null,
  id: string,
  version: string,
): boolean {
  return contract?.id === id && contract.version === version;
}

function canonicalSweRebenchV2GeneratorConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const legacyPolicy =
    typeof config.claimPolicy === 'object' && config.claimPolicy !== null
      ? config.claimPolicy as Record<string, unknown>
      : {};
  const next: Record<string, unknown> = {};
  for (const key of [
    'N_target_successes',
    'posting_window_ms',
    'post_batch_size',
  ] as const) {
    if (typeof config[key] === 'number') next[key] = config[key];
  }
  const maxClaimsPerOperator =
    typeof config.maxClaimsPerOperator === 'number'
      ? config.maxClaimsPerOperator
      : legacyPolicy.maxClaimsPerOperator;
  if (typeof maxClaimsPerOperator === 'number') {
    next.maxClaimsPerOperator = maxClaimsPerOperator;
  }
  const claimLeaseTtlSeconds =
    typeof config.claimLeaseTtlSeconds === 'number'
      ? config.claimLeaseTtlSeconds
      : legacyPolicy.claimLeaseTtlSeconds;
  if (typeof claimLeaseTtlSeconds === 'number') {
    next.claimLeaseTtlSeconds = claimLeaseTtlSeconds;
  }
  if (config.admissionMode === 'required' || config.admissionMode === 'python-floor') {
    next.admissionMode = config.admissionMode;
  }
  return next;
}

function mergeGeneratorConfigPatchForRecord(
  record: LaunchedSolverNetRecord,
  contract: LaunchedRecordContractRef | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  let nextConfig: Record<string, unknown> = {
    ...(record.generatorConfig ?? {}),
    ...patch,
  };
  if (
    isContractRefFor(contract, 'swe-rebench-v2', 'v1') &&
    typeof patch.claimPolicy === 'object' &&
    patch.claimPolicy !== null
  ) {
    const existingPolicy =
      typeof record.generatorConfig?.claimPolicy === 'object' &&
      record.generatorConfig.claimPolicy !== null
        ? record.generatorConfig.claimPolicy as Record<string, unknown>
        : {};
    nextConfig.claimPolicy = {
      ...existingPolicy,
      ...patch.claimPolicy as Record<string, unknown>,
    };
  }
  if (isContractRefFor(contract, 'swe-rebench-v2', 'v1')) {
    nextConfig = canonicalSweRebenchV2GeneratorConfig(nextConfig);
  }
  return nextConfig;
}

function parseGeneratorConfigPatchForRecord(
  contract: LaunchedRecordContractRef | null,
  raw: unknown,
): z.SafeParseReturnType<unknown, Record<string, unknown>> {
  if (isContractRefFor(contract, 'swe-rebench-v2', 'v1')) {
    return SweRebenchV2GeneratorConfigPatchSchema.safeParse(raw);
  }
  return PredictionV1GeneratorConfigPatchSchema.safeParse(raw);
}

function zodIssuesForResponse(error: z.ZodError): Array<{
  path: string;
  message: string;
}> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '<body>',
    message: issue.message,
  }));
}

// ── Launch helpers ──────────────────────────────────────────────────────────

interface DraftCompletenessResult {
  ok: boolean;
  missingFields: string[];
}

/**
 * Inspect a draft to determine whether it is launchable. The launch endpoint
 * uses this gate (and the gate alone) to decide whether to proceed; field-
 * shape validation has already happened on every PATCH.
 */
function checkDraftCompleteness(draft: DraftSolverNetRecord): DraftCompletenessResult {
  const missing: string[] = [];
  if (!draft.name || draft.name.trim().length === 0) missing.push('name');
  if (draft.description === undefined || draft.description === null)
    missing.push('description');
  if (!draft.templateContractId) missing.push('templateContractId');
  if (!draft.templateContractVersion) missing.push('templateContractVersion');
  if (!draft.solutionPriceWei) missing.push('solutionPriceWei');
  if (!draft.verdictPriceWei) missing.push('verdictPriceWei');
  if (!draft.openRoles || draft.openRoles.length === 0) missing.push('openRoles');
  return { ok: missing.length === 0, missingFields: missing };
}

/**
 * Build an `UnsignedSolverNetManifestV1` from a launchable draft + the
 * configured launcher identity + the SDK contract template. Caller signs
 * the result and hands it to `LaunchAction.launch`.
 *
 * `solverNetId` is derived from the launcher agentId + a stable suffix
 * derived from the draftId so re-launching the same draft would collide
 * (idempotency) — but because we delete drafts post-launch, in practice each
 * draft launches once and the id is unique.
 */
function buildUnsignedManifest(args: {
  draft: DraftSolverNetRecord;
  launcher: SolverNetsLaunchDeps['launcher'];
  network: SolverNetsLaunchDeps['network'];
  now: () => Date;
}): { ok: true; manifest: UnsignedSolverNetManifestV1 } | { ok: false; error: string } {
  const { draft, launcher, network, now } = args;
  const contract = getSolverNetContract({
    id: draft.templateContractId!,
    version: draft.templateContractVersion!,
  });
  if (!contract) {
    return {
      ok: false,
      error: `unknown contract template ${draft.templateContractId}.${draft.templateContractVersion}`,
    };
  }

  // Stable solverNetId: launcher agentId + draftId tail. Draft ids are uuid-
  // based so this gives uniqueness across launchers and within a launcher.
  const draftTail = draft.draftId.replace(/^draft_/, '').slice(0, 8);
  const solverNetId = `${launcher.agentId}_${contract.id}-${contract.version}_${draftTail}`;

  const nowIso = now().toISOString();

  const manifest: UnsignedSolverNetManifestV1 = {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId,
    network,
    name: draft.name!,
    description: draft.description ?? '',
    launcher: {
      safeAddress: launcher.safeAddress,
      agentEoa: launcher.agentEoa,
      agentId: launcher.agentId,
    },
    contract: {
      id: contract.id,
      version: contract.version,
      schemas: {
        task: contract.schemas.task.json,
        solution: contract.schemas.solution.json,
        verdict: contract.schemas.verdict.json,
      },
      claimPolicyDefaults: contract.claimPolicyDefaults,
      credentialRequirements: contract.credentialRequirements,
      // Copy the readonly `inputs` arrays so the manifest's mutable-array
      // schema accepts them. Functional content is identical.
      evaluationFunction: {
        ...contract.evaluationFunction,
        inputs: [...contract.evaluationFunction.inputs],
      },
      aggregationFunction: {
        ...contract.aggregationFunction,
        inputs: [...contract.aggregationFunction.inputs],
      },
    },
    solutionPriceWei: draft.solutionPriceWei!,
    verdictPriceWei: draft.verdictPriceWei!,
    openRoles: draft.openRoles!,
    ...(draft.generatorConfig ? { generatorConfig: draft.generatorConfig } : {}),
    createdAt: draft.createdAt,
    launchedAt: nowIso,
  };

  return { ok: true, manifest };
}

/**
 * Project a (record, manifest) pair into the catalog-row summary shape
 * shared with `SolverNetRegistryClient.listLaunched`.
 *
 * The lifecycle fields (`status`, `statusUpdatedAt`, `anchorBlock`) come
 * from the local `LaunchedSolverNetRecord` because the daemon owns the
 * authoritative view of what it has launched — we do *not* want to pay
 * an extra subgraph round-trip to re-derive lifecycle state when the
 * record already has it. The remaining fields (name, contract, prices,
 * openRoles, launcher) come from the manifest body.
 *
 * `status` widens to the registry's three-value enum: launching/failed
 * are local-only and never present on a record that has a manifest cached,
 * but we coerce them defensively to `launched`/`retired` respectively to
 * keep the projection total. Callers should gate on `record.status`
 * being one of {launched, paused, retired} before deciding to display.
 */
function summarizeLaunchedRecord(
  record: LaunchedSolverNetRecord,
  manifest: SolverNetManifestV1,
): SolverNetManifestSummary {
  const status: 'launched' | 'paused' | 'retired' =
    record.status === 'paused'
      ? 'paused'
      : record.status === 'retired'
        ? 'retired'
        : 'launched';
  return {
    manifestCid: record.manifestCid,
    solverNetId: manifest.solverNetId,
    name: manifest.name,
    network: manifest.network,
    launcherAgentId: manifest.launcher.agentId,
    launcherSafeAddress: manifest.launcher.safeAddress,
    status,
    statusUpdatedAt: record.statusUpdatedAt,
    contractId: manifest.contract.id,
    contractVersion: manifest.contract.version,
    solutionPriceWei: manifest.solutionPriceWei,
    verdictPriceWei: manifest.verdictPriceWei,
    openRoles: manifest.openRoles,
    anchorBlock: record.registry.metadataBlockNumber ?? 0,
    // Issue #985: derive the indexed chain id from the manifest network so this
    // local-record projection matches the registry/discovery summary shape.
    chainId: manifest.network === 'base' ? 8453 : 84532,
  };
}

/**
 * Look up a manifest summary for a record, using only the registry
 * client's in-process cache. Returns `undefined` on cache miss or when
 * the registry client is not wired — callers (the launched-list /
 * launched-get endpoints) treat `undefined` as "no summary available"
 * and fall back to displaying record-only fields.
 *
 * Cache-only by design: the launched-list endpoint runs on every SPA
 * poll, and an IPFS round-trip per row would dominate latency. For
 * SolverNets the daemon launched itself, the cache is warm by
 * construction (the launch path populates it).
 */
async function tryGetSummary(
  record: LaunchedSolverNetRecord,
  registry: SolverNetRegistryClient | undefined,
): Promise<SolverNetManifestSummary | undefined> {
  if (!registry) return undefined;
  try {
    const manifest = await registry.getManifestFromCache({
      manifestCid: record.manifestCid,
    });
    if (manifest === null) return undefined;
    return summarizeLaunchedRecord(record, manifest);
  } catch {
    // Defensive — the cache lookup is supposed to be infallible, but a
    // future async-backed cache could throw (storage error). We surface
    // an undefined summary rather than failing the entire list response.
    return undefined;
  }
}

async function tryGetOwnedCachedManifest(
  store: SolverNetStore,
  manifestCid: string,
): Promise<{
  record: LaunchedSolverNetRecord;
  manifest: SolverNetManifestV1;
} | null> {
  const records = await store.loadOwnedRecords();
  for (const record of records) {
    if (record.manifestCid !== manifestCid || !record.manifestPath) continue;
    const manifest = await store.loadManifestCache(record.manifestPath);
    if (!manifest) continue;
    if (manifest.solverNetId !== record.solverNetId) continue;
    if (manifestHash(manifest) !== record.manifestHash) continue;
    return { record, manifest };
  }
  return null;
}

function localLifecycleForRecord(record: LaunchedSolverNetRecord): {
  status: 'launched' | 'paused' | 'retired';
  statusUpdatedAt: string;
  sourceBlock: number;
} {
  // For records whose lifecycle has not yet been anchored on chain
  // (status === 'launching' or 'failed' — `metadataBlockNumber` undefined),
  // synthesise a `launched` display-lifecycle with `sourceBlock: 0`. The
  // manifest body IS real (hash-verified by `tryGetOwnedCachedManifest`),
  // so the launched dashboard can render names + prices instead of
  // placeholders. The record-level `status` field (queried separately by
  // the SPA via `/v1/solvernets/launched/:id`) continues to carry the
  // `launching`/`failed` signal for the status pill.
  return {
    status:
      record.status === 'paused' || record.status === 'retired'
        ? record.status
        : 'launched',
    statusUpdatedAt: record.statusUpdatedAt,
    sourceBlock: record.registry.metadataBlockNumber ?? 0,
  };
}

// ── Implementation ──────────────────────────────────────────────────────────

export function registerSolverNetsEndpoints(
  app: Hono,
  deps: SolverNetsEndpointsDeps,
): void {
  // jinn-mono-hqz0: deps may be a Proxy whose `store` property only resolves
  // after the SolverNet subsystem finishes post-bootstrap init. We bind a
  // Proxy-backed `store` so each method call dereferences the live value
  // at invocation time — destructuring would capture the initial undefined.
  const store: SolverNetStore = new Proxy({} as SolverNetStore, {
    get(_t, prop) {
      const live = deps.store;
      if (!live) {
        throw new Error('SolverNet store not initialised; subsystem still booting');
      }
      const value = (live as unknown as Record<string | symbol, unknown>)[prop as string];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(live) : value;
    },
  });

  // POST /v1/solvernets/drafts — create a new draft.
  app.post('/v1/solvernets/drafts', async (c) => {
    // Body is optional. An empty body (or a request with no body at all)
    // produces a fully-empty draft — the SPA fills it in via subsequent
    // PATCH calls as the operator walks the wizard.
    let raw: unknown = {};
    const text = await c.req.text();
    if (text.length > 0) {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json(
          { error: 'invalid_body', message: 'expected JSON body' },
          400,
        );
      }
    }

    const immutable = rejectImmutableFields(raw);
    if (immutable) {
      return c.json({ error: 'invalid_body', message: immutable.error }, 400);
    }

    const parsed = DraftEditableSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_body',
          message: parsed.error.issues
            .map((i) => `${i.path.join('.') || '<body>'}: ${i.message}`)
            .join('; '),
        },
        400,
      );
    }

    const now = new Date().toISOString();
    const draft: DraftSolverNetRecord = {
      schemaVersion: 'solvernet.draft.v1',
      draftId: `draft_${randomUUID()}`,
      completedSteps: parsed.data.completedSteps ?? [],
      createdAt: now,
      updatedAt: now,
      ...(parsed.data.templateContractId !== undefined && {
        templateContractId: parsed.data.templateContractId,
      }),
      ...(parsed.data.templateContractVersion !== undefined && {
        templateContractVersion: parsed.data.templateContractVersion,
      }),
      ...(parsed.data.name !== undefined && { name: parsed.data.name }),
      ...(parsed.data.description !== undefined && {
        description: parsed.data.description,
      }),
      ...(parsed.data.generatorConfig !== undefined && {
        generatorConfig: parsed.data.generatorConfig,
      }),
      ...(parsed.data.solutionPriceWei !== undefined && {
        solutionPriceWei: parsed.data.solutionPriceWei,
      }),
      ...(parsed.data.verdictPriceWei !== undefined && {
        verdictPriceWei: parsed.data.verdictPriceWei,
      }),
      ...(parsed.data.openRoles !== undefined && {
        openRoles: parsed.data.openRoles,
      }),
    };

    // Defensive parse: ensures the constructed shape still satisfies the
    // store's schema. If a future schema field becomes required and we
    // forget to populate it, we want a 500 here rather than a corrupt
    // file on disk.
    const validated = DraftSolverNetRecordSchema.safeParse(draft);
    if (!validated.success) {
      return c.json(
        {
          error: 'internal_error',
          message: `failed to construct draft: ${validated.error.issues.map((i) => i.message).join('; ')}`,
        },
        500,
      );
    }

    try {
      await store.writeDraft(validated.data);
    } catch (err) {
      return c.json(
        {
          error: 'store_write_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    return c.json(validated.data);
  });

  // GET /v1/solvernets/drafts — list all owned drafts.
  app.get('/v1/solvernets/drafts', async (c) => {
    let drafts: DraftSolverNetRecord[];
    try {
      drafts = await store.listDrafts();
    } catch (err) {
      return c.json(
        {
          error: 'store_read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    return c.json({ drafts });
  });

  // GET /v1/solvernets/drafts/:id — load a single draft.
  app.get('/v1/solvernets/drafts/:id', async (c) => {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'invalid_invocation', message: 'missing draft id' }, 400);
    }
    let draft: DraftSolverNetRecord | null;
    try {
      draft = await store.loadDraft(id);
    } catch (err) {
      return c.json(
        {
          error: 'store_read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    if (!draft) {
      return c.json({ error: 'draft_not_found', message: `Unknown draft: ${id}` }, 404);
    }
    return c.json(draft);
  });

  // PATCH /v1/solvernets/drafts/:id — update a draft.
  app.patch('/v1/solvernets/drafts/:id', async (c) => {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'invalid_invocation', message: 'missing draft id' }, 400);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { error: 'invalid_body', message: 'expected JSON body' },
        400,
      );
    }

    const immutable = rejectImmutableFields(raw);
    if (immutable) {
      return c.json({ error: 'invalid_body', message: immutable.error }, 400);
    }

    const parsed = DraftEditableSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_body',
          message: parsed.error.issues
            .map((i) => `${i.path.join('.') || '<body>'}: ${i.message}`)
            .join('; '),
        },
        400,
      );
    }

    let existing: DraftSolverNetRecord | null;
    try {
      existing = await store.loadDraft(id);
    } catch (err) {
      return c.json(
        {
          error: 'store_read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    if (!existing) {
      return c.json({ error: 'draft_not_found', message: `Unknown draft: ${id}` }, 404);
    }

    const next = applyEditable(existing, parsed.data, new Date().toISOString());
    const validated = DraftSolverNetRecordSchema.safeParse(next);
    if (!validated.success) {
      return c.json(
        {
          error: 'invalid_body',
          message: validated.error.issues
            .map((i) => `${i.path.join('.') || '<body>'}: ${i.message}`)
            .join('; '),
        },
        400,
      );
    }

    try {
      await store.writeDraft(validated.data);
    } catch (err) {
      return c.json(
        {
          error: 'store_write_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    return c.json(validated.data);
  });

  // DELETE /v1/solvernets/drafts/:id — delete a draft.
  app.delete('/v1/solvernets/drafts/:id', async (c) => {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'invalid_invocation', message: 'missing draft id' }, 400);
    }

    // Surface 404 for unknown ids rather than silent-success. The SPA can
    // distinguish "I deleted the only copy" from "this id was never there"
    // — useful for stale-tab detection.
    let existing: DraftSolverNetRecord | null;
    try {
      existing = await store.loadDraft(id);
    } catch (err) {
      return c.json(
        {
          error: 'store_read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    if (!existing) {
      return c.json({ error: 'draft_not_found', message: `Unknown draft: ${id}` }, 404);
    }

    try {
      await store.deleteDraft(id);
    } catch (err) {
      return c.json(
        {
          error: 'store_write_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    return c.json({ ok: true });
  });

  // ── Task 14 routes ────────────────────────────────────────────────────────

  // POST /v1/solvernets/drafts/:id/launch — kick off the launch state machine.
  //
  // Behaviour: validate completeness, build + sign the manifest, fire
  // `launchAction.launch(...)` in the background, and return 202 with a
  // poll URL. The state machine pins to IPFS, writes the initial record,
  // broadcasts setMetadata, awaits confirmation, and spawns the generator
  // — all asynchronously. The SPA polls `GET /v1/solvernets/launched/:id`
  // to track progress (`launchProgress.phase` reflects which phase the
  // machine is currently in).
  app.post('/v1/solvernets/drafts/:id/launch', async (c) => {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'invalid_invocation', message: 'missing draft id' }, 400);
    }

    if (!deps.launch) {
      return c.json(
        {
          error: 'launch_unavailable',
          message: 'launch routes are not configured; the daemon is missing launch dependencies',
        },
        503,
      );
    }
    const launchDeps = deps.launch;

    let draft: DraftSolverNetRecord | null;
    try {
      draft = await store.loadDraft(id);
    } catch (err) {
      return c.json(
        {
          error: 'store_read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    if (!draft) {
      return c.json({ error: 'draft_not_found', message: `Unknown draft: ${id}` }, 404);
    }

    const completeness = checkDraftCompleteness(draft);
    if (!completeness.ok) {
      return c.json(
        {
          error: 'draft_incomplete',
          message: `draft is missing required fields: ${completeness.missingFields.join(', ')}`,
          missingFields: completeness.missingFields,
        },
        400,
      );
    }

    const built = buildUnsignedManifest({
      draft,
      launcher: launchDeps.launcher,
      network: launchDeps.network,
      now: launchDeps.now ?? (() => new Date()),
    });
    if (!built.ok) {
      return c.json({ error: 'invalid_template', message: built.error }, 400);
    }

    let manifest: SolverNetManifestV1;
    try {
      manifest = await signManifest(built.manifest, launchDeps.signer.agentEoaPrivateKey);
    } catch (err) {
      return c.json(
        {
          error: 'manifest_sign_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    // Idempotency: if a record with this solverNetId already exists, return
    // it instead of starting a second launch. The state machine itself is
    // also idempotent (launch() routes to resume() for existing records),
    // but short-circuiting here avoids a redundant signManifest round.
    const existing = await store.loadRecord(manifest.solverNetId);
    if (existing) {
      return c.json(
        {
          solverNetId: manifest.solverNetId,
          status: existing.status,
          pollUrl: `/v1/solvernets/launched/${manifest.solverNetId}`,
        },
        202,
      );
    }

    // Fire-and-forget: the launch state machine pins, writes the record,
    // broadcasts, awaits confirmation, and spawns the generator. We do not
    // await it here — production launches can take 30+ seconds (IPFS pin +
    // tx confirmation) and the SPA tracks progress via `launchProgress`.
    void launchDeps.launchAction
      .launch({
        manifest,
        signer: launchDeps.signer,
        // jinn-mono-jnr1: forward the wizard's per-record runtime config so
        // the launched record persists it; otherwise the generator falls
        // back to DEFAULTS (cadence 6h etc.) regardless of what the
        // operator picked in the Create flow.
        generatorConfig: draft.generatorConfig,
      })
      .catch((err) => {
        // The state machine has already persisted the failure to disk
        // (`launchProgress.txError`); we just log so the daemon operator
        // sees the failure in stderr without crashing the process.
        // eslint-disable-next-line no-console
        console.error(
          `[solvernets] background launch ${manifest.solverNetId} failed:`,
          err,
        );
      });

    // Briefly wait for the initial record to land on disk so the SPA's
    // first poll always finds a record. The launch action's first persisted
    // checkpoint is after the IPFS upload — typically <100ms with mocked
    // ipfs (tests) or a few seconds in production. If it does not show up
    // within the timeout we return 202 anyway; the SPA's poll will reveal
    // the failure.
    const POLL_BUDGET_MS = 5_000;
    const POLL_INTERVAL_MS = 25;
    const start = Date.now();
    let initialRecord: LaunchedSolverNetRecord | null = null;
    while (Date.now() - start < POLL_BUDGET_MS) {
      initialRecord = await store.loadRecord(manifest.solverNetId);
      if (initialRecord) break;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return c.json(
      {
        solverNetId: manifest.solverNetId,
        status: initialRecord?.status ?? 'launching',
        pollUrl: `/v1/solvernets/launched/${manifest.solverNetId}`,
      },
      202,
    );
  });

  // GET /v1/solvernets/launched/:id — read the current launched record.
  //
  // Prefers the in-memory recordRef (the launch state machine and the
  // generator-config route mutate it synchronously after each disk write) and
  // falls back to disk. Either source is up-to-date because both are written
  // before the operation returns.
  //
  // Response shape: the persisted record fields + an optional
  // `summary?: SolverNetManifestSummary` derived from the registry
  // client's in-process manifest cache. Cache miss → `summary` is
  // omitted. The summary is the only place catalog-y identity (name,
  // contract id/version, prices, openRoles) appears on this surface;
  // the SPA falls back to bare record fields when it is missing.
  app.get('/v1/solvernets/launched/:id', async (c) => {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'invalid_invocation', message: 'missing record id' }, 400);
    }

    // Prefer in-memory ref when available (launch / generator-config updates
    // land there first via mutation).
    if (deps.launch) {
      const entry = deps.launch.pendingGenerators.current.find(
        (g) => g.recordRef.current.solverNetId === id,
      );
      if (entry) {
        const liveRecord = withLiveGeneratorState(
          entry.recordRef.current,
          deps.launch.getGeneratorState,
        );
        const summary = await tryGetSummary(liveRecord, deps.registry);
        return c.json({
          ...liveRecord,
          ...(summary !== undefined ? { summary } : {}),
        });
      }
    }

    let record: LaunchedSolverNetRecord | null;
    try {
      record = await store.loadRecord(id);
    } catch (err) {
      return c.json(
        {
          error: 'store_read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    if (!record) {
      return c.json({ error: 'record_not_found', message: `Unknown record: ${id}` }, 404);
    }
    const liveRecord = withLiveGeneratorState(record, deps.launch?.getGeneratorState);
    const summary = await tryGetSummary(liveRecord, deps.registry);
    return c.json({
      ...liveRecord,
      ...(summary !== undefined ? { summary } : {}),
    });
  });

  // PATCH /v1/solvernets/launched/:id/generator-config — hot-apply config.
  //
  // Updates the persisted record's `generatorConfig` AND mutates the live
  // `configRef.current` for any pendingGenerators entry. The next generator
  // tick reads the new cadence/allowlist/caps via the ref.
  app.patch('/v1/solvernets/launched/:id/generator-config', async (c) => {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'invalid_invocation', message: 'missing record id' }, 400);
    }

    if (!deps.launch) {
      return c.json(
        {
          error: 'launch_unavailable',
          message: 'generator-config routes are not configured',
        },
        503,
      );
    }
    const launchDeps = deps.launch;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', message: 'expected JSON body' }, 400);
    }

    let record: LaunchedSolverNetRecord | null;
    try {
      record = await store.loadRecord(id);
    } catch (err) {
      return c.json(
        {
          error: 'store_read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    if (!record) {
      return c.json({ error: 'record_not_found', message: `Unknown record: ${id}` }, 404);
    }

    const contract = await resolveLaunchedRecordContract(record);
    const parsed = parseGeneratorConfigPatchForRecord(contract, raw);
    if (!parsed.success) {
      const issues = zodIssuesForResponse(parsed.error);
      return c.json(
        {
          error: 'invalid_body',
          kind: 'schema_validation_failed',
          issues,
          message: issues.map((i) => `${i.path}: ${i.message}`).join('; '),
        },
        400,
      );
    }

    // Patch semantics: merge the provided fields over the existing config.
    // Operators editing one field shouldn't have to re-send the rest.
    const nextConfig = mergeGeneratorConfigPatchForRecord(record, contract, parsed.data);

    // Persist on disk. The store schema treats generatorConfig as an opaque
    // record; we widen the strongly-typed runtime config back to that shape
    // for storage.
    const updatedRecord: LaunchedSolverNetRecord = {
      ...record,
      generatorConfig: nextConfig,
    };
    const validated = LaunchedSolverNetRecordSchema.safeParse(updatedRecord);
    if (!validated.success) {
      return c.json(
        {
          error: 'invalid_record',
          message: `failed to construct updated record: ${validated.error.issues.map((i) => i.message).join('; ')}`,
        },
        500,
      );
    }
    try {
      await store.writeRecord(validated.data);
    } catch (err) {
      return c.json(
        {
          error: 'store_write_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    // Hot-apply: mutate the live configRef + recordRef in place so the next
    // generator tick sees the new config without waiting for a disk reload.
    // It is valid for there to be no pendingGenerators entry (e.g. the
    // record is paused / retired and the generator is not running) — the
    // disk write above is enough; the next time the daemon spawns the
    // generator (next launched-status flip) it will seed configRef from
    // the persisted record.
    const entry = launchDeps.pendingGenerators.current.find(
      (g) => g.recordRef.current.solverNetId === id,
    );
    if (entry) {
      entry.configRef.current = nextConfig;
      entry.recordRef.current = validated.data;
    }

    return c.json(nextConfig);
  });

  // ── Task 15 routes ────────────────────────────────────────────────────────

  // GET /v1/solvernets/launched — list owned launched records (= what this
  // daemon launched). The registry catalog (below) is the global view; this
  // is the local mirror — exactly the rows the daemon is responsible for
  // running generators for.
  //
  // Optional `?status=<launching|launched|paused|retired|failed>` filter
  // narrows the list. Without the filter, all records (including retired)
  // are returned — the SPA decides what to show. This shape lets the SPA
  // render a unified "your SolverNets" tab without N round-trips.
  //
  // Each row also carries an optional `summary?: SolverNetManifestSummary`
  // populated from the registry client's in-process manifest cache —
  // populated for every SolverNet this daemon launched (the launch path
  // primes the cache), `undefined` for the pre-cache window during a
  // launch in flight. Cache-only on purpose: list responses run on every
  // SPA poll, and an IPFS round-trip per row would dominate latency.
  app.get('/v1/solvernets/launched', async (c) => {
    const statusQuery = c.req.query('status');
    let statusFilter: z.infer<typeof OwnedStatusFilterSchema> | undefined;
    if (statusQuery !== undefined) {
      const parsed = OwnedStatusFilterSchema.safeParse(statusQuery);
      if (!parsed.success) {
        return c.json(
          {
            error: 'invalid_query',
            message: `unknown status filter: ${statusQuery}`,
          },
          400,
        );
      }
      statusFilter = parsed.data;
    }

    let records: LaunchedSolverNetRecord[];
    try {
      records = await store.loadOwnedRecords();
    } catch (err) {
      return c.json(
        {
          error: 'store_read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    if (statusFilter !== undefined) {
      records = records.filter((r) => r.status === statusFilter);
    }

    // Enrich each record with its manifest summary from the cache, when
    // available. We `Promise.all` the lookups so a future async-backed
    // cache (e.g. SQLite) would not serialize per row, even though the
    // day-1 implementation is a synchronous Map read.
    const enriched = await Promise.all(
      records.map(async (record) => {
        const liveRecord = withLiveGeneratorState(record, deps.launch?.getGeneratorState);
        const summary = await tryGetSummary(liveRecord, deps.registry);
        return summary !== undefined ? { ...liveRecord, summary } : liveRecord;
      }),
    );

    return c.json({ records: enriched });
  });

  // GET /v1/solvernets/registry — list global launched SolverNets from the
  // catalog cache (populated by the daemon's registry-catalog refresh loop
  // wired in `daemon-init.ts`).
  //
  // Behaviour:
  //   - Default filter is `launched + paused`; retired entries are excluded
  //     unless the caller explicitly asks for `?status=retired`. This matches
  //     the join-flow's "useful surface" — operators picking a SolverNet to
  //     join shouldn't have to scroll past tombstoned ones.
  //   - `?refresh=1` forces a refresh before reading the snapshot. The SPA
  //     uses this on user-initiated reload; the auto-tick keeps the cache
  //     warm in the background.
  //   - Cache metadata (`lastRefreshedAt`, `lastError`) is always returned
  //     so the SPA can render a "stale" indicator and surface errors.
  app.get('/v1/solvernets/registry', async (c) => {
    if (!deps.catalog) {
      return c.json(
        {
          error: 'registry_unavailable',
          message: 'registry catalog cache is not configured',
        },
        503,
      );
    }
    const catalog = deps.catalog;

    const statusQuery = c.req.query('status');
    let statusFilter: Array<z.infer<typeof RegistryStatusFilterSchema>>;
    if (statusQuery !== undefined) {
      const parsed = RegistryStatusFilterSchema.safeParse(statusQuery);
      if (!parsed.success) {
        return c.json(
          {
            error: 'invalid_query',
            message: `unknown status filter: ${statusQuery}`,
          },
          400,
        );
      }
      statusFilter = [parsed.data];
    } else {
      // Default: launched + paused. Retired is excluded from the default
      // surface — operators see those only via explicit ?status=retired.
      statusFilter = ['launched', 'paused'];
    }

    if (c.req.query('refresh') === '1') {
      // Force a refresh before reading the snapshot. The cache itself
      // suppresses errors — they land in `lastError` which we surface in
      // the response, so the SPA can show "couldn't refresh, here's the
      // last cached snapshot" rather than a blank page.
      await catalog.refresh();
    }

    const snapshot = catalog.getCatalog();
    const summaries = snapshot.filter((s) => statusFilter.includes(s.status));

    const lastRefreshedAt = catalog.lastRefreshedAt();
    const lastError = catalog.lastError();
    return c.json({
      summaries,
      lastRefreshedAt: lastRefreshedAt === null ? null : lastRefreshedAt.toISOString(),
      lastError:
        lastError === null
          ? null
          : {
              message: lastError.message,
              at: lastError.at.toISOString(),
              // Forward the typed reason (currently only `rpc_rate_limited`)
              // so the SPA can render an operator-actionable message rather
              // than a generic "catalog failed" string. See jinn-mono #325.
              ...(lastError.code !== undefined ? { code: lastError.code } : {}),
            },
    });
  });

  // GET /v1/solvernets/registry/:cid — fetch a specific manifest from the
  // registry, with its current lifecycle status.
  //
  // The registry client validates the manifest's canonical hash against the
  // on-chain advertised hash; if it throws (missing IPFS body, schema
  // mismatch, hash mismatch), we surface 404 — the manifest is "not found"
  // from a useful-surface perspective regardless of which leg failed. The
  // exact failure reason is in the response message for debugging.
  //
  // CID validation here is intentionally loose: we reject obvious garbage
  // (path-traversal, decimals, empty) so we never round-trip them to IPFS,
  // but the registry client does the canonical check.
  app.get('/v1/solvernets/registry/:cid', async (c) => {
    const cid = c.req.param('cid');
    if (!cid) {
      return c.json(
        {
          error: 'invalid_cid',
          message: `cid does not look like a CID: ${cid ?? '<empty>'}`,
        },
        400,
      );
    }

    // CID shape validation runs before the owned-cache lookup and the
    // no-registry 503 guard so garbage cids never reach those branches.
    // Pre-#114 the no-registry 503 short-circuited first, but the owned-cache
    // short-circuit added by #114 would otherwise let malformed cids return
    // 503 instead of 400 in no-registry mode.
    if (!CID_SHAPE_REGEX.test(cid)) {
      return c.json(
        {
          error: 'invalid_cid',
          message: `cid does not look like a CID: ${cid}`,
        },
        400,
      );
    }

    let ownedCached: Awaited<ReturnType<typeof tryGetOwnedCachedManifest>>;
    try {
      ownedCached = await tryGetOwnedCachedManifest(store, cid);
    } catch (err) {
      return c.json(
        {
          error: 'store_read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    if (ownedCached) {
      return c.json({
        manifest: ownedCached.manifest,
        lifecycle: localLifecycleForRecord(ownedCached.record),
      });
    }

    if (!deps.registry) {
      return c.json(
        {
          error: 'registry_unavailable',
          message:
            'registry client is not configured and no owned cached manifest matched this cid',
        },
        503,
      );
    }
    const registry = deps.registry;

    let manifest: SolverNetManifestV1;
    try {
      manifest = await registry.getManifest({ manifestCid: cid });
    } catch (err) {
      return c.json(
        {
          error: 'manifest_not_found',
          message: err instanceof Error ? err.message : String(err),
        },
        404,
      );
    }

    let lifecycle: {
      status: 'launched' | 'paused' | 'retired';
      statusUpdatedAt: string;
      sourceBlock: number;
    };
    try {
      lifecycle = await registry.getLifecycleStatus({ manifestCid: cid });
    } catch (err) {
      // The manifest body exists on IPFS but no lifecycle events were found
      // on chain — surface as 404 with the real reason in the message.
      // This is genuinely unusual (the launcher must have setMetadata'd the
      // initial cid for the manifest to be discoverable at all), but it can
      // happen during the brief window between IPFS pin and on-chain confirm.
      // For records owned by this operator the early `ownedCached`
      // short-circuit above already serves the locally-cached manifest
      // with a synthesised lifecycle, so non-owned manifests are the
      // only ones that reach this path (#114).
      return c.json(
        {
          error: 'manifest_not_found',
          message: err instanceof Error ? err.message : String(err),
        },
        404,
      );
    }

    return c.json({ manifest, lifecycle });
  });
}
