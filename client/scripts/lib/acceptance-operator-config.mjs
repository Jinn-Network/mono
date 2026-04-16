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

export function buildAcceptanceDesiredStates(runIdSuffix) {
  return [
    {
      id: `release-acceptance-${runIdSuffix}-1`,
      description:
        'The Jinn client service is healthy and operational. '
        + 'Confirm the service is running by checking its status via the available tools, '
        + 'then report that the service is healthy.',
    },
    {
      id: `release-acceptance-${runIdSuffix}-2`,
      description:
        'A basic connectivity check has been performed. '
        + 'Verify the protocol tools are reachable and responsive, '
        + 'then report that connectivity is confirmed.',
    },
  ];
}

/**
 * @param {object} opts
 * @param {string} opts.rpcUrl
 * @param {string} opts.clientHome  Absolute path to .../.jinn-client
 * @param {string} opts.runIdSuffix  Used in desiredState ids (harness: evidence run id; setup: stable slug)
 * @param {NodeJS.ProcessEnv} opts.env
 */
export function buildOperatorClientConfig({ rpcUrl, clientHome, runIdSuffix, env }) {
  const config = {
    network: env['JINN_TESTNET_ACCEPTANCE_NETWORK'] ?? 'testnet',
    rpcUrl,
    earningDir: join(clientHome, 'earning'),
    dbPath: join(clientHome, 'jinn.db'),
    rewardClaimIntervalMs: 0,
    pollIntervalMs: toInt(env['JINN_TESTNET_ACCEPTANCE_POLL_INTERVAL_MS'], 5000),
    targetServices: toInt(env['JINN_TESTNET_ACCEPTANCE_TARGET_SERVICES'], 1),
    desiredStates: buildAcceptanceDesiredStates(runIdSuffix),
  };

  const optionalMap = [
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
