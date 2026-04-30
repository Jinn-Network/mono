import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { resolveAcceptanceRpcUrl, toInt } from './acceptance-operator-config.mjs';

export const DEFAULT_ACCEPTANCE_IMAGE = 'jinn-client:acceptance-local';
export const DEFAULT_ACCEPTANCE_SERVICE = 'jinn-acceptance-daemon';
export const DEFAULT_ACCEPTANCE_PROJECT_NAME = 'jinn-acceptance';
export const DEFAULT_ACCEPTANCE_DATA_VOLUME = 'jinn-acceptance-data-volume';
export const DEFAULT_ACCEPTANCE_CLAUDE_VOLUME = 'jinn-acceptance-claude-auth-volume';

function loadOptionalEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }
  return dotenv.parse(readFileSync(filePath, 'utf8'));
}

export function dockerAcceptanceWorkspaceRoot(clientRoot) {
  return join(clientRoot, '.acceptance');
}

export function dockerAcceptanceConfigPath(clientRoot) {
  return join(dockerAcceptanceWorkspaceRoot(clientRoot), 'config.json');
}

export function dockerAcceptanceComposeEnvPath(clientRoot) {
  return join(dockerAcceptanceWorkspaceRoot(clientRoot), 'docker-compose.env');
}

export function dockerAcceptanceEvidenceRoot(clientRoot) {
  return join(clientRoot, 'acceptance-runs');
}

export function resolveDockerAcceptanceBaseEnv({ clientRoot, env = process.env }) {
  return {
    ...loadOptionalEnvFile(join(clientRoot, '.env')),
    ...loadOptionalEnvFile(join(clientRoot, '.env.acceptance')),
    ...env,
  };
}

export function buildDockerComposeEnv({
  clientRoot,
  env = process.env,
  imageTag,
  configPath,
}) {
  const merged = resolveDockerAcceptanceBaseEnv({ clientRoot, env });
  const rpcUrl = resolveAcceptanceRpcUrl(merged);
  const pollIntervalMs = toInt(
    merged['JINN_TESTNET_ACCEPTANCE_POLL_INTERVAL_MS'] ?? merged['JINN_POLL_INTERVAL_MS'],
    5000,
  );
  const rewardClaimIntervalMs = toInt(
    merged['JINN_TESTNET_ACCEPTANCE_REWARD_CLAIM_INTERVAL_MS'] ?? merged['JINN_REWARD_CLAIM_INTERVAL_MS'],
    0,
  );
  const targetServices = toInt(
    merged['JINN_TESTNET_ACCEPTANCE_TARGET_SERVICES'] ?? merged['JINN_TARGET_SERVICES'],
    1,
  );

  return {
    COMPOSE_PROJECT_NAME: merged['JINN_ACCEPTANCE_PROJECT_NAME'] ?? DEFAULT_ACCEPTANCE_PROJECT_NAME,
    JINN_ACCEPTANCE_IMAGE: imageTag ?? merged['JINN_ACCEPTANCE_IMAGE'] ?? DEFAULT_ACCEPTANCE_IMAGE,
    JINN_ACCEPTANCE_DATA_VOLUME: merged['JINN_ACCEPTANCE_DATA_VOLUME'] ?? DEFAULT_ACCEPTANCE_DATA_VOLUME,
    JINN_ACCEPTANCE_CLAUDE_VOLUME: merged['JINN_ACCEPTANCE_CLAUDE_VOLUME'] ?? DEFAULT_ACCEPTANCE_CLAUDE_VOLUME,
    JINN_ACCEPTANCE_CONFIG_FILE: resolve(configPath ?? dockerAcceptanceConfigPath(clientRoot)),
    JINN_PASSWORD: merged['JINN_TESTNET_ACCEPTANCE_PASSWORD'] ?? merged['JINN_PASSWORD'] ?? '',
    JINN_RPC_URL: rpcUrl,
    JINN_NETWORK: merged['JINN_ACCEPTANCE_NETWORK'] ?? merged['JINN_NETWORK'] ?? 'testnet',
    JINN_POLL_INTERVAL_MS: String(pollIntervalMs),
    JINN_REWARD_CLAIM_INTERVAL_MS: String(rewardClaimIntervalMs),
    JINN_TARGET_SERVICES: String(targetServices),
    // Release acceptance gates on prediction.v0 cycles produced by the
    // testnet auto-intent generator (kind=prediction.v0, id prefix
    // `pred-v0-auto-…`). Leaving auto-intents enabled is required for the
    // gate to observe the protocol loop end-to-end.
    JINN_DISABLE_AUTO_INTENTS: merged['JINN_DISABLE_AUTO_INTENTS'] ?? '0',
    JINN_PREDICTION_V0_WINDOW_MS: merged['JINN_PREDICTION_V0_WINDOW_MS'] ?? '120000',
    JINN_PREDICTION_V0_RESOLVE_GAP_MS: merged['JINN_PREDICTION_V0_RESOLVE_GAP_MS'] ?? '60000',
    // Non-interactive Claude auth: output of `claude setup-token`. When set,
    // the daemon inside the container uses it directly and no keychain /
    // libsecret / browser login is required.
    CLAUDE_CODE_OAUTH_TOKEN: merged['CLAUDE_CODE_OAUTH_TOKEN'] ?? '',
    NO_COLOR: '1',
  };
}

export function hasDockerAcceptanceClaudeToken(env) {
  return typeof env?.CLAUDE_CODE_OAUTH_TOKEN === 'string' && env.CLAUDE_CODE_OAUTH_TOKEN.trim().length > 0;
}

export function dockerAcceptanceClaudeAuthRemedy() {
  return `Docker acceptance is missing Claude auth.

The generated client/.acceptance/docker-compose.env has an empty CLAUDE_CODE_OAUTH_TOKEN.
Do not edit that generated file directly; setup and release scripts rewrite it.

Durable fix:
  cd client
  cp -n .env.acceptance.example .env.acceptance
  claude setup-token
  # add the printed token to client/.env.acceptance:
  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
  yarn release:testnet-acceptance

Alternative one-time volume login:
  docker compose --env-file .acceptance/docker-compose.env \\
    -f docker-compose.acceptance.yml \\
    run --rm -it --entrypoint claude jinn-acceptance-daemon auth login`;
}

export function formatEnvFile(env) {
  return `${Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n')}\n`;
}
