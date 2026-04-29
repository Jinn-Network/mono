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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { RestorationJobSchema, parseRestorationJob } from './types/desired-state.js';
import type { RestorationJob } from './types/desired-state.js';

// ── Schema ──────────────────────────────────────────────────────────────────

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

  /** Path to claude CLI binary */
  claudePath: z.string().default('claude'),

  /** Model for restoration/evaluation agent */
  claudeModel: z.string().default('claude-haiku-4-5-20251001'),

  /**
   * How the operator runs the daemon. Set once at `jinn auth`, read by every
   * command that probes the Claude CLI or spawns a subprocess. Leaving it
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

  /** The Graph subgraph URL for artifact discovery */
  subgraphUrl: z.string().optional(),

  /** This node's public HTTP endpoint (for 8004 registration) */
  nodeEndpoint: z.string().optional(),

  /** Desired states to create and restore. Empty by default; testnet auto-intents fill the loop. */
  desiredStates: z.array(RestorationJobSchema).default([]),

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

  /** Optional Base Sepolia ClaimRegistry deployment artifact path */
  testnetClaimRegistryDeploymentPath: z.string().optional(),

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
   * Operator-controlled impl dispatch for the restorer engine.
   *
   * Wired by daemon (jinn-mono-bv5); engine consumes via RestorerImplRegistry config.
   *
   * byKind:   explicit spec.kind → impl name mapping (highest priority)
   * default:  fallback impl name when no kind-specific match is found
   * disabled: impl names to exclude from dispatch entirely
   * wrapWith: universal-wrap impl name (jinn-mono-0k2). When set AND
   *           registered + active + supports the ctx, that impl wins for
   *           every non-evaluation dispatch — bypassing byKind/default/
   *           first-match. Default ships as `'claude-code-learner'` so the
   *           learning envelope wraps every restoration kind. Operators set
   *           this to `null` (or any other registered wrapper-style impl
   *           name) to flip it off / swap it out. Evaluations always
   *           dispatch to specialists.
   */
  restorers: z
    .object({
      byKind: z.record(z.string()).optional(),
      default: z.string().optional(),
      disabled: z.array(z.string()).optional(),
      wrapWith: z.string().nullable().optional(),
    })
    .optional(),

  /**
   * Restoration engine durable directories (per-intent work + impl state).
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
});

const DEFAULT_ENGINE = {
  workingDirRoot: join(homedir(), '.jinn-client', 'engine', 'work'),
  implStateDirRoot: join(homedir(), '.jinn-client', 'engine', 'impl-state'),
} as const;

/** JinnConfig with rpcUrl guaranteed to be resolved (never undefined) and desiredStates with id always assigned. */
export type JinnConfig = Omit<z.infer<typeof JinnConfigSchema>, 'rpcUrl' | 'desiredStates' | 'engine'> & {
  rpcUrl: string;
  desiredStates: RestorationJob[];
  engine: { workingDirRoot: string; implStateDirRoot: string };
};

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_DIR = join(homedir(), '.jinn-client');
const DEFAULT_CONFIG_PATH = join(DEFAULT_DIR, 'config.json');

export type ConfigLoadErrorCode =
  | 'config_file_not_found'
  | 'config_json_invalid'
  | 'desired_states_file_not_found'
  | 'desired_states_json_invalid'
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
  if (env['JINN_EARNING_DIR'])       merged.earningDir = env['JINN_EARNING_DIR'];
  if (env['JINN_DB_PATH'])           merged.dbPath = env['JINN_DB_PATH'];
  if (env['JINN_POLL_INTERVAL_MS'])  merged.pollIntervalMs = parseInt(env['JINN_POLL_INTERVAL_MS'], 10);
  if (env['JINN_REWARD_CLAIM_INTERVAL_MS'] !== undefined) {
    merged.rewardClaimIntervalMs = parseInt(env['JINN_REWARD_CLAIM_INTERVAL_MS'], 10);
  }
  if (env['JINN_BALANCE_TOPUP_INTERVAL_MS']) merged.balanceTopupIntervalMs = Number.parseInt(env['JINN_BALANCE_TOPUP_INTERVAL_MS'], 10);
  if (env['JINN_API_PORT'])          merged.apiPort = parseInt(env['JINN_API_PORT'], 10);
  if (env['JINN_CLAUDE_PATH'])       merged.claudePath = env['JINN_CLAUDE_PATH'];
  if (env['JINN_CLAUDE_MODEL'])      merged.claudeModel = env['JINN_CLAUDE_MODEL'];
  if (env['JINN_RUNTIME_MODE'])      merged.runtimeMode = env['JINN_RUNTIME_MODE'];
  if (env['JINN_PEERS'])             merged.peers = env['JINN_PEERS'];
  if (env['JINN_SUBGRAPH_URL'])      merged.subgraphUrl = env['JINN_SUBGRAPH_URL'];
  if (env['JINN_NODE_ENDPOINT'])     merged.nodeEndpoint = env['JINN_NODE_ENDPOINT'];
  if (env['JINN_IPFS_REGISTRY_URL']) merged.ipfsRegistryUrl = env['JINN_IPFS_REGISTRY_URL'];
  if (env['JINN_IPFS_GATEWAY_URL'])  merged.ipfsGatewayUrl = env['JINN_IPFS_GATEWAY_URL'];
  if (env['JINN_TESTNET_L2_DEPLOYMENT']) merged.testnetL2DeploymentPath = env['JINN_TESTNET_L2_DEPLOYMENT'];
  if (env['JINN_TESTNET_TOKEN_DEPLOYMENT']) merged.testnetL2TokenDeploymentPath = env['JINN_TESTNET_TOKEN_DEPLOYMENT'];
  if (env['JINN_TESTNET_MECH_DEPLOYMENT']) merged.testnetMechDeploymentPath = env['JINN_TESTNET_MECH_DEPLOYMENT'];
  if (env['JINN_TESTNET_CLAIM_REGISTRY_DEPLOYMENT']) {
    merged.testnetClaimRegistryDeploymentPath = env['JINN_TESTNET_CLAIM_REGISTRY_DEPLOYMENT'];
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

  if (env['JINN_IDENTITY_REGISTRY_ADDRESS'])   merged.identityRegistryAddress = env['JINN_IDENTITY_REGISTRY_ADDRESS'];
  if (env['JINN_VALIDATION_REGISTRY_ADDRESS']) merged.validationRegistryAddress = env['JINN_VALIDATION_REGISTRY_ADDRESS'];
  if (env['JINN_REPUTATION_ENABLED'] !== undefined) {
    const rv = env['JINN_REPUTATION_ENABLED'].trim().toLowerCase();
    merged.reputationEnabled = rv === '1' || rv === 'true' || rv === 'yes';
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

  // desiredStates from env points to a JSON file
  if (env['JINN_DESIRED_STATES']) {
    const statesPath = env['JINN_DESIRED_STATES'];
    if (!existsSync(statesPath)) {
      throw new ConfigLoadError(
        'desired_states_file_not_found',
        `JINN_DESIRED_STATES file not found: ${statesPath}`,
        { path: statesPath },
      );
    }
    try {
      merged.desiredStates = JSON.parse(readFileSync(statesPath, 'utf-8'));
    } catch (error) {
      throw new ConfigLoadError(
        'desired_states_json_invalid',
        `Invalid JSON in JINN_DESIRED_STATES file: ${statesPath}`,
        {
          path: statesPath,
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
    // parseRestorationJob assigns a UUID to any entry missing an id
    desiredStates: parsed.desiredStates.map(parseRestorationJob),
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
