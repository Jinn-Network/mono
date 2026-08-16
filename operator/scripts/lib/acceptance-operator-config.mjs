/**
 * Shared operator layout for real testnet acceptance + first-time setup.
 * Keep in sync with scripts/testnet-acceptance.mjs expectations.
 */

import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const ACCEPTANCE_ROOT_DIR = '.jinn-testnet-acceptance';

export function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * When operators export `HOME=$HOME/.jinn-testnet-acceptance` for ad-hoc CLI runs,
 * `os.homedir()` returns that path; joining `.jinn-testnet-acceptance` again would nest.
 */
export function defaultAcceptanceHome() {
  const h = homedir();
  if (basename(h) === ACCEPTANCE_ROOT_DIR) {
    return h;
  }
  return join(h, ACCEPTANCE_ROOT_DIR);
}

export function acceptanceClientHome(acceptanceHome) {
  return join(acceptanceHome, '.jinn-client');
}

export function acceptanceXdgPaths(acceptanceHome) {
  return {
    configHome: join(acceptanceHome, '.config'),
    dataHome: join(acceptanceHome, '.local', 'share'),
    cacheHome: join(acceptanceHome, '.cache'),
  };
}

export function resolveAcceptanceRpcUrl(env = process.env) {
  return env['JINN_TESTNET_ACCEPTANCE_RPC_URL']
    ?? env['BASE_SEPOLIA_RPC_URL']
    ?? '';
}

/**
 * Acceptance gate posts no static Tasks through daemon config. The Docker
 * gate seeds a manifest-backed prediction.v1 task and submits it from a
 * separate CLI process so the daemon must discover, claim, solve, evaluate,
 * and settle through the same Task-native path as a public operator.
 */
export function buildAcceptanceTasks(_runIdSuffix) {
  return [];
}

/**
 * @param {object} opts
 * @param {string} opts.rpcUrl
 * @param {string} opts.clientHome  Absolute path to .../.jinn-client
 * @param {string} opts.runIdSuffix  Used in desiredState ids (harness: evidence run id; setup: stable slug)
 * @param {NodeJS.ProcessEnv} opts.env
 */
export function buildOperatorClientConfig({ rpcUrl, clientHome, runIdSuffix, env }) {
  const apiPort = toInt(env['JINN_TESTNET_ACCEPTANCE_API_PORT'] ?? env['JINN_API_PORT'], 7331);
  const config = {
    network: env['JINN_TESTNET_ACCEPTANCE_NETWORK'] ?? 'testnet',
    rpcUrl,
    earningDir: join(clientHome, 'earning'),
    dbPath: join(clientHome, 'jinn.db'),
    apiPort,
    rewardClaimIntervalMs: 0,
    pollIntervalMs: toInt(env['JINN_TESTNET_ACCEPTANCE_POLL_INTERVAL_MS'], 5000),
    targetServices: toInt(env['JINN_TESTNET_ACCEPTANCE_TARGET_SERVICES'], 1),
    minEoaGasWei: env['JINN_TESTNET_ACCEPTANCE_MIN_EOA_GAS_WEI'] ?? '1000000000000000',
    minSafeEthWei: env['JINN_TESTNET_ACCEPTANCE_MIN_SAFE_ETH_WEI'] ?? '200000000000000',
    // Kept for legacy prediction.v0 ad-hoc drills; the Docker release gate
    // now drives prediction.v1 by submitting a live manifest-backed task.
    predictionV0WindowMs: toInt(env['JINN_PREDICTION_V0_WINDOW_MS'], 120_000),
    predictionV0ResolveGapMs: toInt(env['JINN_PREDICTION_V0_RESOLVE_GAP_MS'], 60_000),
    tasks: buildAcceptanceTasks(runIdSuffix),
    operator: {
      publicEndpoint: env['JINN_TESTNET_ACCEPTANCE_OPERATOR_PUBLIC_ENDPOINT']
        ?? env['JINN_OPERATOR_PUBLIC_ENDPOINT']
        ?? `http://localhost:${apiPort}`,
      defaultPriceUsdc: env['JINN_TESTNET_ACCEPTANCE_OPERATOR_DEFAULT_PRICE_USDC']
        ?? env['JINN_OPERATOR_DEFAULT_PRICE_USDC']
        ?? '0',
      perArtifactTypePrice: {},
      donation: {
        enabled: !['0', 'false', 'no'].includes(
          String(
            env['JINN_TESTNET_ACCEPTANCE_OPERATOR_DONATION_ENABLED']
              ?? env['JINN_OPERATOR_DONATION_ENABLED']
              ?? 'true',
          ).trim().toLowerCase(),
        ),
      },
    },
  };

  // Discovery: the daemon's config loader defaults testnet to the privately-
  // operated Ponder indexer with on-chain fallback (see operator/src/config.ts),
  // so an explicit block is only needed to repoint at a different host or pin
  // the RPC-only floor.
  const discoveryUrl = env['JINN_TESTNET_ACCEPTANCE_DISCOVERY_URL'];
  // A URL only makes sense with http mode; if the operator pins a URL without
  // a mode, default the mode to 'http' so the daemon's config loader doesn't
  // clobber the URL with the built-in default.
  const discoveryMode = env['JINN_TESTNET_ACCEPTANCE_DISCOVERY_MODE']
    ?? (discoveryUrl ? 'http' : undefined);
  if (discoveryUrl || discoveryMode) {
    config.discovery = {
      ...(discoveryMode ? { mode: discoveryMode } : {}),
      ...(discoveryUrl ? { url: discoveryUrl } : {}),
    };
  }

  const optionalMap = [
    ['JINN_TESTNET_ACCEPTANCE_IPFS_GATEWAY_URL', 'ipfsGatewayUrl'],
    ['JINN_TESTNET_ACCEPTANCE_IPFS_REGISTRY_URL', 'ipfsRegistryUrl'],
    ['JINN_TESTNET_ACCEPTANCE_CLAUDE_PATH', 'claudePath'],
    ['JINN_TESTNET_ACCEPTANCE_CLAUDE_MODEL', 'claudeModel'],
    ['JINN_TESTNET_ACCEPTANCE_NODE_ENDPOINT', 'nodeEndpoint'],
    ['JINN_TESTNET_ACCEPTANCE_TESTNET_L2_DEPLOYMENT', 'testnetL2DeploymentPath'],
    ['JINN_TESTNET_ACCEPTANCE_TESTNET_TOKEN_DEPLOYMENT', 'testnetL2TokenDeploymentPath'],
    ['JINN_TESTNET_ACCEPTANCE_TESTNET_MECH_DEPLOYMENT', 'testnetMechDeploymentPath'],
    ['JINN_TESTNET_ACCEPTANCE_TESTNET_STOLAS_DEPLOYMENT', 'testnetStolasDeploymentPath'],
  ];

  for (const [envKey, configKey] of optionalMap) {
    if (env[envKey]) {
      config[configKey] = env[envKey];
    }
  }

  return config;
}

/** Dev-only overrides; must not leak into packaged-install cwd (breaks relative paths). */
const STRIP_FROM_ACCEPTANCE_CHILD_ENV = [
  'JINN_TESTNET_L2_DEPLOYMENT',
  'JINN_TESTNET_TOKEN_DEPLOYMENT',
  'JINN_TESTNET_MECH_DEPLOYMENT',
  'JINN_TESTNET_STOLAS_DEPLOYMENT',
];

export function buildAcceptanceChildEnv(acceptanceHome, password, baseEnv = process.env) {
  const clientHome = acceptanceClientHome(acceptanceHome);
  const xdg = acceptanceXdgPaths(acceptanceHome);
  const stripped = { ...baseEnv };
  for (const key of STRIP_FROM_ACCEPTANCE_CHILD_ENV) {
    delete stripped[key];
  }
  return {
    ...stripped,
    HOME: acceptanceHome,
    XDG_CONFIG_HOME: xdg.configHome,
    XDG_DATA_HOME: xdg.dataHome,
    XDG_CACHE_HOME: xdg.cacheHome,
    JINN_PASSWORD: password,
    JINN_EARNING_DIR: join(clientHome, 'earning'),
    JINN_DB_PATH: join(clientHome, 'jinn.db'),
    NO_COLOR: '1',
  };
}
