/**
 * Config loader for jinn-client.
 *
 * Resolution order (highest priority wins):
 *   1. Environment variables (JINN_*, BASE_RPC_URL, BASE_SEPOLIA_RPC_URL)
 *   2. Config file (--config flag or ~/.jinn-client/config.json)
 *   3. Built-in defaults
 *
 * JINN_PASSWORD is always env-only — never written to config files.
 *
 * Operator UX: JINN_DEBUG=1 enables full stack traces. JINN_MASTER_ETH_DAILY_WEI
 * (wei, integer string) tunes master wallet low-ETH runway warnings.
 * Router claims: JINN_ROUTER_CLAIM_DELIVERY_VERSION=v1|v2 overrides chain default
 * (mainnet V1, testnet V2) for JinnRouter claimDelivery encoding.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod/v3';
import { NativeOperatorConfigSchema } from './daemon/native-product-config.js';
import { TaskSchema, parseTask } from './types/task.js';
import type { Task } from './types/task.js';
import { canonicalHarnessName, CLAUDE_CODE_HARNESS } from './harnesses/names.js';
import { isOpenRouterModelId } from './harnesses/provider-ref.js';
import { parseRpcUrls } from './rpc/transport.js';
import { canonicalLocalHttpBaseUrl } from './local-provider-url.js';
import {
  CONFIG_SHAPE_VERSION,
  ClaimPolicyConfigSchema,
  ExecutionWiringConfigEntrySchema,
  PostingConfigEntrySchema,
} from './config/shape-v2.js';
import {
  NativeAgentIriSchema,
  NativeCompositionModeSchema,
  NativeEvaluatorConfigSchema,
  NativeFinalityConfigSchema,
  NativeIdentityStoresConfigSchema,
  NativeIpfsConfigSchema,
  NativePublicBaseUrlSchema,
  NativeTrustPolicyGenesisDigestSchema,
  NativeTrustRootsPathSchema,
} from './config/native-sections.js';
import { migrateConfigShapeV2, type ConfigMigrationReport } from './config/migrate-shape-v2.js';
import { recordPhaseDTransitionUse } from './compatibility/phase-d-transition-usage.js';

// ── Schema ──────────────────────────────────────────────────────────────────

const HarnessNameSchema = z.string().transform((name) => canonicalHarnessName(name));

export const JinnConfigSchema = z.object({
  /**
   * Network to connect to.
   * 'testnet' → Base Sepolia (default during Phase 1b; fast epochs, free funds).
   * 'mainnet' → Base mainnet (flipped on at Phase 2 launch).
   * Operators should not normally need to set this — the default tracks whatever
   * phase the protocol is in.
   */
  network: z.enum(['mainnet', 'testnet']).default('testnet'),

  /**
   * Base RPC endpoint(s). Accepts either a single URL string or an array of
   * URLs. When an array (or a comma-separated env var) is supplied, the
   * daemon builds a viem `fallback()` chain in slot order (primary first).
   * See `client/src/rpc/transport.ts` for the wrapper. Defaults to the
   * publicnode+sepolia.base.org two-provider chain on testnet and the public
   * `mainnet.base.org` on mainnet. Set explicitly to override.
   *
   * Env: JINN_RPC_URL / BASE_SEPOLIA_RPC_URL / BASE_RPC_URL (comma-separated).
   */
  rpcUrl: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  archiveRpcUrl: z.union([z.string(), z.array(z.string()).min(1)]).optional(),

  /**
   * Single volume-aware durable-state root. When set (env JINN_STATE_DIR or
   * this file field), `earningDir`, `dbPath`, `engine.implStateDirRoot`, and
   * `sweRebenchV2StateDir` derive from it as `<stateDir>/<subdir>` —
   * UNLESS each is individually overridden, in which case the per-key value
   * wins (derive-don't-collapse). With `stateDir` unset, every default is
   * byte-identical to the legacy `~/.jinn-client/<subdir>` paths. Hosted
   * deploys collapse four ENV lines to one `JINN_STATE_DIR=/data`.
   * `engine.workingDirRoot` is deliberately NOT derived — it stays ephemeral
   * (reaped per-task).
   */
  stateDir: z.string().optional(),

  /** Earning state directory */
  earningDir: z.string().default(join(homedir(), '.jinn-client', 'earning')),

  /** SQLite database path */
  dbPath: z.string().default(join(homedir(), '.jinn-client', 'jinn.db')),

  /**
   * SWE-rebench v2 durable state (validated pool, generator ledger, harvest).
   * Derived from `stateDir` / `JINN_STATE_DIR` as `<stateDir>/swe-rebench-v2`
   * unless overridden by this field or `JINN_SWE_REBENCH_V2_STATE_DIR`.
   */
  sweRebenchV2StateDir: z
    .string()
    .default(join(homedir(), '.jinn-client', 'swe-rebench-v2')),

  /** Chain poll interval in ms */
  pollIntervalMs: z.number().int().positive().default(5000),

  /**
   * How often the daemon attempts stOLAS ExternalStakingDistributor.claim for each staked
   * fleet service (ms). Default 600000 (10 min) — on by default in standard staking mode.
   * This overturns the manual-claim-from-the-app rationale this field previously carried:
   * OPERATOR-APP-SPEC.md's 2026-08-04 amendment (§2.7) corrects the spec's claim that
   * rewards need no manual step — a manual claim action shipped and stays (POST
   * /api/admin/claim-rewards / jinn claim-rewards, for an operator who wants to force a
   * claim or has opted out of the loop), but the loop's off-by-default premise (that the
   * app was the only claim path, so defaulting off just meant "claim from the app instead")
   * left with the SPA — off-by-default was silently costing operators money. Set
   * JINN_REWARD_CLAIM_INTERVAL_MS=0 to opt back out and claim manually only.
   * Env: JINN_REWARD_CLAIM_INTERVAL_MS
   */
  rewardClaimIntervalMs: z.number().int().min(0).default(600_000),

  /**
   * How often the daemon checks agent EOA and Safe balances and tops them up from the master
   * wallet when they drop below trigger thresholds (ms). Default 300000 (5 min).
   * Set to 0 to disable. Env: JINN_BALANCE_TOPUP_INTERVAL_MS
   */
  balanceTopupIntervalMs: z.number().int().min(0).default(300_000),

  /**
   * Interval between eviction-state polls for the staking proxy (ms).
   * Default 60000 (1 min). Set to 0 to disable. Env: JINN_EVICTION_CHECK_INTERVAL_MS
   */
  evictionCheckIntervalMs: z.number().int().min(0).default(60_000),

  /**
   * Interval between proactive `checkpoint()` tx calls to each staked
   * proxy (ms). Keeps `tsCheckpoint` advancing so the activity-rate window
   * stays narrow — without it operators silently fail liveness on realistic
   * cadence (issue #505). Default 300_000 (5 min), matching the standard
   * `livenessPeriod` on stOLAS staking proxies. Set to 0 to disable.
   * Env: JINN_CHECKPOINT_INTERVAL_MS.
   */
  checkpointIntervalMs: z.number().int().min(0).default(300_000),

  /** HTTP API port */
  apiPort: z.number().int().positive().default(7331),

  /**
   * Bind host for the HTTP API server. Defaults to `127.0.0.1` so the daemon
   * is unreachable across the network out of the box — operators who need
   * LAN access (or who terminate TLS in front of the daemon) opt in via this
   * knob or `JINN_API_BIND_HOST`. Cost-mutating routes (`POST /artifacts`,
   * `POST /v1/artifacts/acquire`) require a bearer token regardless; the
   * bind host is the outer firewall.
   * Env: JINN_API_BIND_HOST.
   */
  apiBindHost: z.string().optional(),

  /** Path to claude CLI binary */
  claudePath: z.string().default('claude'),

  /** Model for restoration/evaluation agent */
  claudeModel: z.string().default('claude-haiku-4-5-20251001'),

  /** Path to the `hermes` executable. Defaults to `hermes` when unset. */
  hermesPath: z.string().optional(),

  /** Default Hermes model when a SolverNet does not specify one. */
  hermesModel: z.string().optional(),

  /** Hermes provider (e.g. 'anthropic'). */
  hermesProvider: z.string().optional(),

  /** Local OpenAI-compatible Hermes base URL, e.g. http://127.0.0.1:11434/v1 for Ollama. */
  hermesBaseUrl: z
    .string()
    .url()
    .transform((value, ctx) => {
      const canonical = canonicalLocalHttpBaseUrl(value);
      if (!canonical) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'hermesBaseUrl must be a local HTTP(S) URL',
        });
        return z.NEVER;
      }
      return canonical;
    })
    .optional(),

  /**
   * Timeout in ms for `hermes doctor` health-check runs.
   * Default 30 000 ms. Env: JINN_HERMES_DOCTOR_TIMEOUT_MS.
   */
  hermesDoctorTimeoutMs: z.number().int().positive().default(30_000),

  /** Path to the `codex` executable. Defaults to `codex` when unset. */
  codexPath: z.string().optional(),

  /**
   * Timeout in ms for `codex --version` health-check runs.
   * Default 30 000 ms. Env: JINN_CODEX_DOCTOR_TIMEOUT_MS.
   */
  codexDoctorTimeoutMs: z.number().int().positive().default(30_000),

  /**
   * How the operator runs the daemon. Set once by app-guided setup or the
   * legacy `jinn auth` compatibility command, then read by every command that
   * probes the Claude CLI or spawns a subprocess. Leaving it
   * unset falls back to filesystem-based detection (docker-compose.yml near
   * cwd, /.dockerenv, etc.) which is error-prone inside a checkout of the
   * repo itself.
   * Env override: JINN_RUNTIME_MODE.
   */
  runtimeMode: z.enum(['bare', 'docker-compose', 'container']).optional(),

  /** Comma-separated or array of peer URLs */
  peers: z.union([
    z.string().transform(s => s.split(',').filter(Boolean)),
    z.array(z.string()),
  ]).default([]),

  /**
   * Discovery backend configuration.
   *
   * Spec: spec/2026-05-11-discovery-api-and-shared-indexer.md §9.1.
   *
   * mode:
   *   'http'      — HTTP client pointing at a shared Ponder indexer (ships in 280n.4).
   *   'embedded'  — embedded Ponder in-process (ships in 280n.5 — throws until then).
   *   'onchain'   — direct RPC getLogs; always-live floor; no indexer required.
   *
   * Default URLs for mode='http' (intentionally undefined until the maintainer's VPS is live):
   *   // TODO: set once maintainer's VPS is live (jinn-mono-280n.4 deployment)
   *   // DEFAULT_TESTNET_DISCOVERY_URL = 'https://...'  // Base Sepolia
   *   // DEFAULT_MAINNET_DISCOVERY_URL = 'https://...'  // Base mainnet
   *
   * Env overrides: JINN_DISCOVERY_MODE, JINN_DISCOVERY_URL,
   * JINN_DISCOVERY_FALLBACK (1|true|yes to enable, 0|false|no to disable).
   */
  discovery: z
    .object({
      mode: z.enum(['http', 'embedded', 'onchain']).optional(),
      url: z.string().optional(),
      fallbackToOnchain: z.boolean().optional(),
    })
    .optional(),

  /**
   * Narrow task discovery to specific on-chain task ids. This is primarily
   * for live acceptance gates that must avoid claiming unrelated public
   * backlog while proving one fresh task path.
   * Env: JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS (comma-separated).
   */
  taskDiscoveryAllowedTaskIds: z.array(z.string()).optional(),

  /**
   * Explicit absolute lower bound (L2 block number) for the mech adapter's
   * on-chain TaskCreated backlog scan. Unset → the scan defaults to a bounded
   * rolling window (`head − DEFAULT_ONCHAIN_SCAN_WINDOW_BLOCKS`, ~28h on Base),
   * so a restart no longer replays full chain history every boot (#801); the
   * indexer (DiscoveryAPI.findClaimableTasks) is the primary discovery path and
   * the on-chain scan is a bounded backstop. Set this to widen the backstop to a
   * specific block (the value pins both the scan start and the gh #300 admission
   * floor). Env: JINN_TASK_DISCOVERY_FROM_BLOCK.
   */
  taskDiscoveryOnchainFromBlock: z.number().int().min(0).optional(),

  /** This node's public HTTP endpoint (for 8004 registration) */
  nodeEndpoint: z.string().optional(),

  /** Tasks to create and solve. Empty by default; enabled SolverNet generators fill the loop. */
  tasks: z.array(TaskSchema).default([]),

  /** IPFS upload endpoint */
  ipfsRegistryUrl: z.string().default('https://registry.autonolas.tech'),

  /** IPFS read endpoint */
  ipfsGatewayUrl: z.string().default('https://gateway.autonolas.tech'),

  /** Optional Base Sepolia Phase 1a staking deployment artifact path */
  testnetL2DeploymentPath: z.string().optional(),

  /** Optional Base Sepolia Phase 1a token deployment artifact path */
  testnetL2TokenDeploymentPath: z.string().optional(),

  /** Optional Base Sepolia mech marketplace deployment artifact path */
  testnetMechDeploymentPath: z.string().optional(),

  /** Optional Base Sepolia stOLAS deployment artifact path */
  testnetStolasDeploymentPath: z.string().optional(),

  /**
   * Loop-watchdog auto-restart gate (#1043). Default OFF (the locked Option A
   * decision): the watchdog always detects a stale loop and loud-logs + emits
   * a `loop_watchdog_stale` event, but the non-zero process.exit recovery only
   * fires when this is on. Env: JINN_WATCHDOG_AUTO_RESTART=1|true|yes.
   */
  watchdogAutoRestart: z.boolean().default(false),

  /** Staking mode: 'standard' uses stOLAS (no OLAS needed), 'self-bond' uses operator-provided OLAS. */
  stakingMode: z.enum(['standard', 'self-bond']).default('standard'),

  /** Number of services to bootstrap and run. */
  targetServices: z.number().int().positive().default(1),

  /**
   * When true, log full error objects and stack traces from bootstrap / main.
   * Env: JINN_DEBUG=1|true|yes
   */
  debug: z.boolean().default(false),

  /**
   * Estimated master wallet gas usage per day (wei string), for low-ETH runway warnings.
   * Default is applied in bootstrap when unset. Env: JINN_MASTER_ETH_DAILY_WEI
   */
  masterEthDailyEstimateWei: z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer string')
    .optional(),

  /**
   * Optional gas runway override for bootstrap/top-up targets (wei string).
   * Used by Docker testnet acceptance to match the bundled faucet budget.
   * Env: JINN_MIN_EOA_GAS_WEI
   */
  minEoaGasWei: z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer string')
    .optional(),

  /**
   * Optional Safe ETH target override for bootstrap/top-up targets (wei string).
   * Env: JINN_MIN_SAFE_ETH_WEI
   */
  minSafeEthWei: z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer string')
    .optional(),

  /**
   * Faucet top-up daily cap + cooldown (issue #560). Single source of truth
   * for the running-mode Dashboard "Top up from faucet" batch action, shared
   * by the daemon endpoint and surfaced to the SPA via GET /v1/setup/drip/quota.
   *
   * `faucetDailyTopupCap` — number of faucet drips a single operator click may
   * issue in one batch (and the per-24h ceiling per wallet). Env:
   * JINN_FAUCET_DAILY_TOPUP_CAP.
   *
   * `faucetTopupCooldownMs` — once the cap is reached, the top-up action is
   * disabled until this window elapses since the first call of that batch.
   * Env: JINN_FAUCET_TOPUP_COOLDOWN_MS.
   */
  faucetDailyTopupCap: z.number().int().positive().default(10),
  faucetTopupCooldownMs: z
    .number()
    .int()
    .min(0)
    .default(24 * 60 * 60 * 1000),

  /**
   * Operator-controlled Harness inventory.
   */
  harnesses: z
    .object({
      default: HarnessNameSchema.optional(),
      disabled: z.array(HarnessNameSchema).optional(),
      /**
       * Operator-supplied external harness impls.
       *
       * Each entry points the daemon at a manifest-bearing package on disk
       * (typically inside `node_modules/`); `client/src/main.ts` invokes
       * `loadExternalImpl()` for each entry at boot, validates the manifest
       * against `trustedImplSigners`, and registers the resulting impl in
       * the harness registry. See
       * `docs/superpowers/plans/2026-04-30-plug-in-surface-path-2-foundation.md`
       * step 5.7-5.8.
       */
      externalImpls: z
        .array(
          z.object({
            name: z.string(),
            entry: z.string(),
            package: z.string().optional(),
            /**
             * Optional pinned version. When set, the loader rejects the
             * impl if its manifest's `version` does not match this string
             * exactly — guards against silent upgrades of an on-disk
             * package without an explicit operator config change
             * (Finding 10).
             */
            version: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),

  /**
   * Harness execution settings. The `mode` field controls whether the
   * harness runs with state-write phases enabled (`train`) or disabled
   * (`frozen`). Frozen mode produces stable codeDigest across Tasks for
   * benchmark-grade per-snapshot scoring; see
   * docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §5.
   */
  harness: z
    .object({
      mode: z.enum(['train', 'frozen', 'candidate']).default('train'),
      /**
       * Explicit `supports()` routing for the learner harnesses (policy
       * optimization product design §10). `solverTypes` names what this
       * operator's learner claims; absent or empty means it claims nothing.
       * `legacyDefaultRouting` restores the deprecated wrap-every-SolverType
       * posture (equivalently: `JINN_LEARNER_DEFAULT_ROUTING=1`).
       */
      routing: z
        .object({
          solverTypes: z.array(z.string()).optional(),
          legacyDefaultRouting: z.boolean().optional(),
        })
        .optional(),
      /**
       * Candidate-mode settings. `proposerAgentIri` attributes the sealed
       * candidate manifest to this operator; without it the run emits a
       * candidate tree but refuses to seal an unattributable proposal.
       */
      candidate: z
        .object({
          workspaceRoot: z.string().optional(),
          proposerAgentIri: z.string().optional(),
        })
        .optional(),
    })
    .default({ mode: 'train' }),

  /**
   * Mineable-trace retention consent (task-creator spec §10, decision D2).
   * Two independent, deliberate opt-in tiers:
   *   - `consent` ('off' default) — retain contract fields (repo,
   * The single sharing consent (mono#1714): local capture, mining, and
   * distillation happen unconditionally (they never leave the machine), and
   * `share` governs only whether a mined task is published off the box.
   * Default is false — nothing derived from work leaves the machine unless
   * the operator opts in. Env: JINN_SHARE_CONSENT. Legacy
   * `consent`/`publishConsent` (and JINN_MINEABLE_PUBLISH_CONSENT) migrate to
   * `share` at load time (only the old publish bit maps).
   */
  mineableTraces: z
    .object({
      share: z.boolean().default(false),
    })
    .default({ share: false }),

  /**
   * Manifest-keyed joined SolverNets.
   *
   * Spec: spec/2026-05-05-solvernet-creation-and-launch.md §12.
   *
   * Populated by `POST /v1/operator/join/:cid` when an operator joins a
   * launched SolverNet from the registry catalog. Keys are `manifestCid`
   * (CIDv0 / CIDv1) — the only stable identifier that maps back to a
   * launched-instance authority across launchers.
   *
   * The daemon narrows this block into runtime SolverNet registry entries on
   * restart. Legacy short-name-keyed `solverNets` blocks on operator config
   * files are auto-migrated into synthetic `legacy:<short-name>`-keyed
   * entries at load time (see `migrateLegacySolverNets`).
   */
  joinedSolverNets: z
    .record(
      z.string(),
      z.object({
        manifestCid: z.string().min(1),
        name: z.string().optional(),
        contract: z
          .object({
            id: z.string().min(1),
            version: z.string().min(1),
          })
          .optional(),
        roles: z
          .array(z.enum(['solver', 'evaluator']))
          .min(1, 'each joined SolverNet must enable at least one role'),
        harness: HarnessNameSchema.optional(),
        model: z.string().optional(),
        // Provider route (issue #1243): a named provider (string) or a custom
        // OpenAI-compatible endpoint object. Optional — legacy `{model}`-only
        // entries are backfilled at load time (see `backfillJoinedProviders`).
        provider: z
          .union([
            z.string().trim().min(1),
            z.object({
              name: z.string().trim().min(1),
              baseUrl: z.string().trim().min(1).optional(),
              authVar: z.string().trim().min(1).optional(),
            }),
          ])
          .optional(),
        plugins: z.array(z.string()).default([]),
        disabledDefaultPlugins: z.array(z.string()).default([]),
      }),
    )
    .optional(),

  /**
   * Config shape v2 (stage-1 cutover, `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md`
   * Task 1). Additive keys written *beside* `joinedSolverNets` by the boot
   * migration (Task 3) — legacy keys survive until stage 5. All three are
   * optional so an unmigrated config file still parses.
   */
  configShapeVersion: z.literal(CONFIG_SHAPE_VERSION).optional(),
  claimPolicy: ClaimPolicyConfigSchema.optional(),
  executionWiring: z.array(ExecutionWiringConfigEntrySchema).optional(),
  posting: z.array(PostingConfigEntrySchema).optional(),

  /**
   * Dark shape-v2 native sections (one-swap M1, umbrella #2461,
   * DR-2026-08-05). The config surface the swap's native machinery reads,
   * landed ahead of the machinery itself and consumed by nothing today.
   *
   * All optional and absent-tolerant, matching the stage-1 keys above: an
   * operator who runs none of the native loops carries none of these keys.
   * Each section is `.strict()` in `config/native-sections.ts` so a typo
   * inside a configured section refuses instead of being silently dropped;
   * the root deliberately stays non-strict.
   *
   * These carry no network, chainId, or contract coupling — native mode on
   * mainnet is an explicit boot refusal (`assertNativeDeployment`, DR
   * decision 8), never something a config file can express as a fallback.
   * Enablement semantics (including `evaluator.enabled`) belong to M2's mode
   * selection: on the pre-swap daemon these keys are inert, so a stray
   * `enabled: true` annotates nothing and refuses nothing.
   *
   * No env overrides — a dark surface has nothing to override. Env vars are
   * added by the milestone that gives a key runtime meaning.
   */
  evaluator: NativeEvaluatorConfigSchema.optional(),
  identityStores: NativeIdentityStoresConfigSchema.optional(),
  trustRootsPath: NativeTrustRootsPathSchema.optional(),
  trustPolicyGenesisDigest: NativeTrustPolicyGenesisDigestSchema.optional(),
  finality: NativeFinalityConfigSchema.optional(),

  /**
   * One-swap M2 (umbrella #2461, DR-2026-08-05) — the four keys the native machinery needs that
   * M1's dark surface did not carry, plus the flip switch itself.
   *
   * `compositionMode` selects which composition the ONE fleet daemon assembles. **Absent means
   * legacy**, and so does an explicit `'legacy'`; M2 lands the native assembly dark and Wave 3's
   * deploy PR is the change that sets this key. Native mode is additionally gated at boot by
   * `assertNativeDeployment` (testnet + the pinned `BASE_SEPOLIA_TODAY` deployment only) — native
   * on mainnet is a loud refusal, never a silent legacy fallback (DR decision 8).
   *
   * The other three are the values `RoleIdentitySet.open`, the native record transport, and the
   * native solution publisher need and cannot infer: `agentIri` (M1 finding 4 — an identity-store
   * path alone cannot open a role set), `ipfs.apiUrl`, and `publicBaseUrl`. All optional; native
   * mode refuses at boot when one is missing, rather than the loader refusing a legacy operator
   * who will never run native.
   *
   * No env overrides: the flip is a config-file decision, deliberately not something an env var
   * on a restarted container can do silently.
   */
  compositionMode: NativeCompositionModeSchema.optional(),
  agentIri: NativeAgentIriSchema.optional(),
  ipfs: NativeIpfsConfigSchema.optional(),
  publicBaseUrl: NativePublicBaseUrlSchema.optional(),

  /**
   * Set true once the operator clicks "Enter dashboard" at the end of the
   * #983 guided onboarding takeover. Distinct from `joinedSolverNets` being
   * non-empty: a node can have a membership mid-onboarding (the first join
   * populates the map) yet not have finished harness/model selection. The SPA
   * gates the bootstrap→dashboard hand-off on this flag (see App.tsx), so the
   * first join no longer ejects the operator before the harness step.
   *
   * Written by POST /v1/operator/onboarding-complete (persisted to disk AND
   * mutated in-memory so GET /v1/bootstrap reflects it without a restart).
   */
  onboardingComplete: z.boolean().optional(),

  /**
   * Trusted ed25519 publishers for external harness impls. The daemon
   * refuses to load any external impl whose manifest signature is not
   * verifiable against one of these public keys.
   *
   * `publicKey` is base64-encoded raw ed25519. `label` is operator-facing
   * provenance only.
   */
  trustedImplSigners: z
    .array(
      z.object({
        alg: z.literal('ed25519'),
        publicKey: z.string(),
        label: z.string().optional(),
      }),
    )
    .optional(),

  /**
   * Restoration engine durable directories (per-task work + impl state).
   * Defaults under ~/.jinn-client/engine/. Env: JINN_ENGINE_WORKING_DIR_ROOT,
   * JINN_ENGINE_IMPL_STATE_DIR_ROOT.
   */
  engine: z
    .object({
      workingDirRoot: z.string().optional(),
      implStateDirRoot: z.string().optional(),
      /**
       * Auto-load top-3 corpus solution records for the task's solverType
       * into task.context.corpusKnowledge before each restoration harness
       * spawn (#1393). Default true; env JINN_ENGINE_KNOWLEDGE_AUTOLOAD.
       */
      knowledgeAutoload: z.boolean().optional(),
    })
    .optional(),

  /**
   * Operator-local artifact and donation configuration.
   *
   * Public testnet donation is IPFS-first: when `donation.enabled` is true,
   * scrubbed solver/evaluator artifacts are pinned to IPFS and advertised in
   * signed metadata so peers can discover, verify, and reuse them without an
   * operator-hosted public endpoint.
   *
   * `publicEndpoint`, `defaultPriceUsdc`, and `perArtifactTypePrice` are kept
   * as compatibility and future data-market fallback plumbing. They are not
   * required for the free IPFS donation path used by this release.
   *
   * Resolution precedence in `uploadArtifacts`:
   *   OUTPUTS.json `access.priceUsdc` > `perArtifactTypePrice[artifactType]`
   *   > `defaultPriceUsdc`.
   *
   * Env overrides:
   *   JINN_OPERATOR_PUBLIC_ENDPOINT
   *   JINN_OPERATOR_DEFAULT_PRICE_USDC
   *   JINN_OPERATOR_DONATION_ENABLED
   */
  operator: z
    .object({
      /** Explicit product boundary. Native never silently falls back to legacy. */
      verticalMode: z.enum(['legacy', 'native-v1']).optional(),
      /** Stable native deployment configuration. Private keys and tokens are env-only. */
      native: NativeOperatorConfigSchema.optional(),
      publicEndpoint: z.string().url().optional(),
      defaultPriceUsdc: z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string')
        .default('0'),
      perArtifactTypePrice: z
        .record(
          z.string(),
          z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string'),
        )
        .default({}),
      donation: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({ enabled: false }),
    })
    .optional(),

  /**
   * Operator-local capture configuration.
   *
   * Path C (LLM API proxy) is disabled by default. Operators opt in by
   * enabling this block and pointing ANTHROPIC_BASE_URL / OPENAI_BASE_URL at
   * the local proxy port.
   *
   * Env:
   *   JINN_CAPTURES_LLM_PROXY_ENABLED=1|true|yes
   *   JINN_CAPTURES_LLM_PROXY_PORT=7342
   */
  captures: z
    .object({
      llmProxy: z
        .object({
          enabled: z.boolean().default(false),
          port: z.number().int().positive().default(7342),
        })
        .default({ enabled: false, port: 7342 }),
      /**
       * Seller-side ML PII detection (GLiNER ONNX, in-process) applied before
       * captures (and task trajectories) are published. **On by default** for
       * publish lanes (#1973): free-prose names have no reliable regex shape.
       * Set `enabled: false` explicitly to disable. When enabled, a model-load
       * failure fails closed at the publish altitude — the trajectory is not
       * published — while the daemon's other loops keep running. Unresolved
       * flag dispositions also hold unattended publishes until
       * `jinn scrub review` resolves them.
       * Env: JINN_CAPTURES_PII_DETECTION_ENABLED=0|false|no to disable,
       *      JINN_CAPTURES_PII_DETECTION_MODEL=<hf-model-id>
       * Default model: urchade/gliner_multi_pii-v1 (ONNX via onnx-community).
       */
      piiDetection: z
        .object({
          enabled: z.boolean().default(true),
          model: z.string().optional(),
        })
        .default({ enabled: true }),
    })
    .default({ llmProxy: { enabled: false, port: 7342 }, piiDetection: { enabled: true } }),

  /**
   * Run idempotent legacy migrations at daemon startup (jinn-mono-jgp:
   * backfill `agent_id` on `complete` services that pre-date j07).
   *
   * Defaults to true — the migrations are no-ops on already-migrated
   * fleets and cheap on Base. Operators on a flaky RPC or with locked
   * funds can set this to false and run `jinn migrate-agent-id`
   * explicitly.
   *
   * Env: JINN_RUN_LEGACY_MIGRATIONS=0|1.
   */
  runLegacyMigrations: z.boolean().default(true),

  /**
   * ERC-8004 Identity Registry contract address on the configured chain.
   * Pre-rebuild config key (PR #37 cleanup left it in place). The post-rebuild
   * client (jinn-mono-j07/3zk) reads the address from
   * `client/src/erc8004/identity.ts` constants and from
   * `EarningState.identity_registry_address`; this config key is currently
   * unused but kept for backwards-compat with operator config files.
   * Env: JINN_IDENTITY_REGISTRY_ADDRESS
   */
  identityRegistryAddress: z.string().optional(),

  /**
   * ERC-8004 Validation Registry contract address on the configured chain.
   * Pre-rebuild config key. The post-rebuild client (jinn-mono-9jg) reads the
   * address from `client/src/erc8004/addresses.ts:VALIDATION_REGISTRY_ADDRESSES`;
   * this config key is currently unused but kept for backwards-compat.
   * Env: JINN_VALIDATION_REGISTRY_ADDRESS
   */
  validationRegistryAddress: z.string().optional(),

  /**
   * Whether to enable the read-only reputation surface (query-time flag).
   * Pre-rebuild config key. The post-rebuild client (jinn-mono-2ff/yg4) is
   * always constructed when `agent_id` is set; this flag is currently unused
   * but kept for backwards-compat.
   * Env: JINN_REPUTATION_ENABLED
   */
  reputationEnabled: z.boolean().default(false),

  /**
   * Per-credential daily spend caps (USD). Keys are credential identifiers
   * (e.g. `'anthropic:api-key'`); values are positive numbers representing
   * the maximum USD spend per day for that credential.
   *
   * `JINN_SPEND_CAP_USD` (env-only, consumed directly by the spend-budget
   * subsystem in Task 9) is tracked for provenance in TRACKED_ENV_VARS below
   * but is NOT a config-file field and has no entry in this schema.
   */
  spendCaps: z.record(z.string(), z.number().positive()).optional(),

  /**
   * Operator-local SolverPlugin trust state.
   *
   * `blockedCids` is the list of plug-in CIDs the operator has chosen to
   * refuse to load — populated by `jinn solver-plugins block <cid>` and read
   * at daemon startup. The block list complements the on-chain
   * `giveFeedback(score=0)` write (which is the public-trust signal); the
   * local list is the operator's own refusal to execute, applied even when
   * the network write fails. File-managed only — no env override.
   *
   * See spec/2026-05-26-117-design.md "Failure modes" and "Local-only effects".
   */
  solverPlugins: z
    .object({
      blockedCids: z.array(z.string()).default([]),
    })
    .default({ blockedCids: [] }),

  /**
   * Commit-echo harvest loop (task-creator v0). When enabled, the daemon scans
   * configured local git clones for fix-shaped commits and admits minted tasks.
   *
   * `sources` selects which harvest sources the loop mines each tick — absent
   * ⇒ `['commits']`, so existing configs behave identically. `'sessions'`
   * mines locally-captured task-creator sessions (local retention is
   * unconditional per mono#1714; whether a mined task is published off the box
   * is gated by `mineableTraces.share`, see above). Env: JINN_HARVEST_SOURCES
   * (comma-separated).
   */
  harvest: z
    .object({
      enabled: z.boolean().default(false),
      intervalMs: z.number().int().positive().default(60 * 60 * 1000),
      limitPerRepo: z.number().int().positive().default(3),
      /** Max session-echo records mined per harvest tick (sibling of limitPerRepo). */
      limitPerTick: z.number().int().positive().default(3),
      publish: z.boolean().default(true),
      repos: z
        .array(
          z.object({
            path: z.string().min(1),
            /** GitHub `owner/repo`; inferred from `git remote` when omitted. */
            repo: z.string().min(1).optional(),
            remote: z.string().optional(),
            /**
             * Operator-approved G0b recipe plus its published, attested
             * environment binding. Parsed strictly by the harvest adapter.
             */
            explicitRecipe: z.unknown().optional(),
          }),
        )
        .default([]),
      sources: z.array(z.enum(['commits', 'sessions'])).default(['commits']),
    })
    .default({
      enabled: false,
      intervalMs: 60 * 60 * 1000,
      limitPerRepo: 3,
      limitPerTick: 3,
      publish: true,
      repos: [],
      sources: ['commits'],
    }),
});

const DEFAULT_ENGINE = {
  workingDirRoot: join(homedir(), '.jinn-client', 'engine', 'work'),
  implStateDirRoot: join(homedir(), '.jinn-client', 'engine', 'impl-state'),
} as const;

/**
 * JinnConfig with rpcUrl guaranteed to be resolved (never undefined) and tasks
 * with id always assigned.
 *
 * `rpcUrl` is the head of the fallback chain (the slot-0 URL) and is kept as
 * a `string` for display continuity — the ~30 places that log/display
 * `config.rpcUrl` (provenance, error formatting, `[main] daemon starting on …`)
 * keep working unchanged. The full chain lives in `rpcUrls: readonly string[]`,
 * which is what `buildFallbackTransport()` consumes. Same shape for the L1
 * (ethereum) and optional archive/proof variants.
 */
export type JinnConfig = Omit<
  z.infer<typeof JinnConfigSchema>,
  | 'rpcUrl'
  | 'archiveRpcUrl'
  | 'tasks'
  | 'engine'
> & {
  rpcUrl: string;
  rpcUrls: readonly string[];
  archiveRpcUrl?: string;
  archiveRpcUrls?: readonly string[];
  tasks: Task[];
  engine: { workingDirRoot: string; implStateDirRoot: string; knowledgeAutoload: boolean };
};

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_DIR = join(homedir(), '.jinn-client');
export const DEFAULT_CONFIG_PATH = join(DEFAULT_DIR, 'config.json');

/**
 * Default discovery indexer for Base Sepolia testnet daemons — the
 * privately-operated Ponder instance (jinn-mono-280n.4). Operators override
 * via `discovery.url` / `JINN_DISCOVERY_URL`, or pin `discovery.mode: 'onchain'`
 * for RPC-only. No mainnet default yet (the public mainnet RPC can't sustain the
 * historical sync — see ponder.config.ts).
 */
export const DEFAULT_TESTNET_DISCOVERY_URL = 'https://jinn-indexer-production.up.railway.app';

/**
 * Default fallback chain for the L2 measurement chain (Base Sepolia, chain-id
 * 84532) on testnet. Originally a two-provider chain (AC2 of issue #592);
 * widened to ≥5 distinct free providers per issue #911 so a default-config
 * daemon tolerates a single-provider quota cliff (the Tenderly shared-quota
 * cliff of 2026-05-24) without an operator key.
 *   slot 0 — `https://base-sepolia.publicnode.com` (#835 no-auth primary,
 *     50k-block getLogs cap, no shared-quota cliff).
 *   slot 1 — `https://base-sepolia-rpc.publicnode.com`
 *   slot 2 — `https://base-sepolia.drpc.org`
 *   slot 3 — `https://base-sepolia.gateway.tenderly.co`
 *   slot 4 — `https://sepolia.base.org` (free public Coinbase endpoint,
 *     2k-block cap; last-resort backup, stays last).
 * Operators are encouraged to prepend a paid primary key (Alchemy, Tenderly,
 * etc.) via `rpcUrl` config or `JINN_RPC_URL` / `BASE_SEPOLIA_RPC_URL` env.
 * All five endpoints live-verified to return chain-id 84532 (#911).
 */
export const DEFAULT_TESTNET_RPC_URLS: readonly string[] = [
  'https://base-sepolia.publicnode.com',
  'https://base-sepolia-rpc.publicnode.com',
  'https://base-sepolia.drpc.org',
  'https://base-sepolia.gateway.tenderly.co',
  'https://sepolia.base.org',
];

/**
 * Default fallback chain for the L2 measurement chain (Base mainnet, chain-id
 * 8453). ≥5 distinct free providers per issue #911.
 *   slot 0 — `https://mainnet.base.org` (free public Coinbase endpoint).
 */
export const DEFAULT_MAINNET_RPC_URLS: readonly string[] = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
  'https://base.drpc.org',
  'https://1rpc.io/base',
  'https://base.meowrpc.com',
];


export type ConfigLoadErrorCode =
  | 'config_file_not_found'
  | 'config_json_invalid'
  | 'tasks_file_not_found'
  | 'tasks_json_invalid'
  | 'config_invalid';

export class ConfigLoadError extends Error {
  readonly code: ConfigLoadErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ConfigLoadErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ConfigLoadError';
    this.code = code;
    this.details = details;
  }
}

// ── Loader ──────────────────────────────────────────────────────────────────

interface LegacySolverNetEntry {
  enabled?: boolean;
  solverType?: string;
  roles?: Array<'solving' | 'evaluating' | 'launching' | string>;
  harness?: string;
  model?: string;
  plugins?: unknown[];
  taskGenerator?: unknown;
}

/**
 * Parse a legacy `<id>.<version>` solverType string into `{id, version}`.
 * Falls back to `{ id: fallbackId, version: 'v1' }` when the string lacks a
 * dot or terminates in one — this happens only on hand-edited operator
 * configs and keeps the migration loud-but-non-fatal.
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

/**
 * Translate any legacy short-name-keyed `solverNets` block on the raw parsed
 * config into manifest-keyed `joinedSolverNets` entries with synthetic
 * `legacy:<short-name>` keys.
 *
 * This is the auto-migration path for operators upgrading past issue #421.
 * The runtime claim filter remains manifest-digest gated, so synthetic-keyed
 * entries don't change task eligibility — they exist purely so the diagnostic
 * surfaces (Overview SOLVING-ON eyebrow, prediction-operator-status) keep
 * showing the operator's previous SolverNets until they re-join via the SPA.
 *
 * Returns the number of legacy entries migrated. Idempotent — calling on an
 * already-migrated raw config is a no-op.
 *
 * @param raw — the JSON-parsed config file contents (mutated in place).
 */
export function migrateLegacySolverNets(raw: Record<string, unknown>): number {
  const legacy = raw['solverNets'];
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return 0;
  }
  const entries = Object.entries(legacy as Record<string, unknown>);
  if (entries.length === 0) {
    delete raw['solverNets'];
    return 0;
  }

  const joined = (typeof raw['joinedSolverNets'] === 'object' && raw['joinedSolverNets'] !== null && !Array.isArray(raw['joinedSolverNets']))
    ? (raw['joinedSolverNets'] as Record<string, unknown>)
    : {};

  let migrated = 0;
  for (const [name, entryRaw] of entries) {
    if (!entryRaw || typeof entryRaw !== 'object') continue;
    const entry = entryRaw as LegacySolverNetEntry;
    const syntheticKey = `legacy:${name}`;
    // Do not overwrite a pre-existing joinedSolverNets entry under the same key.
    if (joined[syntheticKey] !== undefined) continue;

    const contract = parseSolverTypeRef(entry.solverType, name);
    const rolesIn = Array.isArray(entry.roles) && entry.roles.length > 0
      ? entry.roles
      : ['solving'];
    const roles: Array<'solver' | 'evaluator'> = [];
    for (const r of rolesIn) {
      if (r === 'solving') roles.push('solver');
      else if (r === 'evaluating') roles.push('evaluator');
      // 'launching' (and any other unknown role) is dropped — operator config
      // no longer carries the launcher role per spec §11.
    }
    if (roles.length === 0) roles.push('solver');

    joined[syntheticKey] = {
      manifestCid: syntheticKey,
      name,
      contract,
      roles: Array.from(new Set(roles)),
      ...(typeof entry.harness === 'string' ? { harness: entry.harness } : {}),
      ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
      // Stamp the OpenRouter provider first-class when the migrated model is
      // OpenRouter-shaped (issue #1243) so the synthetic entry matches what a
      // fresh join would persist and the adapter routes without inference.
      ...(typeof entry.model === 'string' && isOpenRouterModelId(entry.model)
        ? { provider: 'openrouter' as const }
        : {}),
      plugins: Array.isArray(entry.plugins) ? entry.plugins : [],
      disabledDefaultPlugins: [],
    };
    migrated += 1;
  }

  if (Object.keys(joined).length > 0) {
    raw['joinedSolverNets'] = joined;
  }
  delete raw['solverNets'];
  return migrated;
}

/**
 * Backfill `provider: 'openrouter'` onto legacy `joinedSolverNets` entries that
 * carry an OpenRouter-shaped `model` id but no `provider` (issue #1243). A
 * v0.1.6 config only persisted `{ model }` and relied on the adapter inferring
 * the provider from the id shape at runtime; stamping it here makes the route
 * first-class so pre-provider configs migrate silently.
 *
 * Mutates `merged` in place. Idempotent — entries that already carry a
 * `provider`, or whose `model` is absent / not OpenRouter-shaped, are untouched.
 * Returns the number of entries backfilled.
 */
export function backfillJoinedProviders(merged: Record<string, unknown>): number {
  const joined = merged['joinedSolverNets'];
  if (!joined || typeof joined !== 'object' || Array.isArray(joined)) return 0;
  let backfilled = 0;
  for (const entry of Object.values(joined as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (e['provider'] !== undefined) continue;
    if (!isOpenRouterModelId(e['model'] as string | undefined)) continue;
    e['provider'] = 'openrouter';
    backfilled += 1;
  }
  return backfilled;
}

let lastConfigMigrationReport: ConfigMigrationReport | undefined;

/** The shape-v2 auto-migration report from the most recent `loadConfig` call, if it migrated. Task 4 reads it. */
export function getLastConfigMigrationReport(): ConfigMigrationReport | undefined {
  return lastConfigMigrationReport;
}

/**
 * Load config with resolution: env > config file > defaults.
 *
 * @param configPath — explicit config file path (e.g. from --config flag).
 *   Falls back to ~/.jinn-client/config.json if it exists.
 */
export function loadConfig(configPath?: string): JinnConfig {
  // 1. Load config file (if any)
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;
  let fileValues: Record<string, unknown> = {};

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf-8');
    try {
      fileValues = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw new ConfigLoadError(
        'config_json_invalid',
        `Invalid JSON in config file: ${filePath}`,
        {
          path: filePath,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    console.error(`[config] Loaded ${filePath}`);
  } else if (configPath) {
    throw new ConfigLoadError('config_file_not_found', `Config file not found: ${configPath}`, {
      path: configPath,
    });
  }

  // 2. Apply env var overrides
  const env = process.env;
  const merged: Record<string, unknown> = { ...fileValues };

  if (env['JINN_NETWORK'])           merged.network = env['JINN_NETWORK'];
  if (env['JINN_EARNING_DIR'])       merged.earningDir = env['JINN_EARNING_DIR'];
  if (env['JINN_DB_PATH'])           merged.dbPath = env['JINN_DB_PATH'];
  if (env['JINN_SWE_REBENCH_V2_STATE_DIR']) {
    merged.sweRebenchV2StateDir = env['JINN_SWE_REBENCH_V2_STATE_DIR'];
  }
  if (env['JINN_POLL_INTERVAL_MS'])  merged.pollIntervalMs = parseInt(env['JINN_POLL_INTERVAL_MS'], 10);
  if (env['JINN_REWARD_CLAIM_INTERVAL_MS'] !== undefined) {
    merged.rewardClaimIntervalMs = parseInt(env['JINN_REWARD_CLAIM_INTERVAL_MS'], 10);
  }
  if (env['JINN_BALANCE_TOPUP_INTERVAL_MS']) merged.balanceTopupIntervalMs = Number.parseInt(env['JINN_BALANCE_TOPUP_INTERVAL_MS'], 10);
  if (env['JINN_EVICTION_CHECK_INTERVAL_MS']) merged.evictionCheckIntervalMs = Number.parseInt(env['JINN_EVICTION_CHECK_INTERVAL_MS'], 10);
  if (env['JINN_CHECKPOINT_INTERVAL_MS'] !== undefined) {
    merged.checkpointIntervalMs = Number.parseInt(env['JINN_CHECKPOINT_INTERVAL_MS'], 10);
  }
  if (env['JINN_TASK_DISCOVERY_FROM_BLOCK'] !== undefined) {
    merged.taskDiscoveryOnchainFromBlock = Number.parseInt(env['JINN_TASK_DISCOVERY_FROM_BLOCK'], 10);
  }
  if (env['JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS'] !== undefined) {
    merged.taskDiscoveryAllowedTaskIds = env['JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS']
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }
  if (env['JINN_API_PORT'])          merged.apiPort = parseInt(env['JINN_API_PORT'], 10);
  if (env['JINN_API_BIND_HOST'])     merged.apiBindHost = env['JINN_API_BIND_HOST'];
  if (env['JINN_CLAUDE_PATH'])       merged.claudePath = env['JINN_CLAUDE_PATH'];
  if (env['JINN_CLAUDE_MODEL'])      merged.claudeModel = env['JINN_CLAUDE_MODEL'];
  if (env['JINN_HERMES_PATH'])       merged.hermesPath = env['JINN_HERMES_PATH'];
  if (env['JINN_HERMES_MODEL'])      merged.hermesModel = env['JINN_HERMES_MODEL'];
  if (env['JINN_HERMES_PROVIDER'])   merged.hermesProvider = env['JINN_HERMES_PROVIDER'];
  if (env['JINN_HERMES_BASE_URL'])   merged.hermesBaseUrl = env['JINN_HERMES_BASE_URL'];
  if (env['JINN_HERMES_DOCTOR_TIMEOUT_MS']) {
    merged.hermesDoctorTimeoutMs = parseInt(env['JINN_HERMES_DOCTOR_TIMEOUT_MS'], 10);
  }
  if (env['JINN_CODEX_PATH'])        merged.codexPath = env['JINN_CODEX_PATH'];
  if (env['JINN_CODEX_DOCTOR_TIMEOUT_MS']) {
    merged.codexDoctorTimeoutMs = parseInt(env['JINN_CODEX_DOCTOR_TIMEOUT_MS'], 10);
  }
  if (env['JINN_RUNTIME_MODE'])      merged.runtimeMode = env['JINN_RUNTIME_MODE'];
  if (env['JINN_PEERS'])             merged.peers = env['JINN_PEERS'];
  // Discovery block env overrides
  if (env['JINN_DISCOVERY_MODE'] || env['JINN_DISCOVERY_URL'] || env['JINN_DISCOVERY_FALLBACK'] !== undefined) {
    const prevDiscovery = typeof merged['discovery'] === 'object' && merged['discovery'] !== null
      ? (merged['discovery'] as Record<string, unknown>)
      : {};
    const fallbackRaw = env['JINN_DISCOVERY_FALLBACK'];
    const fallbackToOnchain = fallbackRaw !== undefined
      ? !(['0', 'false', 'no'].includes(fallbackRaw.trim().toLowerCase()))
      : undefined;
    // A URL only makes sense in http mode — when the operator points
    // JINN_DISCOVERY_URL at a host but doesn't say JINN_DISCOVERY_MODE,
    // default mode to 'http' so the URL is actually consulted (and isn't
    // silently dropped by the on-chain default in createDiscoveryAPI).
    // `fallbackToOnchain` is NOT defaulted on here (since the 2026-05-23
    // substrate incident): silent fall-through hides indexer outages and
    // storms shared RPC. Operators opt in via JINN_DISCOVERY_FALLBACK=1 or
    // the config file when they want it.
    const inferredHttp = !!env['JINN_DISCOVERY_URL'] && !env['JINN_DISCOVERY_MODE'] && !prevDiscovery['mode'];
    const mode = env['JINN_DISCOVERY_MODE'] ?? (inferredHttp ? 'http' : undefined);
    const resolvedFallback = fallbackToOnchain;
    merged['discovery'] = {
      ...prevDiscovery,
      ...(mode ? { mode } : {}),
      ...(env['JINN_DISCOVERY_URL'] ? { url: env['JINN_DISCOVERY_URL'] } : {}),
      ...(resolvedFallback !== undefined ? { fallbackToOnchain: resolvedFallback } : {}),
    };
  }
  if (env['JINN_NODE_ENDPOINT'])     merged.nodeEndpoint = env['JINN_NODE_ENDPOINT'];
  if (env['JINN_IPFS_REGISTRY_URL']) merged.ipfsRegistryUrl = env['JINN_IPFS_REGISTRY_URL'];
  if (env['JINN_IPFS_GATEWAY_URL'])  merged.ipfsGatewayUrl = env['JINN_IPFS_GATEWAY_URL'];
  if (env['JINN_TESTNET_L2_DEPLOYMENT']) merged.testnetL2DeploymentPath = env['JINN_TESTNET_L2_DEPLOYMENT'];
  if (env['JINN_TESTNET_TOKEN_DEPLOYMENT']) merged.testnetL2TokenDeploymentPath = env['JINN_TESTNET_TOKEN_DEPLOYMENT'];
  if (env['JINN_TESTNET_MECH_DEPLOYMENT']) merged.testnetMechDeploymentPath = env['JINN_TESTNET_MECH_DEPLOYMENT'];
  if (env['JINN_WATCHDOG_AUTO_RESTART'] !== undefined) {
    const v = env['JINN_WATCHDOG_AUTO_RESTART'].trim().toLowerCase();
    merged.watchdogAutoRestart = v === '1' || v === 'true' || v === 'yes';
  }
  if (env['JINN_STAKING_MODE'])           merged.stakingMode = env['JINN_STAKING_MODE'];
  if (env['JINN_TARGET_SERVICES'])    merged.targetServices = parseInt(env['JINN_TARGET_SERVICES'], 10);

  if (env['JINN_DEBUG'] !== undefined) {
    const v = env['JINN_DEBUG'].trim().toLowerCase();
    merged.debug = v === '1' || v === 'true' || v === 'yes';
  }

  if (env['JINN_RUN_LEGACY_MIGRATIONS'] !== undefined) {
    const v = env['JINN_RUN_LEGACY_MIGRATIONS'].trim().toLowerCase();
    merged.runLegacyMigrations =
      !(v === '0' || v === 'false' || v === 'no' || v === '');
  }

  if (env['JINN_MASTER_ETH_DAILY_WEI']) {
    merged.masterEthDailyEstimateWei = env['JINN_MASTER_ETH_DAILY_WEI'].trim();
  }
  if (env['JINN_MIN_EOA_GAS_WEI']) {
    merged.minEoaGasWei = env['JINN_MIN_EOA_GAS_WEI'].trim();
  }
  if (env['JINN_MIN_SAFE_ETH_WEI']) {
    merged.minSafeEthWei = env['JINN_MIN_SAFE_ETH_WEI'].trim();
  }
  if (env['JINN_FAUCET_DAILY_TOPUP_CAP'] !== undefined) {
    merged.faucetDailyTopupCap = parseInt(env['JINN_FAUCET_DAILY_TOPUP_CAP'], 10);
  }
  if (env['JINN_FAUCET_TOPUP_COOLDOWN_MS'] !== undefined) {
    merged.faucetTopupCooldownMs = parseInt(env['JINN_FAUCET_TOPUP_COOLDOWN_MS'], 10);
  }
  if (env['JINN_HARVEST_ENABLED'] !== undefined) {
    const v = env['JINN_HARVEST_ENABLED'].trim().toLowerCase();
    const enabled = v === '1' || v === 'true' || v === 'yes';
    merged.harvest = {
      ...(typeof merged.harvest === 'object' && merged.harvest ? merged.harvest : {}),
      enabled,
    };
  }
  if (env['JINN_HARVEST_REPOS']) {
    const paths = env['JINN_HARVEST_REPOS'].split(',').map((s) => s.trim()).filter(Boolean);
    merged.harvest = {
      ...(typeof merged.harvest === 'object' && merged.harvest ? merged.harvest : {}),
      repos: paths.map((path) => {
        const [repoPath, repo] = path.split(':');
        return repo ? { path: repoPath!, repo } : { path: repoPath! };
      }),
    };
  }
  if (env['JINN_HARVEST_INTERVAL_MS']) {
    merged.harvest = {
      ...(typeof merged.harvest === 'object' && merged.harvest ? merged.harvest : {}),
      intervalMs: parseInt(env['JINN_HARVEST_INTERVAL_MS'], 10),
    };
  }
  if (env['JINN_HARVEST_SOURCES']) {
    const sources = env['JINN_HARVEST_SOURCES'].split(',').map((s) => s.trim()).filter(Boolean);
    merged.harvest = {
      ...(typeof merged.harvest === 'object' && merged.harvest ? merged.harvest : {}),
      sources,
    };
  }
  // Single sharing consent (mono#1714). JINN_SHARE_CONSENT is authoritative;
  // the legacy JINN_MINEABLE_PUBLISH_CONSENT still maps to `share` for one
  // release (only the old publish bit ever meant "a task may leave").
  if (env['JINN_SHARE_CONSENT'] !== undefined || env['JINN_MINEABLE_PUBLISH_CONSENT'] !== undefined) {
    const truthy = (v: string) => ['1', 'true', 'yes'].includes(v.trim().toLowerCase());
    const share =
      env['JINN_SHARE_CONSENT'] !== undefined
        ? truthy(env['JINN_SHARE_CONSENT'])
        : truthy(env['JINN_MINEABLE_PUBLISH_CONSENT'] as string);
    merged.mineableTraces = {
      ...(typeof merged.mineableTraces === 'object' && merged.mineableTraces ? merged.mineableTraces : {}),
      share,
    };
  }

  // Legacy `JINN_PREDICTION_V1_*` env vars are no longer recognised. Their
  // values now live in the launched-record's generator-config block per
  // spec/2026-05-05-solvernet-creation-and-launch.md (Decision 5 + Task 14)
  // — set them through the SolverNet config API instead.

  if (env['JINN_IDENTITY_REGISTRY_ADDRESS'])   merged.identityRegistryAddress = env['JINN_IDENTITY_REGISTRY_ADDRESS'];
  if (env['JINN_VALIDATION_REGISTRY_ADDRESS']) merged.validationRegistryAddress = env['JINN_VALIDATION_REGISTRY_ADDRESS'];
  if (env['JINN_REPUTATION_ENABLED'] !== undefined) {
    const rv = env['JINN_REPUTATION_ENABLED'].trim().toLowerCase();
    merged.reputationEnabled = rv === '1' || rv === 'true' || rv === 'yes';
  }

  if (
    env['JINN_OPERATOR_PUBLIC_ENDPOINT'] ||
    env['JINN_OPERATOR_DEFAULT_PRICE_USDC'] ||
    env['JINN_OPERATOR_DONATION_ENABLED'] !== undefined
  ) {
    const prevOp = typeof merged['operator'] === 'object' && merged['operator'] !== null
      ? (merged['operator'] as Record<string, unknown>)
      : {};
    const prevDonation = typeof prevOp['donation'] === 'object' && prevOp['donation'] !== null
      ? (prevOp['donation'] as Record<string, unknown>)
      : {};
    const donationEnabled = env['JINN_OPERATOR_DONATION_ENABLED'] !== undefined
      ? ['1', 'true', 'yes'].includes(env['JINN_OPERATOR_DONATION_ENABLED'].trim().toLowerCase())
      : undefined;
    merged['operator'] = {
      ...prevOp,
      ...(env['JINN_OPERATOR_PUBLIC_ENDPOINT']
        ? { publicEndpoint: env['JINN_OPERATOR_PUBLIC_ENDPOINT'] }
        : {}),
      ...(env['JINN_OPERATOR_DEFAULT_PRICE_USDC']
        ? { defaultPriceUsdc: env['JINN_OPERATOR_DEFAULT_PRICE_USDC'] }
        : {}),
      ...(donationEnabled !== undefined
        ? { donation: { ...prevDonation, enabled: donationEnabled } }
        : {}),
    };
  }

  if (
    env['JINN_CAPTURES_LLM_PROXY_ENABLED'] !== undefined ||
    env['JINN_CAPTURES_LLM_PROXY_PORT'] !== undefined ||
    env['JINN_CAPTURES_PII_DETECTION_ENABLED'] !== undefined ||
    env['JINN_CAPTURES_PII_DETECTION_MODEL'] !== undefined
  ) {
    const prevCaptures = typeof merged['captures'] === 'object' && merged['captures'] !== null
      ? (merged['captures'] as Record<string, unknown>)
      : {};
    const prevProxy = typeof prevCaptures['llmProxy'] === 'object' && prevCaptures['llmProxy'] !== null
      ? (prevCaptures['llmProxy'] as Record<string, unknown>)
      : {};
    const prevPii = typeof prevCaptures['piiDetection'] === 'object' && prevCaptures['piiDetection'] !== null
      ? (prevCaptures['piiDetection'] as Record<string, unknown>)
      : {};
    const enabled = env['JINN_CAPTURES_LLM_PROXY_ENABLED'] !== undefined
      ? ['1', 'true', 'yes'].includes(env['JINN_CAPTURES_LLM_PROXY_ENABLED'].trim().toLowerCase())
      : undefined;
    const piiEnabled = env['JINN_CAPTURES_PII_DETECTION_ENABLED'] !== undefined
      ? ['1', 'true', 'yes'].includes(env['JINN_CAPTURES_PII_DETECTION_ENABLED'].trim().toLowerCase())
      : undefined;
    merged['captures'] = {
      ...prevCaptures,
      llmProxy: {
        ...prevProxy,
        ...(enabled !== undefined ? { enabled } : {}),
        ...(env['JINN_CAPTURES_LLM_PROXY_PORT']
          ? { port: Number.parseInt(env['JINN_CAPTURES_LLM_PROXY_PORT'], 10) }
          : {}),
      },
      piiDetection: {
        ...prevPii,
        ...(piiEnabled !== undefined ? { enabled: piiEnabled } : {}),
        ...(env['JINN_CAPTURES_PII_DETECTION_MODEL']
          ? { model: env['JINN_CAPTURES_PII_DETECTION_MODEL'] }
          : {}),
      },
    };
  }

  if (
    env['JINN_ENGINE_WORKING_DIR_ROOT'] ||
    env['JINN_ENGINE_IMPL_STATE_DIR_ROOT'] ||
    env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] !== undefined
  ) {
    const prev = typeof merged['engine'] === 'object' && merged['engine'] !== null
      ? (merged['engine'] as Record<string, unknown>)
      : {};
    merged['engine'] = {
      ...prev,
      ...(env['JINN_ENGINE_WORKING_DIR_ROOT'] ? { workingDirRoot: env['JINN_ENGINE_WORKING_DIR_ROOT'] } : {}),
      ...(env['JINN_ENGINE_IMPL_STATE_DIR_ROOT'] ? { implStateDirRoot: env['JINN_ENGINE_IMPL_STATE_DIR_ROOT'] } : {}),
      ...(env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] !== undefined
        ? { knowledgeAutoload: ['1', 'true', 'yes'].includes(env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'].trim().toLowerCase()) }
        : {}),
    };
  }

  // JINN_STATE_DIR: single volume-aware root. Runs AFTER all per-key env
  // overrides above are applied into `merged` and BEFORE safeParse — so a
  // still-`undefined` per-key value means neither file nor env set it. Per-key
  // precedence: explicit (file or env, already in `merged`) > <stateDir>/<subdir>
  // > legacy default (filled by the schema / engine assembly when still absent).
  // workingDirRoot is deliberately NOT derived — it stays ephemeral.
  const stateDir = env['JINN_STATE_DIR']
    ?? (typeof merged['stateDir'] === 'string' ? (merged['stateDir'] as string) : undefined);
  if (stateDir) {
    merged['stateDir'] = stateDir;
    if (merged['earningDir'] === undefined) merged['earningDir'] = join(stateDir, 'earning');
    if (merged['dbPath'] === undefined) merged['dbPath'] = join(stateDir, 'jinn.db');
    if (merged['sweRebenchV2StateDir'] === undefined) {
      merged['sweRebenchV2StateDir'] = join(stateDir, 'swe-rebench-v2');
    }
    const engineObj = (typeof merged['engine'] === 'object' && merged['engine'] !== null)
      ? (merged['engine'] as Record<string, unknown>)
      : {};
    if (engineObj['implStateDirRoot'] === undefined) {
      engineObj['implStateDirRoot'] = join(stateDir, 'engine', 'impl-state');
      merged['engine'] = engineObj;
    }
  }

  const resolvedNetwork = merged.network === 'mainnet' ? 'mainnet' : 'testnet';

  // Testnet default: point discovery at the privately-operated Ponder indexer
  // (jinn-mono-280n.4), unless the operator has set their own `discovery` block.
  //
  // `fallbackToOnchain` is NOT defaulted on (since the 2026-05-23 substrate
  // incident): silent fall-through to direct eth_getLogs hides indexer outages
  // and turns every daemon into its own indexer, which storms shared RPC
  // quota and can take the indexer down. Operators opt in explicitly when
  // they need it (typically only when self-hosting an RPC with generous
  // getLogs quotas).
  //
  // Only fill fields the operator left absent — never overwrite an
  // operator-set `url` / `mode` / `fallbackToOnchain`. A bare
  // `discovery: { url: '...' }` (or `JINN_DISCOVERY_URL` alone) keeps the
  // operator's URL and gets `mode: 'http'` defaulted in (a URL is only
  // meaningful in http mode).
  const explicitDiscoveryMode = (typeof merged['discovery'] === 'object' && merged['discovery'] !== null
    && typeof (merged['discovery'] as { mode?: unknown }).mode === 'string');
  if (resolvedNetwork === 'testnet' && !explicitDiscoveryMode) {
    const existing = typeof merged['discovery'] === 'object' && merged['discovery'] !== null
      ? (merged['discovery'] as { mode?: string; url?: string; fallbackToOnchain?: boolean })
      : undefined;
    merged['discovery'] = {
      ...(existing ?? {}),
      mode: existing?.mode ?? 'http',
      url: existing?.url ?? DEFAULT_TESTNET_DISCOVERY_URL,
      ...(existing?.fallbackToOnchain !== undefined
        ? { fallbackToOnchain: existing.fallbackToOnchain }
        : {}),
    };
  }

  // Keep the legacy BASE_RPC_URL override for Base mainnet only. Testnet must
  // not silently inherit a mainnet RPC from client/.env during bootstrap.
  if (env['JINN_RPC_URL']) {
    merged.rpcUrl = env['JINN_RPC_URL'];
  } else if (resolvedNetwork === 'testnet') {
    if (env['BASE_SEPOLIA_RPC_URL']) {
      merged.rpcUrl = env['BASE_SEPOLIA_RPC_URL'];
    }
  } else if (env['BASE_RPC_URL']) {
    merged.rpcUrl = env['BASE_RPC_URL'];
  }
  if (env['JINN_ARCHIVE_RPC_URL']) {
    merged.archiveRpcUrl = env['JINN_ARCHIVE_RPC_URL'];
  }

  // tasks from env points to a JSON file
  if (env['JINN_TASKS']) {
    const tasksPath = env['JINN_TASKS'];
    if (!existsSync(tasksPath)) {
      throw new ConfigLoadError(
        'tasks_file_not_found',
        `JINN_TASKS file not found: ${tasksPath}`,
        { path: tasksPath },
      );
    }
    try {
      merged.tasks = JSON.parse(readFileSync(tasksPath, 'utf-8'));
    } catch (error) {
      throw new ConfigLoadError(
        'tasks_json_invalid',
        `Invalid JSON in JINN_TASKS file: ${tasksPath}`,
        {
          path: tasksPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  // Auto-migrate any legacy short-name-keyed `solverNets` block into
  // `joinedSolverNets` with synthetic `legacy:<name>` keys. Operators upgrade
  // without an explicit action; the warning surfaces the migration so they
  // know to re-join via the SPA when they want a real manifest CID. See
  // spec/2026-05-25-retire-legacy-solvernets-config.md and issue #421.
  const migratedCount = migrateLegacySolverNets(merged);
  if (migratedCount > 0) {
    console.warn(
      `[config] Migrated ${migratedCount} legacy solverNets ${migratedCount === 1 ? 'entry' : 'entries'} to joinedSolverNets. ` +
      'Open Operator > SolverNets in the dashboard to re-join via the registry ' +
      '(replaces the synthetic legacy:* keys with real manifest CIDs).'
    );
  }
  // Persist whenever the on-disk file carried a legacy `solverNets` block, even
  // when every entry already had a `legacy:*` counterpart (migratedCount === 0):
  // `migrateLegacySolverNets` deletes the block in-memory unconditionally, so
  // gating the persist on migratedCount would leave the stale block on disk
  // forever and re-trigger prediction code paths every boot (issue #445).
  // Re-reads the raw file (never the env-merged object) so transient env
  // overrides are not baked in; best-effort, and a no-op on already-clean files.
  if ('solverNets' in fileValues) {
    persistLegacySolverNetsMigration(filePath);
  }

  // Migrate legacy `mineableTraces.{consent,publishConsent}` → single `share`
  // (mono#1714, one release). Only the old publish bit ever meant "a task may
  // leave the machine"; the tier-1 retention bit is discarded (retention is now
  // unconditional). Env-set `share` (above) wins over the legacy file keys.
  if (typeof merged.mineableTraces === 'object' && merged.mineableTraces) {
    const mt = merged.mineableTraces as Record<string, unknown>;
    if (!('share' in mt) && ('publishConsent' in mt || 'consent' in mt)) {
      merged.mineableTraces = { share: mt['publishConsent'] === true };
    }
    // A stray legacy `consent`/`publishConsent` alongside `share` is dropped by
    // the schema's non-strict parse — no explicit reshape needed.
  }

  // Backfill `provider: 'openrouter'` onto legacy `{model}`-only joined entries
  // whose model id is OpenRouter-shaped (issue #1243). Runs after the legacy
  // migration so synthetic `legacy:*` entries are covered too. In-memory only —
  // the on-disk config re-persists provider first-class on the operator's next
  // join via the SPA; a load-time-only backfill keeps existing files loading.
  backfillJoinedProviders(merged);

  // Auto-migrate joined SolverNets / launched records into the stage-1
  // shape-v2 keys (`claimPolicy`, `executionWiring`, `posting`). Additive,
  // atomic, idempotent (stage-1 contract 4) — safe to call on every boot. A
  // read-only mount degrades to a warning, matching
  // `persistLegacySolverNetsMigration` above. See
  // docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md Task 3.
  try {
    const report = migrateConfigShapeV2({ configPath: filePath });
    if (report.migrated) {
      const migratedRaw = existsSync(filePath)
        ? (JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>)
        : {};
      merged['configShapeVersion'] = CONFIG_SHAPE_VERSION;
      merged['claimPolicy'] = migratedRaw['claimPolicy'];
      merged['executionWiring'] = migratedRaw['executionWiring'];
      merged['posting'] = migratedRaw['posting'];
      lastConfigMigrationReport = report;
    }
  } catch (error) {
    console.warn(`[config] shape-v2 migration skipped: ${String(error)}`);
  }

  // 3. Validate
  const result = JinnConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigLoadError(
      'config_invalid',
      'Invalid config.',
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    );
  }

  // 4. Resolve rpcUrl default based on network (if not explicitly set).
  // Testnet default per AC2 (issue #592) is a two-provider fallback chain:
  //   slot 0 — base-sepolia.publicnode.com (50k-block getLogs cap, no quota)
  //   slot 1 — sepolia.base.org (free, 2k-block cap; last-resort backup)
  // Publicnode is no-auth, no shared-key quota cliff (avoids the Tenderly
  // shared-quota cliff of 2026-05-24 that took out every default-config
  // daemon at once). See #554 + the NetworkSection.tsx "shared RPC" panel for
  // the operator-facing pitch to bring their own key. The sibling Ethereum L1
  // default (DEFAULT_TESTNET_ETHEREUM_RPC_URLS above) is publicnode-headed —
  // this keeps the two L1/L2 defaults symmetric. Both chains ship ≥5 free
  // providers per issue #911.
  const parsed = result.data;
  const usesLegacyWiring = (parsed.executionWiring ?? []).some((entry) => (
    entry.harness.length > 0
    || entry.model.length > 0
    || entry.plugins.length > 0
    || entry.credentialRef.length > 0
    || entry.legacyManifestDigest !== undefined
  ));
  if (usesLegacyWiring) recordPhaseDTransitionUse('legacy-wiring-config-field');
  const defaultRpcUrls: readonly string[] = parsed.network === 'testnet'
    ? DEFAULT_TESTNET_RPC_URLS
    : DEFAULT_MAINNET_RPC_URLS;

  const rpcUrlsResolved = parsed.rpcUrl !== undefined
    ? parseRpcUrls(parsed.rpcUrl)
    : [...defaultRpcUrls];
  const archiveRpcUrlsResolved = parsed.archiveRpcUrl !== undefined
    ? parseRpcUrls(parsed.archiveRpcUrl)
    : undefined;

  // Strip the union-typed (string | string[]) RPC fields from `parsed` — the
  // returned shape carries the resolved head URL plus a `*Urls` array instead.
  const {
    rpcUrl: _rpcUrl,
    archiveRpcUrl: _archiveRpcUrl,
    ...rest
  } = parsed;

  return {
    ...rest,
    rpcUrl: rpcUrlsResolved[0]!,
    rpcUrls: rpcUrlsResolved,
    ...(archiveRpcUrlsResolved
      ? { archiveRpcUrl: archiveRpcUrlsResolved[0]!, archiveRpcUrls: archiveRpcUrlsResolved }
      : {}),
    // parseTask assigns a UUID to any entry missing an id
    tasks: parsed.tasks.map(parseTask),
    engine: {
      workingDirRoot: parsed.engine?.workingDirRoot ?? DEFAULT_ENGINE.workingDirRoot,
      implStateDirRoot: parsed.engine?.implStateDirRoot ?? DEFAULT_ENGINE.implStateDirRoot,
      knowledgeAutoload: parsed.engine?.knowledgeAutoload ?? true,
    },
  };
}

/**
 * Get the config file path from --config CLI arg, if provided.
 */
export function getConfigPathFromArgs(argv: string[] = process.argv): string | undefined {
  const idx = argv.indexOf('--config');
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : undefined;
}

/**
 * Persist the legacy-solverNets migration to disk. Re-reads the RAW config file
 * — never the env-merged object, which would bake transient env overrides such
 * as JINN_RPC_URL into the file — runs migrateLegacySolverNets on that copy, and
 * writes the pruned shape back. Best-effort. See issue #445.
 */
function persistLegacySolverNetsMigration(filePath: string): void {
  if (!existsSync(filePath)) return; // pure-env config, no on-disk file → nothing to prune
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    if (raw['solverNets'] === undefined) return; // already pruned → no write, keeps restarts byte-stable
    migrateLegacySolverNets(raw); // mutates raw in place (deletes solverNets, sets joinedSolverNets)
    writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  } catch (err) {
    // A read-only config mount degrades to in-memory-only migration rather than
    // crashing boot.
    console.warn(
      `[config] Could not persist legacy solverNets migration to ${filePath} ` +
      `(${err instanceof Error ? err.message : String(err)}); continuing with in-memory migration only.`,
    );
  }
}

/**
 * Merge one top-level value into the operator config file. Used by local setup
 * flows that discover a durable setting after the daemon has already started.
 */
export function persistTopLevelConfigValue(
  key: string,
  value: unknown,
  configPath?: string,
): string {
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;
  let current: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    current = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } else {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  current[key] = value;
  writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`, 'utf-8');
  return filePath;
}

// ── Config provenance ────────────────────────────────────────────────────────

/**
 * Env var names that map to JinnConfig fields (excluding password and
 * security-sensitive vars that must never be surfaced even redacted).
 *
 * The list mirrors the `merged.*` assignments in `loadConfig` above.
 * JINN_PASSWORD is intentionally absent — never list it.
 */
const TRACKED_ENV_VARS = [
  'JINN_NETWORK',
  'JINN_STATE_DIR',
  'JINN_EARNING_DIR',
  'JINN_DB_PATH',
  'JINN_POLL_INTERVAL_MS',
  'JINN_REWARD_CLAIM_INTERVAL_MS',
  'JINN_CHECKPOINT_INTERVAL_MS',
  'JINN_BALANCE_TOPUP_INTERVAL_MS',
  'JINN_API_PORT',
  'JINN_API_BIND_HOST',
  'JINN_CLAUDE_PATH',
  'JINN_CLAUDE_MODEL',
  'JINN_HERMES_PATH',
  'JINN_HERMES_MODEL',
  'JINN_HERMES_PROVIDER',
  'JINN_HERMES_BASE_URL',
  'JINN_HERMES_DOCTOR_TIMEOUT_MS',
  'JINN_RUNTIME_MODE',
  'JINN_PEERS',
  'JINN_DISCOVERY_MODE',
  'JINN_DISCOVERY_URL',
  'JINN_DISCOVERY_FALLBACK',
  'JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS',
  'JINN_NODE_ENDPOINT',
  'JINN_IPFS_REGISTRY_URL',
  'JINN_IPFS_GATEWAY_URL',
  'JINN_TESTNET_L2_DEPLOYMENT',
  'JINN_TESTNET_TOKEN_DEPLOYMENT',
  'JINN_TESTNET_MECH_DEPLOYMENT',
  'JINN_WATCHDOG_AUTO_RESTART',
  'JINN_STAKING_MODE',
  'JINN_TARGET_SERVICES',
  'JINN_DEBUG',
  'JINN_RUN_LEGACY_MIGRATIONS',
  'JINN_MASTER_ETH_DAILY_WEI',
  'JINN_MIN_EOA_GAS_WEI',
  'JINN_MIN_SAFE_ETH_WEI',
  'JINN_FAUCET_DAILY_TOPUP_CAP',
  'JINN_FAUCET_TOPUP_COOLDOWN_MS',
  'JINN_IDENTITY_REGISTRY_ADDRESS',
  'JINN_VALIDATION_REGISTRY_ADDRESS',
  'JINN_REPUTATION_ENABLED',
  'JINN_RPC_URL',
  'BASE_RPC_URL',
  'BASE_SEPOLIA_RPC_URL',
  'JINN_ARCHIVE_RPC_URL',
  'JINN_TASKS',
  'JINN_ENGINE_WORKING_DIR_ROOT',
  'JINN_ENGINE_IMPL_STATE_DIR_ROOT',
  'JINN_ENGINE_KNOWLEDGE_AUTOLOAD',
  'JINN_SWE_REBENCH_V2_STATE_DIR',
  'JINN_OPERATOR_PUBLIC_ENDPOINT',
  'JINN_OPERATOR_DEFAULT_PRICE_USDC',
  'JINN_OPERATOR_DONATION_ENABLED',
  'JINN_CAPTURES_LLM_PROXY_ENABLED',
  'JINN_CAPTURES_LLM_PROXY_PORT',
  'JINN_BUILD_COMMIT',
  'JINN_SPEND_CAP_USD',
] as const;

export interface ConfigProvenance {
  /** Resolved config file path, or null if only defaults were used. */
  configPath: string | null;
  /** Whether a config file was found and loaded. */
  configLoaded: boolean;
  /** Resolved network. */
  network: 'mainnet' | 'testnet';
  /** Resolved earning state directory. */
  earningDir: string;
  /** Resolved SQLite database path. */
  dbPath: string;
  /** Resolved runtime mode, or null if auto-detected. */
  runtimeMode: string | null;
  /**
   * Env vars that were set and contributed to the resolved config.
   * Values are always `"set"` — never the actual value.
   * JINN_PASSWORD is never listed here.
   */
  envOverrides: Record<string, 'set'>;
}

/**
 * Build a structured provenance block describing how the config was resolved.
 *
 * Pass the same `configPath` you passed to `loadConfig`, and the resulting
 * `JinnConfig`. The helper inspects `process.env` to discover which tracked
 * env vars were set; it never reads their values.
 *
 * @param configPath — the explicit config file path passed to `loadConfig`,
 *   or undefined if the default path was used.
 * @param config — the resolved `JinnConfig` returned by `loadConfig`.
 * @param env — defaults to `process.env`; inject in tests.
 */
export function buildConfigProvenance(
  configPath: string | undefined,
  config: JinnConfig,
  env: NodeJS.ProcessEnv = process.env,
): ConfigProvenance {
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;
  const configLoaded = existsSync(filePath);

  const envOverrides: Record<string, 'set'> = {};
  for (const name of TRACKED_ENV_VARS) {
    if (env[name] !== undefined) {
      envOverrides[name] = 'set';
    }
  }

  return {
    configPath: configLoaded ? filePath : null,
    configLoaded,
    network: config.network,
    earningDir: config.earningDir,
    dbPath: config.dbPath,
    runtimeMode: config.runtimeMode ?? null,
    envOverrides,
  };
}
