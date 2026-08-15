#!/usr/bin/env node
/**
 * First-time filesystem + keystore for real testnet acceptance (same layout as
 * scripts/testnet-acceptance.mjs). Run once per machine/operator, fund, then
 * optionally --bootstrap until fleet is complete.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  defaultAcceptanceHome,
  buildOperatorClientConfig,
  buildAcceptanceChildEnv,
  acceptanceClientHome,
  acceptanceXdgPaths,
  resolveAcceptanceRpcUrl,
} from './lib/acceptance-operator-config.mjs';
import { PASSWORD_RESOLUTION_HINT, resolveAcceptancePassword } from './lib/resolve-acceptance-password.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');

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
      /* keep scanning */
    }
  }
  fail(`${label}: stdout did not contain JSON`);
}

function runYarnJinn(args, env) {
  return spawnSync('yarn', ['jinn', ...args], {
    cwd: clientRoot,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function printHelp() {
  console.log(`Usage: node scripts/setup-testnet-acceptance-operator.mjs [options]

Creates the long-lived acceptance operator tree for the legacy host-installed
acceptance harness (\`yarn release:testnet-acceptance:host\`):

  <home>/.jinn-client/config.json
  <home>/.jinn-client/earning/   (keystore via jinn init)

Steps:
  1. Write operator config.json
  2. yarn jinn init --json
  3. yarn jinn fund-requirements --json
  4. With --bootstrap: retry yarn jinn bootstrap --json until a service is complete

Required environment:
  JINN_TESTNET_ACCEPTANCE_RPC_URL or BASE_SEPOLIA_RPC_URL   Base Sepolia RPC

Keystore password: JINN_PASSWORD or JINN_TESTNET_ACCEPTANCE_PASSWORD, or
  <home>/.jinn-client/keystore-password / ~/.jinn-client/keystore-password

Options:
  --home <path>                 Acceptance HOME (default: ~/.jinn-testnet-acceptance)
  --bootstrap                   Poll bootstrap after fund-requirements
  --bootstrap-timeout-ms <ms>   Max wait with --bootstrap (default: 3600000)
  --poll-ms <ms>                Delay between bootstrap retries (default: 15000)
  --help

After a successful --bootstrap, run the harness in steady-state only; do not use
--mode fresh-state (it deletes this directory).
`);
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main() {
  const parsed = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      home: { type: 'string' },
      bootstrap: { type: 'boolean', default: false },
      'bootstrap-timeout-ms': { type: 'string' },
      'poll-ms': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    printHelp();
    return;
  }

  const env = process.env;
  const acceptanceHome = resolve(
    parsed.values.home ?? env['JINN_TESTNET_ACCEPTANCE_HOME'] ?? defaultAcceptanceHome(),
  );
  const password = resolveAcceptancePassword(env, { acceptanceHome });
  if (!password) {
    fail(`Missing keystore password. ${PASSWORD_RESOLUTION_HINT}`);
  }
  const rpcUrl = resolveAcceptanceRpcUrl(env);
  if (!rpcUrl) {
    fail('Set JINN_TESTNET_ACCEPTANCE_RPC_URL or BASE_SEPOLIA_RPC_URL to a Base Sepolia RPC endpoint.');
  }
  const clientHome = acceptanceClientHome(acceptanceHome);
  const xdg = acceptanceXdgPaths(acceptanceHome);
  const childEnv = buildAcceptanceChildEnv(acceptanceHome, password);

  ensureDir(clientHome);
  ensureDir(xdg.configHome);
  ensureDir(xdg.dataHome);
  ensureDir(xdg.cacheHome);

  const config = buildOperatorClientConfig({
    rpcUrl,
    clientHome,
    runIdSuffix: RUN_ID_SETUP,
    env,
  });
  writeJson(join(clientHome, 'config.json'), config);

  const initResult = runYarnJinn(['init', '--json'], childEnv);
  if (initResult.status !== 0) {
    console.error(initResult.stderr);
    fail(`jinn init failed with exit ${initResult.status}`);
  }
  const initPayload = parseJsonStdout(initResult.stdout, 'init');
  console.log('setup-testnet-acceptance-operator:host keystore ready');
  console.log(`  master: ${initPayload.master}`);
  console.log(`  earningDir: ${initPayload.keystoreDir ?? join(clientHome, 'earning')}`);
  console.log(`  acceptanceHome: ${acceptanceHome}`);

  const fr = runYarnJinn(['fund-requirements', '--json'], childEnv);
  if (fr.status !== 0) {
    console.error(fr.stderr);
    fail(`fund-requirements failed with exit ${fr.status}`);
  }
  const fundPayload = parseJsonStdout(fr.stdout, 'fund-requirements');
  console.log('setup-testnet-acceptance-operator:host fund-requirements');
  console.log(JSON.stringify(fundPayload, null, 2));

  if (!fundPayload.satisfied) {
    console.log(`
Fund the listed addresses on Base Sepolia, then either:
  yarn setup:testnet-acceptance-operator:host --bootstrap
or:
  HOME=${acceptanceHome} XDG_CONFIG_HOME=${xdg.configHome} \\
  XDG_DATA_HOME=${xdg.dataHome} XDG_CACHE_HOME=${xdg.cacheHome} \\
  JINN_PASSWORD=... JINN_EARNING_DIR=${join(clientHome, 'earning')} \\
  JINN_DB_PATH=${join(clientHome, 'jinn.db')} \\
  yarn jinn bootstrap --json

Faucets: https://docs.base.org/base-chain/tools/network-faucets
`);
  }

  if (!parsed.values.bootstrap) {
    console.log('setup-testnet-acceptance-operator:host done (re-run with --bootstrap after funding)');
    return;
  }

  const timeoutMs = Number.parseInt(parsed.values['bootstrap-timeout-ms'] ?? '3600000', 10) || 3_600_000;
  const pollMs = Number.parseInt(parsed.values['poll-ms'] ?? '15000', 10) || 15_000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const bs = runYarnJinn(['bootstrap', '--json'], childEnv);
    if (bs.status === 0) {
      const payload = parseJsonStdout(bs.stdout, 'bootstrap');
      const hasComplete = (payload.services ?? []).some((s) => s.step === 'complete');
      if (hasComplete) {
        console.log('setup-testnet-acceptance-operator:host bootstrap complete');
        console.log(JSON.stringify(payload, null, 2));
        console.log(`
Before running the acceptance harness, log Claude into the acceptance home once:
  export HOME=${acceptanceHome}
  export XDG_CONFIG_HOME=${xdg.configHome}
  export XDG_DATA_HOME=${xdg.dataHome}
  export XDG_CACHE_HOME=${xdg.cacheHome}
  claude
  # inside Claude: /login
`);
        console.log('Next: cd operator && yarn release:testnet-acceptance:host ... (steady-state; avoid --mode fresh-state)');
        return;
      }
      console.log(`[waiting] bootstrap ok but no complete service yet: ${JSON.stringify(payload)}`);
    } else if (bs.status === 10) {
      let msg = 'funding_required';
      try {
        const line = bs.stdout
          .trim()
          .split('\n')
          .map((line_) => line_.trim())
          .filter(Boolean)
          .pop();
        if (line) {
          const o = JSON.parse(line);
          if (typeof o.message === 'string') msg = o.message;
        }
      } catch {
        /* ignore */
      }
      console.log(`[waiting] ${msg} (retry in ${pollMs}ms)`);
    } else {
      console.error(bs.stderr);
      fail(`bootstrap exit ${bs.status}\n${bs.stdout}`);
    }
    await sleep(pollMs);
  }

  fail('Timed out waiting for bootstrap complete; increase --bootstrap-timeout-ms or check funding / chain');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
