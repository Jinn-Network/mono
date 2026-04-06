/**
 * Config loader for jinn-client.
 *
 * Resolution order (highest priority wins):
 *   1. Environment variables (JINN_*, BASE_RPC_URL)
 *   2. Config file (--config flag or ~/.jinn-client/config.json)
 *   3. Built-in defaults
 *
 * JINN_PASSWORD is always env-only — never written to config files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// ── Schema ──────────────────────────────────────────────────────────────────

const DesiredStateSchema = z.object({
  id: z.string(),
  description: z.string().min(1),
  context: z.record(z.unknown()).optional(),
});

export const JinnConfigSchema = z.object({
  /** Base RPC endpoint */
  rpcUrl: z.string().default('https://mainnet.base.org'),

  /** Earning state directory */
  earningDir: z.string().default(join(homedir(), '.jinn-client', 'earning')),

  /** SQLite database path */
  dbPath: z.string().default(join(homedir(), '.jinn-client', 'jinn.db')),

  /** Chain poll interval in ms */
  pollIntervalMs: z.number().int().positive().default(5000),

  /** HTTP API port */
  apiPort: z.number().int().positive().default(7331),

  /** Path to claude CLI binary */
  claudePath: z.string().default('claude'),

  /** Model for restoration/evaluation agent */
  claudeModel: z.string().default('claude-haiku-4-5-20251001'),

  /** Comma-separated or array of peer URLs */
  peers: z.union([
    z.string().transform(s => s.split(',').filter(Boolean)),
    z.array(z.string()),
  ]).default([]),

  /** The Graph subgraph URL for artifact discovery */
  subgraphUrl: z.string().optional(),

  /** This node's public HTTP endpoint (for 8004 registration) */
  nodeEndpoint: z.string().optional(),

  /** Desired states to create and restore */
  desiredStates: z.array(DesiredStateSchema).default([
    {
      id: 'health-check',
      description: 'The service is running and participating in the Jinn protocol loop.',
    },
  ]),

  /** IPFS upload endpoint */
  ipfsRegistryUrl: z.string().default('https://registry.autonolas.tech'),

  /** IPFS read endpoint */
  ipfsGatewayUrl: z.string().default('https://gateway.autonolas.tech'),
});

export type JinnConfig = z.infer<typeof JinnConfigSchema>;

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_DIR = join(homedir(), '.jinn-client');
const DEFAULT_CONFIG_PATH = join(DEFAULT_DIR, 'config.json');

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
    fileValues = JSON.parse(raw) as Record<string, unknown>;
    console.log(`[config] Loaded ${filePath}`);
  } else if (configPath) {
    // Explicit path was given but doesn't exist — that's an error
    console.error(`Fatal: config file not found: ${configPath}`);
    process.exit(1);
  }

  // 2. Apply env var overrides
  const env = process.env;
  const merged: Record<string, unknown> = { ...fileValues };

  if (env['BASE_RPC_URL'])           merged.rpcUrl = env['BASE_RPC_URL'];
  if (env['JINN_RPC_URL'])           merged.rpcUrl = env['JINN_RPC_URL'];
  if (env['JINN_EARNING_DIR'])       merged.earningDir = env['JINN_EARNING_DIR'];
  if (env['JINN_DB_PATH'])           merged.dbPath = env['JINN_DB_PATH'];
  if (env['JINN_POLL_INTERVAL_MS'])  merged.pollIntervalMs = parseInt(env['JINN_POLL_INTERVAL_MS'], 10);
  if (env['JINN_API_PORT'])          merged.apiPort = parseInt(env['JINN_API_PORT'], 10);
  if (env['JINN_CLAUDE_PATH'])       merged.claudePath = env['JINN_CLAUDE_PATH'];
  if (env['JINN_CLAUDE_MODEL'])      merged.claudeModel = env['JINN_CLAUDE_MODEL'];
  if (env['JINN_PEERS'])             merged.peers = env['JINN_PEERS'];
  if (env['JINN_SUBGRAPH_URL'])      merged.subgraphUrl = env['JINN_SUBGRAPH_URL'];
  if (env['JINN_NODE_ENDPOINT'])     merged.nodeEndpoint = env['JINN_NODE_ENDPOINT'];
  if (env['JINN_IPFS_REGISTRY_URL']) merged.ipfsRegistryUrl = env['JINN_IPFS_REGISTRY_URL'];
  if (env['JINN_IPFS_GATEWAY_URL'])  merged.ipfsGatewayUrl = env['JINN_IPFS_GATEWAY_URL'];

  // desiredStates from env points to a JSON file
  if (env['JINN_DESIRED_STATES']) {
    const statesPath = env['JINN_DESIRED_STATES'];
    if (!existsSync(statesPath)) {
      console.error(`Fatal: JINN_DESIRED_STATES file not found: ${statesPath}`);
      process.exit(1);
    }
    merged.desiredStates = JSON.parse(readFileSync(statesPath, 'utf-8'));
  }

  // 3. Validate
  const result = JinnConfigSchema.safeParse(merged);
  if (!result.success) {
    console.error('Fatal: invalid config:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

/**
 * Get the config file path from --config CLI arg, if provided.
 */
export function getConfigPathFromArgs(argv: string[] = process.argv): string | undefined {
  const idx = argv.indexOf('--config');
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : undefined;
}
