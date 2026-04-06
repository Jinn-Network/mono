#!/usr/bin/env tsx
/**
 * Support Bundle — Collect sanitized diagnostics for the Jinn dev team
 *
 * Usage: yarn support:bundle
 *
 * Collects system info, connectivity status, wallet addresses, staking state,
 * and configuration presence (never secret values) into a JSON bundle that
 * operators can share with Jinn developers for troubleshooting.
 *
 * Secrets (passwords, API keys, private keys) are NEVER included in output.
 */

// Route all pino logs to stderr BEFORE any module imports
process.env.FORCE_STDERR = 'true';

import 'dotenv/config';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRpcProvider } from '../src/config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Catch both sync throws and async rejections */
async function safe<T>(fn: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10_000 }).trim();
  } catch {
    return '';
  }
}

function redact(value: string | undefined): 'set' | 'unset' {
  return value ? 'set' : 'unset';
}

// ---------------------------------------------------------------------------
// Section collectors — each one is isolated and cannot crash the whole bundle
// ---------------------------------------------------------------------------

async function collectSystem() {
  const jinnNodeRoot = resolve(__dirname, '..');
  const pkgPath = join(jinnNodeRoot, 'package.json');
  let version = '?';
  try { version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version; } catch { /* skip */ }

  return {
    jinnNodeVersion: version,
    gitCommit: exec('git rev-parse --short HEAD'),
    gitBranch: exec('git rev-parse --abbrev-ref HEAD'),
    gitDirty: exec('git status --porcelain') !== '',
    nodeVersion: exec('node --version'),
    pythonVersion: exec('python3 --version'),
    poetryVersion: exec('poetry --version'),
    tendermintVersion: exec('tendermint version'),
    os: `${exec('uname -s')} ${exec('uname -r')} ${exec('uname -m')}`,
    timestamp: new Date().toISOString(),
  };
}

function collectEnvPresence() {
  // Endpoint URLs are safe to include — they're pre-filled public values.
  const endpoints: Record<string, string | undefined> = {
    PONDER_GRAPHQL_URL: process.env.PONDER_GRAPHQL_URL,
    CONTROL_API_URL: process.env.CONTROL_API_URL,
    X402_GATEWAY_URL: process.env.X402_GATEWAY_URL,
    STAKING_CONTRACT: process.env.STAKING_CONTRACT,
    WORKER_STAKING_CONTRACT: process.env.WORKER_STAKING_CONTRACT,
    WORKER_MECH_FILTER_MODE: process.env.WORKER_MECH_FILTER_MODE,
    WORKSTREAM_FILTER: process.env.WORKSTREAM_FILTER,
    CHAIN_ID: process.env.CHAIN_ID,
    GEMINI_SANDBOX: process.env.GEMINI_SANDBOX,
    WORKER_JOB_DELAY_MS: process.env.WORKER_JOB_DELAY_MS,
  };

  // Secrets: show presence only, never values
  const secrets: Record<string, 'set' | 'unset'> = {
    RPC_URL: redact(process.env.RPC_URL),
    OPERATE_PASSWORD: redact(process.env.OPERATE_PASSWORD),
    GEMINI_API_KEY: redact(process.env.GEMINI_API_KEY),
    OPENAI_API_KEY: redact(process.env.OPENAI_API_KEY),
    GITHUB_TOKEN: redact(process.env.GITHUB_TOKEN),
    SUPABASE_URL: redact(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: redact(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };

  return { endpoints, secrets };
}

function collectOperateState() {
  const jinnNodeRoot = resolve(__dirname, '..');
  const operateDir = join(jinnNodeRoot, '.operate');
  const homeOperate = join(process.env.HOME || '', '.operate');

  const checks: Record<string, unknown> = {
    dotOperateExists: existsSync(operateDir),
    homeDotOperateExists: existsSync(homeOperate),
    operateProfileDirOverride: process.env.OPERATE_PROFILE_DIR ? 'set' : 'unset',
  };

  // Check for keystore file
  checks.keystoreExists = existsSync(join(operateDir, 'wallets', 'ethereum.txt'));

  // Check for service configs
  const servicesDir = join(operateDir, 'services');
  checks.servicesExists = existsSync(servicesDir);

  return checks;
}

async function collectWalletAndStaking() {
  const result: Record<string, unknown> = {};

  // Read addresses from the operate-profile (no daemon needed)
  try {
    const mod = await import('../src/env/operate-profile.js');
    result.masterEOA = await safe(() => mod.getMasterEOA(), null);
    result.masterSafe = await safe(() => mod.getMasterSafe('base'), null);
    result.serviceSafe = await safe(() => mod.getServiceSafeAddress(), null);
    result.mechAddress = await safe(() => mod.getMechAddress(), null);
  } catch (e: any) {
    result.error = `Could not read operate profile: ${e.message}`;
  }

  // Fetch on-chain balances if RPC is available
  if (process.env.RPC_URL && (result.masterEOA || result.masterSafe)) {
    try {
      const { ethers } = await import('ethers');
      const provider = createRpcProvider(process.env.RPC_URL);
      const OLAS = '0x54330d28ca3357F294334BDC454a032e7f353416';
      const erc20 = new ethers.Contract(OLAS, ['function balanceOf(address) view returns (uint256)'], provider);

      const fetchBal = async (addr: string) => {
        const [eth, olas] = await Promise.all([
          provider.getBalance(addr),
          erc20.balanceOf(addr) as Promise<bigint>,
        ]);
        return { eth: ethers.formatEther(eth), olas: ethers.formatEther(olas) };
      };

      if (result.masterEOA) {
        result.masterEOABalances = await safe(() => fetchBal(result.masterEOA as string), null);
      }
      if (result.masterSafe) {
        result.masterSafeBalances = await safe(() => fetchBal(result.masterSafe as string), null);
      }

      // Staking status
      const stakingContract = process.env.STAKING_CONTRACT || process.env.WORKER_STAKING_CONTRACT;
      if (stakingContract && result.mechAddress) {
        const staking = new ethers.Contract(stakingContract, [
          'function getServiceIds() view returns (uint256[])',
          'function getStakingState(uint256) view returns (uint8)',
        ], provider);

        // Try to find service ID from .operate configs
        const servicesDir = join(resolve(__dirname, '..'), '.operate', 'services');
        let serviceId: string | null = null;
        if (existsSync(servicesDir)) {
          try {
            const files = execSync(`find "${servicesDir}" -name "*.json" -maxdepth 2`, {
              encoding: 'utf-8',
            }).split('\n').filter(Boolean);
            for (const f of files) {
              try {
                const data = JSON.parse(readFileSync(f, 'utf-8'));
                const sid = data?.chain_configs?.base?.chain_data?.token;
                if (sid) { serviceId = String(sid); break; }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }

        if (serviceId) {
          result.serviceId = serviceId;
          result.stakingState = await safe(async () => {
            const state = await staking.getStakingState(BigInt(serviceId!));
            return ['Unstaked', 'Staked', 'Evicted'][Number(state)] || `Unknown(${state})`;
          }, null);
        }

        result.stakedServiceIds = await safe(async () => {
          const ids = await staking.getServiceIds() as bigint[];
          return ids.map((id: bigint) => id.toString());
        }, null);
      }
    } catch (e: any) {
      result.balanceError = e.message;
    }
  }

  return result;
}

async function collectConnectivity() {
  const checks: Record<string, unknown> = {};

  // RPC
  if (process.env.RPC_URL) {
    checks.rpc = await safe(async () => {
      const res = await fetch(process.env.RPC_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json() as any;
      return { ok: true, blockNumber: data.result };
    }, { ok: false, error: 'RPC unreachable' });
  } else {
    checks.rpc = { ok: false, error: 'RPC_URL not set' };
  }

  // Ponder indexer
  const ponderUrl = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
  checks.ponder = await safe(async () => {
    const res = await fetch(ponderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ _meta { status } }' }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json() as any;
    return { ok: res.ok, status: res.status, meta: data?.data?._meta };
  }, { ok: false, error: 'Ponder unreachable' });

  // Control API
  const controlUrl = process.env.CONTROL_API_URL || 'https://control-api-production-c1f5.up.railway.app/graphql';
  checks.controlApi = await safe(async () => {
    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status };
  }, { ok: false, error: 'Control API unreachable' });

  // Local health endpoint
  const healthPort = process.env.HEALTHCHECK_PORT || process.env.PORT || '8080';
  checks.healthEndpoint = await safe(async () => {
    const res = await fetch(`http://localhost:${healthPort}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return { ok: true, ...(await res.json() as any) };
  }, { ok: false, error: 'Worker not running locally' });

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error('Collecting support bundle... (this may take a few seconds)\n');

  const bundle: Record<string, unknown> = {};

  const [system, wallet, connectivity] = await Promise.all([
    safe(collectSystem, { error: 'Failed to collect system info' }),
    safe(collectWalletAndStaking, { error: 'Failed to collect wallet info' }),
    safe(collectConnectivity, { error: 'Failed to collect connectivity info' }),
  ]);

  bundle.system = system;
  bundle.env = collectEnvPresence();
  bundle.operate = collectOperateState();
  bundle.wallet = wallet;
  bundle.connectivity = connectivity;

  // JSON to stdout, everything else to stderr
  const json = JSON.stringify(bundle, null, 2);
  console.log(json);

  console.error('\n--- Support bundle generated ---');
  console.error('Share the JSON above with the Jinn team for troubleshooting.');
  console.error('No passwords, API keys, or private keys are included.');
}

main().catch(error => {
  console.error('Fatal error generating support bundle:', error.message);
  process.exit(1);
});
