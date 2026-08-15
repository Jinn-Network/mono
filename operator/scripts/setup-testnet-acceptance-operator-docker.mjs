#!/usr/bin/env node
/**
 * One-time Docker acceptance operator setup.
 *
 * Prepares the dedicated Docker acceptance environment: generates the stable
 * mounted config file, builds the local acceptance image, initializes the
 * operator volume, prints funding requirements, and optionally polls bootstrap
 * until at least one service reaches `complete`.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorClientConfig,
  resolveAcceptanceRpcUrl,
} from './lib/acceptance-operator-config.mjs';
import {
  buildDockerComposeEnv,
  dockerAcceptanceComposeEnvPath,
  dockerAcceptanceConfigPath,
  dockerAcceptanceWorkspaceRoot,
  formatEnvFile,
  resolveDockerAcceptanceBaseEnv,
} from './lib/docker-acceptance.mjs';
import { PASSWORD_RESOLUTION_HINT, resolveAcceptancePassword } from './lib/resolve-acceptance-password.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const repoRoot = join(clientRoot, '..');
const composeFile = join(clientRoot, 'docker-compose.acceptance.yml');
const composeService = 'jinn-acceptance-daemon';
const RUN_ID_SETUP = 'operator-setup';

function fail(message) {
  console.error(`setup-testnet-acceptance-operator: ${message}`);
  process.exit(1);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJsonStdout(stdout, label) {
  const trimmed = stdout.trim();
  if (!trimmed) fail(`${label}: empty stdout`);
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{') && !lines[i].startsWith('[')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning
    }
  }
  fail(`${label}: stdout did not contain JSON`);
}

function runProcess(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function expectOk(result, label) {
  if ((result.status ?? 1) !== 0) {
    console.error(result.stderr ?? '');
    fail(`${label} failed with exit ${result.status ?? 1}`);
  }
}

function composeArgs(composeEnvPath, extra) {
  return ['compose', '--env-file', composeEnvPath, '-f', composeFile, ...extra];
}

function readGitCommit() {
  const result = runProcess('git', ['rev-parse', 'HEAD'], { cwd: clientRoot });
  if ((result.status ?? 1) !== 0) {
    return 'unknown';
  }
  return (result.stdout ?? '').trim() || 'unknown';
}

function printClaudeAuthNextSteps() {
  console.log(`
One-time Claude auth for Docker acceptance:
  claude setup-token
  # add the printed token to operator/.env.acceptance:
  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

Do not edit .acceptance/docker-compose.env directly; setup and release scripts regenerate it.

Alternative one-time auth-volume login:
  docker compose --env-file .acceptance/docker-compose.env \\
    -f docker-compose.acceptance.yml \\
    run --rm -it --entrypoint claude ${composeService} auth login

Next:
  yarn release:testnet-acceptance
`);
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function printHelp() {
  console.log(`Usage: node scripts/setup-testnet-acceptance-operator-docker.mjs [options]

Creates the dedicated Docker acceptance environment used by:
  yarn release:testnet-acceptance

Steps:
  1. Merge operator/.env + operator/.env.acceptance + process env
  2. Write .acceptance/config.json and .acceptance/docker-compose.env
  3. Build the local Docker acceptance image
  4. Initialize the operator state in the dedicated data volume
  5. Print fund-requirements
  6. With --bootstrap, retry bootstrap until a service is complete

Options:
  --bootstrap                   Poll bootstrap after fund-requirements
  --bootstrap-timeout-ms <ms>   Max wait with --bootstrap (default: 3600000)
  --poll-ms <ms>                Delay between bootstrap retries (default: 15000)
  --image-tag <tag>             Local image tag (default: from .env.acceptance or jinn-client:acceptance-local)
  --help
`);
}

async function main() {
  const parsed = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      bootstrap: { type: 'boolean', default: false },
      'bootstrap-timeout-ms': { type: 'string' },
      'poll-ms': { type: 'string' },
      'image-tag': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    printHelp();
    return;
  }

  const baseEnv = resolveDockerAcceptanceBaseEnv({ clientRoot, env: process.env });
  const password = resolveAcceptancePassword(baseEnv);
  if (!password) {
    fail(
      `Missing keystore password. ${PASSWORD_RESOLUTION_HINT} You can also put it in operator/.env.acceptance.`,
    );
  }
  const gateEnv = { ...baseEnv, JINN_PASSWORD: password };
  const rpcUrl = resolveAcceptanceRpcUrl(gateEnv);
  if (!rpcUrl) {
    fail('Set JINN_TESTNET_ACCEPTANCE_RPC_URL or BASE_SEPOLIA_RPC_URL before setup.');
  }

  const workspaceRoot = dockerAcceptanceWorkspaceRoot(clientRoot);
  const configPath = dockerAcceptanceConfigPath(clientRoot);
  const composeEnvPath = dockerAcceptanceComposeEnvPath(clientRoot);
  const imageTag = parsed.values['image-tag'] ?? baseEnv['JINN_ACCEPTANCE_IMAGE'] ?? 'jinn-client:acceptance-local';
  const buildCommit = process.env['JINN_BUILD_COMMIT'] ?? readGitCommit();
  ensureDir(workspaceRoot);

  const config = buildOperatorClientConfig({
    rpcUrl,
    clientHome: '/data',
    runIdSuffix: RUN_ID_SETUP,
    env: gateEnv,
  });
  writeJson(configPath, config);

  const composeEnv = buildDockerComposeEnv({
    clientRoot,
    env: gateEnv,
    imageTag,
    configPath,
  });
  writeFileSync(composeEnvPath, formatEnvFile(composeEnv), { encoding: 'utf8', mode: 0o600 });
  chmodSync(composeEnvPath, 0o600);

  const runCompose = (args) => runProcess('docker', composeArgs(composeEnvPath, args), { cwd: clientRoot });
  const runJinnRaw = (args) => runCompose(['run', '--rm', '-T', '--no-deps', composeService, ...args]);
  const runJinn = (args) => runJinnRaw([...args, '--config', '/acceptance/config.json']);

  expectOk(runCompose(['down', '--remove-orphans']), 'docker compose down');

  const build = runProcess('docker', [
    'build',
    '--build-arg',
    `JINN_BUILD_COMMIT=${buildCommit}`,
    '-f',
    'operator/Dockerfile',
    '-t',
    imageTag,
    '.',
  ], { cwd: repoRoot });
  expectOk(build, 'docker build');

  expectOk(runCompose(['config']), 'docker compose config');
  runProcess('docker', ['volume', 'create', composeEnv.JINN_ACCEPTANCE_DATA_VOLUME], { cwd: clientRoot });
  runProcess('docker', ['volume', 'create', composeEnv.JINN_ACCEPTANCE_CLAUDE_VOLUME], { cwd: clientRoot });

  const initResult = runJinnRaw(['init', '--json']);
  expectOk(initResult, 'jinn init');
  const initPayload = parseJsonStdout(initResult.stdout ?? '', 'init');
  console.log('setup-testnet-acceptance-operator:docker keystore ready');
  console.log(`  master: ${initPayload.master}`);
  console.log(`  earningDir: ${initPayload.keystoreDir ?? '/data/earning'}`);
  console.log(`  config: ${configPath}`);

  const fundResult = runJinn(['fund-requirements', '--json']);
  expectOk(fundResult, 'fund-requirements');
  const fundPayload = parseJsonStdout(fundResult.stdout ?? '', 'fund-requirements');
  console.log('setup-testnet-acceptance-operator:docker fund-requirements');
  console.log(JSON.stringify(fundPayload, null, 2));

  if (!fundPayload.satisfied) {
    console.log(`
Fund the listed addresses on Base Sepolia, then either:
  yarn setup:testnet-acceptance-operator --bootstrap
or:
  docker compose --env-file .acceptance/docker-compose.env \\
    -f docker-compose.acceptance.yml \\
    run --rm -T ${composeService} bootstrap --json --config /acceptance/config.json
`);
  }

  if (!parsed.values.bootstrap) {
    printClaudeAuthNextSteps();
    return;
  }

  const timeoutMs = Number.parseInt(parsed.values['bootstrap-timeout-ms'] ?? '3600000', 10) || 3_600_000;
  const pollMs = Number.parseInt(parsed.values['poll-ms'] ?? '15000', 10) || 15_000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const bootstrapResult = runJinn(['bootstrap', '--json']);
    if ((bootstrapResult.status ?? 1) === 0) {
      const payload = parseJsonStdout(bootstrapResult.stdout ?? '', 'bootstrap');
      const hasComplete = (payload.services ?? []).some((service) => service.step === 'complete');
      if (hasComplete) {
        console.log('setup-testnet-acceptance-operator:docker bootstrap complete');
        console.log(JSON.stringify(payload, null, 2));
        printClaudeAuthNextSteps();
        return;
      }
      console.log(`[waiting] bootstrap ok but no complete service yet: ${JSON.stringify(payload)}`);
    } else if ((bootstrapResult.status ?? 1) === 10) {
      let message = 'funding_required';
      try {
        const line = (bootstrapResult.stdout ?? '')
          .trim()
          .split('\n')
          .map((line_) => line_.trim())
          .filter(Boolean)
          .pop();
        if (line) {
          const payload = JSON.parse(line);
          if (typeof payload.message === 'string') {
            message = payload.message;
          }
        }
      } catch {
        // ignore parse issues
      }
      console.log(`[waiting] ${message} (retry in ${pollMs}ms)`);
    } else {
      console.error(bootstrapResult.stderr ?? '');
      fail(`bootstrap failed with exit ${bootstrapResult.status ?? 1}`);
    }

    await sleep(pollMs);
  }

  fail('Timed out waiting for bootstrap complete; check funding / RPC / on-chain state.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
