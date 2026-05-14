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
import { z } from 'zod';
import { TaskSchema, parseTask } from './types/task.js';
import type { Task } from './types/task.js';
import { canonicalHarnessName, CLAUDE_CODE_HARNESS } from './harnesses/names.js';

// ── Schema ──────────────────────────────────────────────────────────────────

export interface DefaultSolverNetConfig extends Record<string, unknown> {
  enabled?: boolean;
  solverType: string;
  /**
   * Operator-selected roles for this SolverNet. A non-empty subset of
   * `['solving', 'evaluating']`. Multiple roles can run concurrently — the
   * daemon enforces `disallowSolverSelfEvaluation` on-chain so the operator
   * never evaluates its own Solutions, and the on-chain
   * TaskActivityCheckerV3 keeps `solutionDeliveryWeight` and
   * `verdictDeliveryWeight` as independent additive counters.
   *
   * Launcher-side flagging is no longer expressed as an operator role —
   * launcher ownership is determined by the launched-record subsystem
   * (spec/2026-05-05-solvernet-creation-and-launch.md §11). Operator config
   * carries only the participation roles.
   *
   * Legacy `role: 'solving' | 'evaluating'` configs are auto-migrated to
   * `roles: [<role>]` by the loader (zod preprocessor on solverNets[*]).
   */
  roles?: Array<'solving' | 'evaluating'>;
  harness?: string;
  model?: string;
  plugins?: Array<string | { name?: string; source: string; version?: string }>;
  taskGenerator?: { enabled?: boolean };
}

/**
 * Default `solverNets` is empty per Decision 5 of
 * spec/2026-05-05-solvernet-creation-and-launch.md — pre-release, no
 * migration burden. Fresh installs no longer seed the `prediction` entry;
 * the operator joins SolverNets through the registry (Task 21's
 * `joinedSolverNets` block).
 */
export const DEFAULT_SOLVER_NETS: Record<string, DefaultSolverNetConfig> = {};

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
   * Base RPC endpoint.
   * Defaults to https://mainnet.base.org for 'mainnet' and
   * https://sepolia.base.org for 'testnet'. Set explicitly to override.
   */
  rpcUrl: z.string().optional(),
  archiveRpcUrl: z.string().optional(),
  /**
   * Optional L2 proof/archive RPC endpoint for canonical cross-chain canaries.
   * The daemon can use its normal rpcUrl for writes while proof construction
   * uses this endpoint for historical eth_getProof at OP dispute-game blocks.
   * Env: JINN_L2_PROOF_RPC_URL.
   */
  l2ProofRpcUrl: z.string().url().optional(),

  /** Earning state directory */
  earningDir: z.string().default(join(homedir(), '.jinn-client', 'earning')),

  /** SQLite database path */
  dbPath: z.string().default(join(homedir(), '.jinn-client', 'jinn.db')),

  /** Chain poll interval in ms */
  pollIntervalMs: z.number().int().positive().default(5000),

  /**
   * How often the daemon attempts stOLAS ExternalStakingDistributor.claim for each staked
   * fleet service (ms). Default 600000 (10 min) — well under typical checkpoint liveness windows
   * on Base while limiting RPC/gas churn. Set to 0 to disable auto-claim.
   * Env: JINN_REWARD_CLAIM_INTERVAL_MS
   */
  rewardClaimIntervalMs: z.number().int().min(0).default(600_000),

  /**
   * How often the daemon checks agent EOA and Safe balances and tops them up from the master
   * wallet when they drop below trigger thresholds (ms). Default 300000 (5 min).
   * Set to 0 to disable. Env: JINN_BALANCE_TOPUP_INTERVAL_MS
   */
  balanceTopupIntervalMs: z.number().int().min(0).default(300_000),

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
   */
  taskDiscoveryAllowedTaskIds: z.array(z.string()).optional(),

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
   * Optional deployment artifact for the v0 MVI L1 stack
   * (deployment-jinn-mvi-l1-{network}{,-fast}.json). Provides addresses for
   * JINN, Timelock, JinnGovernor, JinnDistributor, and Messenger.
   * When set the daemon enables the cross-chain JINN claim loop.
   */
  jinnMviL1DeploymentPath: z.string().optional(),

  /**
   * Optional deployment artifact for the v0 MVI L2 emitter
   * (deployment-jinn-mvi-l2-{network}.json). Provides the
   * TaskClaimEmitter address on the measurement chain (Base / Base Sepolia).
   */
  jinnMviL2DeploymentPath: z.string().optional(),

  // ── Cross-chain claim loop (Phase B / jinn-mono-7x5) ─────────────────────

  /**
   * RPC endpoint for the L1 governance chain (Ethereum / Sepolia) where the
   * JinnDistributor lives. Required when jinnDistributorAddress is set.
   * Env: JINN_ETHEREUM_RPC_URL.
   */
  ethereumRpcUrl: z.string().url().optional(),

  /**
   * Optional archive RPC endpoint for the L1 governance chain. Used for
   * historical block lookups when constructing canonical-mode proofs.
   * Env: JINN_ETHEREUM_ARCHIVE_RPC_URL.
   */
  ethereumArchiveRpcUrl: z.string().url().optional(),

  /**
   * L1 network used by the cross-chain claim loop. 'sepolia' tracks Base
   * Sepolia testnet; 'ethereum' tracks Base mainnet. Defaults to 'sepolia'
   * during Phase 1b. Env: JINN_L1_NETWORK.
   */
  jinnL1Network: z.enum(['sepolia', 'ethereum']).default('sepolia'),

  /**
   * JinnDistributor address on the L1 governance chain. Setting this enables
   * the cross-chain claim loop. When set, ethereumRpcUrl MUST also be set.
   * Resolved from jinnMviL1DeploymentPath when omitted; otherwise a manual
   * override. Env: JINN_DISTRIBUTOR_ADDRESS.
   */
  jinnDistributorAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
    .optional(),

  /**
   * TaskClaimEmitter address on the L2 measurement chain (Base / Base
   * Sepolia). Resolved from jinnMviL2DeploymentPath when omitted.
   * Env: JINN_CLAIM_EMITTER_ADDRESS.
   */
  jinnClaimEmitterAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
    .optional(),

  /**
   * Messenger address on the L1 governance chain. Resolved from
   * jinnMviL1DeploymentPath when omitted.
   * Env: JINN_MESSENGER_ADDRESS.
   */
  jinnMessengerAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
    .optional(),

  /**
   * Messenger mode driving proof construction. `mock` submits MockMessenger
   * fixtures — required for automated Sepolia burn-in (`runOnce`). `canonical`
   * builds OP-Stack storage proofs for verifier-only checks; scheduled daemon
   * ticks **skip** canonical mode (multi-day finality) — use
   * `tsx scripts/verify-canonical-canary.ts` after finality instead. Defaults
   * to `canonical`.
   * Env: JINN_MESSENGER_MODE.
   */
  jinnMessengerMode: z.enum(['canonical', 'mock']).default('canonical'),

  /**
   * How often the daemon ticks the cross-chain JINN claim loop (ms). Default
   * 3 600 000 (1 hour) — well below mainnet challenge windows while
   * minimising RPC/gas churn. Set to 0 to disable when the address is set.
   * Env: JINN_CLAIM_LOOP_INTERVAL_MS.
   */
  jinnClaimLoopIntervalMs: z.number().int().min(0).default(60 * 60 * 1000),

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
      mode: z.enum(['train', 'frozen']).default('train'),
    })
    .default({ mode: 'train' }),

  /**
   * SolverNet activation, Harness selection, and operator-configured runtime plugins.
   *
   * Each entry's `roles` is a non-empty subset of `['solving', 'evaluating']`.
   * Multiple roles can run concurrently for the same SolverNet; the
   * protocol-level `disallowSolverSelfEvaluation` flag prevents the operator
   * from evaluating its own Solutions and the on-chain
   * TaskActivityCheckerV3 tracks Solution and Verdict counters independently
   * (additive into `eligibleActivityWeight`).
   *
   * Launcher ownership lives in the launched-record subsystem
   * (spec/2026-05-05-solvernet-creation-and-launch.md §11), not in operator
   * config — there is no `'launching'` operator role. Legacy entries that
   * include `'launching'` in `roles` have it stripped by the preprocessor so
   * older config files keep loading.
   *
   * Backwards-compat: a legacy `role: 'solving' | 'evaluating'` field is
   * auto-promoted to `roles: [<role>]` by the zod preprocessor below so
   * existing `~/.jinn-client/config.json` files keep loading without an
   * operator migration step.
   */
  solverNets: z.record(z.preprocess(
    (raw) => {
      if (typeof raw !== 'object' || raw === null) return raw;
      const obj = raw as Record<string, unknown>;
      // Promote legacy `role: X` → `roles: [X]` when only the singular form
      // is provided. If both are present (mid-migration third-party config),
      // `roles` wins and `role` is dropped.
      if (Array.isArray(obj['roles']) && obj['roles'].length > 0) {
        // Drop legacy `'launching'` entries — operator config no longer
        // carries the launcher role; ownership is via launched records.
        const filteredRoles = (obj['roles'] as unknown[]).filter(
          (r) => r !== 'launching',
        );
        const { role: _legacyRole, ...rest } = obj;
        return { ...rest, roles: filteredRoles };
      }
      if (typeof obj['role'] === 'string' && (obj['role'] === 'solving' || obj['role'] === 'evaluating')) {
        const { role, ...rest } = obj;
        return { ...rest, roles: [role] };
      }
      return obj;
    },
    z.object({
      enabled: z.boolean().default(true),
      solverType: z.string(),
      roles: z.array(z.enum(['solving', 'evaluating']))
        .min(1, 'each SolverNet must enable at least one role')
        .default(['solving'])
        // Deduplicate to keep downstream consumers simple.
        .transform((arr) => Array.from(new Set(arr))),
      harness: HarnessNameSchema.default(CLAUDE_CODE_HARNESS),
      model: z.string().optional(),
      plugins: z.array(z.union([
        z.string(),
        z.object({
          name: z.string().optional(),
          source: z.string(),
          version: z.string().optional(),
        }),
      ])).default([]),
      taskGenerator: z.object({
        enabled: z.boolean().default(true),
      }).default({ enabled: true }),
    }),
  )).default(DEFAULT_SOLVER_NETS),

  /**
   * Manifest-keyed joined SolverNets (Task 21).
   *
   * Spec: spec/2026-05-05-solvernet-creation-and-launch.md §12.
   *
   * Populated by `POST /v1/operator/join/:cid` when an operator joins a
   * launched SolverNet from the registry catalog. Keys are `manifestCid`
   * (CIDv0 / CIDv1) — the only stable identifier that maps back to a
   * launched-instance authority across launchers.
   *
   * Kept structurally separate from legacy `solverNets` for now. The daemon
   * narrows this block into runtime SolverNet registry entries on restart, and
   * Task 22 collapses both branches into a single manifest-keyed shape once
   * the legacy block is fully drained.
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
        plugins: z.array(z.string()).default([]),
        disabledDefaultPlugins: z.array(z.string()).default([]),
      }),
    )
    .optional(),

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
    })
    .default({ llmProxy: { enabled: false, port: 7342 } }),

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
}).refine(
  (cfg) => !cfg.jinnDistributorAddress || !!cfg.ethereumRpcUrl,
  {
    message:
      'ethereumRpcUrl must be set when jinnDistributorAddress is configured ' +
      '(env JINN_ETHEREUM_RPC_URL or config field). The cross-chain claim loop ' +
      'cannot reach the L1 governance chain without it.',
    path: ['ethereumRpcUrl'],
  },
);

const DEFAULT_ENGINE = {
  workingDirRoot: join(homedir(), '.jinn-client', 'engine', 'work'),
  implStateDirRoot: join(homedir(), '.jinn-client', 'engine', 'impl-state'),
} as const;

/** JinnConfig with rpcUrl guaranteed to be resolved (never undefined) and tasks with id always assigned. */
export type JinnConfig = Omit<z.infer<typeof JinnConfigSchema>, 'rpcUrl' | 'tasks' | 'engine'> & {
  rpcUrl: string;
  tasks: Task[];
  engine: { workingDirRoot: string; implStateDirRoot: string };
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
  if (env['JINN_L2_PROOF_RPC_URL'])  merged.l2ProofRpcUrl = env['JINN_L2_PROOF_RPC_URL'];
  if (env['JINN_EARNING_DIR'])       merged.earningDir = env['JINN_EARNING_DIR'];
  if (env['JINN_DB_PATH'])           merged.dbPath = env['JINN_DB_PATH'];
  if (env['JINN_POLL_INTERVAL_MS'])  merged.pollIntervalMs = parseInt(env['JINN_POLL_INTERVAL_MS'], 10);
  if (env['JINN_REWARD_CLAIM_INTERVAL_MS'] !== undefined) {
    merged.rewardClaimIntervalMs = parseInt(env['JINN_REWARD_CLAIM_INTERVAL_MS'], 10);
  }
  if (env['JINN_BALANCE_TOPUP_INTERVAL_MS']) merged.balanceTopupIntervalMs = Number.parseInt(env['JINN_BALANCE_TOPUP_INTERVAL_MS'], 10);
  if (env['JINN_API_PORT'])          merged.apiPort = parseInt(env['JINN_API_PORT'], 10);
  if (env['JINN_API_BIND_HOST'])     merged.apiBindHost = env['JINN_API_BIND_HOST'];
  if (env['JINN_CLAUDE_PATH'])       merged.claudePath = env['JINN_CLAUDE_PATH'];
  if (env['JINN_CLAUDE_MODEL'])      merged.claudeModel = env['JINN_CLAUDE_MODEL'];
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
    // silently dropped by the on-chain default in createDiscoveryAPI). In that
    // inferred-http case, also default fallbackToOnchain on (http without a
    // floor is a footgun) unless JINN_DISCOVERY_FALLBACK overrides.
    const inferredHttp = !!env['JINN_DISCOVERY_URL'] && !env['JINN_DISCOVERY_MODE'] && !prevDiscovery['mode'];
    const mode = env['JINN_DISCOVERY_MODE'] ?? (inferredHttp ? 'http' : undefined);
    const resolvedFallback = fallbackToOnchain ?? (inferredHttp ? true : undefined);
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
  if (env['JINN_MVI_L1_DEPLOYMENT']) merged.jinnMviL1DeploymentPath = env['JINN_MVI_L1_DEPLOYMENT'];
  if (env['JINN_MVI_L2_DEPLOYMENT']) merged.jinnMviL2DeploymentPath = env['JINN_MVI_L2_DEPLOYMENT'];
  if (env['JINN_ETHEREUM_RPC_URL']) merged.ethereumRpcUrl = env['JINN_ETHEREUM_RPC_URL'];
  if (env['JINN_ETHEREUM_ARCHIVE_RPC_URL']) merged.ethereumArchiveRpcUrl = env['JINN_ETHEREUM_ARCHIVE_RPC_URL'];
  if (env['JINN_L1_NETWORK']) merged.jinnL1Network = env['JINN_L1_NETWORK'];
  if (env['JINN_DISTRIBUTOR_ADDRESS']) merged.jinnDistributorAddress = env['JINN_DISTRIBUTOR_ADDRESS'];
  if (env['JINN_CLAIM_EMITTER_ADDRESS']) merged.jinnClaimEmitterAddress = env['JINN_CLAIM_EMITTER_ADDRESS'];
  if (env['JINN_MESSENGER_ADDRESS']) merged.jinnMessengerAddress = env['JINN_MESSENGER_ADDRESS'];
  if (env['JINN_MESSENGER_MODE']) merged.jinnMessengerMode = env['JINN_MESSENGER_MODE'];
  if (env['JINN_CLAIM_LOOP_INTERVAL_MS'] !== undefined) {
    merged.jinnClaimLoopIntervalMs = parseInt(env['JINN_CLAIM_LOOP_INTERVAL_MS'], 10);
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
    env['JINN_CAPTURES_LLM_PROXY_PORT'] !== undefined
  ) {
    const prevCaptures = typeof merged['captures'] === 'object' && merged['captures'] !== null
      ? (merged['captures'] as Record<string, unknown>)
      : {};
    const prevProxy = typeof prevCaptures['llmProxy'] === 'object' && prevCaptures['llmProxy'] !== null
      ? (prevCaptures['llmProxy'] as Record<string, unknown>)
      : {};
    const enabled = env['JINN_CAPTURES_LLM_PROXY_ENABLED'] !== undefined
      ? ['1', 'true', 'yes'].includes(env['JINN_CAPTURES_LLM_PROXY_ENABLED'].trim().toLowerCase())
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
    };
  }

  if (env['JINN_ENGINE_WORKING_DIR_ROOT'] || env['JINN_ENGINE_IMPL_STATE_DIR_ROOT']) {
    const prev = typeof merged['engine'] === 'object' && merged['engine'] !== null
      ? (merged['engine'] as Record<string, unknown>)
      : {};
    merged['engine'] = {
      ...prev,
      ...(env['JINN_ENGINE_WORKING_DIR_ROOT'] ? { workingDirRoot: env['JINN_ENGINE_WORKING_DIR_ROOT'] } : {}),
      ...(env['JINN_ENGINE_IMPL_STATE_DIR_ROOT'] ? { implStateDirRoot: env['JINN_ENGINE_IMPL_STATE_DIR_ROOT'] } : {}),
    };
  }

  const resolvedNetwork = merged.network === 'testnet' ? 'testnet' : 'mainnet';

  // Testnet default: point discovery at the privately-operated Ponder indexer
  // (jinn-mono-280n.4), unless the operator has set their own `discovery` block.
  // The on-chain RPC floor stays as the fallback.
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
      fallbackToOnchain: existing?.fallbackToOnchain ?? true,
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

  // 4. Resolve rpcUrl default based on network (if not explicitly set)
  const parsed = result.data;
  const defaultRpcUrl = parsed.network === 'testnet'
    ? 'https://sepolia.base.org'
    : 'https://mainnet.base.org';

  return {
    ...parsed,
    rpcUrl: parsed.rpcUrl ?? defaultRpcUrl,
    // parseTask assigns a UUID to any entry missing an id
    tasks: parsed.tasks.map(parseTask),
    engine: {
      workingDirRoot: parsed.engine?.workingDirRoot ?? DEFAULT_ENGINE.workingDirRoot,
      implStateDirRoot: parsed.engine?.implStateDirRoot ?? DEFAULT_ENGINE.implStateDirRoot,
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
  'JINN_EARNING_DIR',
  'JINN_DB_PATH',
  'JINN_POLL_INTERVAL_MS',
  'JINN_REWARD_CLAIM_INTERVAL_MS',
  'JINN_BALANCE_TOPUP_INTERVAL_MS',
  'JINN_API_PORT',
  'JINN_API_BIND_HOST',
  'JINN_CLAUDE_PATH',
  'JINN_CLAUDE_MODEL',
  'JINN_RUNTIME_MODE',
  'JINN_PEERS',
  'JINN_DISCOVERY_MODE',
  'JINN_DISCOVERY_URL',
  'JINN_DISCOVERY_FALLBACK',
  'JINN_NODE_ENDPOINT',
  'JINN_IPFS_REGISTRY_URL',
  'JINN_IPFS_GATEWAY_URL',
  'JINN_TESTNET_L2_DEPLOYMENT',
  'JINN_TESTNET_TOKEN_DEPLOYMENT',
  'JINN_TESTNET_MECH_DEPLOYMENT',
  'JINN_L2_PROOF_RPC_URL',
  'JINN_MVI_L1_DEPLOYMENT',
  'JINN_MVI_L2_DEPLOYMENT',
  'JINN_ETHEREUM_RPC_URL',
  'JINN_ETHEREUM_ARCHIVE_RPC_URL',
  'JINN_L1_NETWORK',
  'JINN_DISTRIBUTOR_ADDRESS',
  'JINN_CLAIM_EMITTER_ADDRESS',
  'JINN_MESSENGER_ADDRESS',
  'JINN_MESSENGER_MODE',
  'JINN_CLAIM_LOOP_INTERVAL_MS',
  'JINN_STAKING_MODE',
  'JINN_TARGET_SERVICES',
  'JINN_DEBUG',
  'JINN_RUN_LEGACY_MIGRATIONS',
  'JINN_MASTER_ETH_DAILY_WEI',
  'JINN_MIN_EOA_GAS_WEI',
  'JINN_MIN_SAFE_ETH_WEI',
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
  'JINN_OPERATOR_PUBLIC_ENDPOINT',
  'JINN_OPERATOR_DEFAULT_PRICE_USDC',
  'JINN_OPERATOR_DONATION_ENABLED',
  'JINN_CAPTURES_LLM_PROXY_ENABLED',
  'JINN_CAPTURES_LLM_PROXY_PORT',
  'JINN_BUILD_COMMIT',
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
