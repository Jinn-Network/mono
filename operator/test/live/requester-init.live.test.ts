/**
 * Live Base Sepolia walk for `jinn requester init` (issue #4791 / #2446 criterion 6).
 *
 * Opt-in: JINN_LIVE_REQUESTER_INIT=1. The skip path must stay green without
 * the flag, and the second run must not sit on the 4:30 faucet budget.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPublicClient, getAddress, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { redactRpcUrls } from '../../src/util/redact-rpc-urls.js';

const PUBLIC_BASE_SEPOLIA_RPC = 'https://base-sepolia.publicnode.com';

const describeLive = process.env['JINN_LIVE_REQUESTER_INIT'] === '1'
  ? describe
  : describe.skip;

const CLIENT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX_BIN = join(CLIENT_ROOT, 'node_modules', '.bin', 'tsx');
const JINN_ENTRY = join(CLIENT_ROOT, 'src', 'bin', 'jinn.ts');

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DRIP_REACHED_RE = /\[requester-init\] CDP faucet reached target after (\d+) drips/;

function isLoopbackRpcUrl(rpcUrl: string): boolean {
  try {
    const host = new URL(rpcUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function shouldCopyRpc(value: string | undefined): value is string {
  if (!value) return false;
  const urls = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (urls.length === 0) return false;
  return urls.every((url) => url.startsWith('https') && !isLoopbackRpcUrl(url));
}

function buildChildEnv(scratchHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: scratchHome,
    USERPROFILE: scratchHome,
    JINN_PASSWORD: 'walk-only',
    JINN_NETWORK: 'testnet',
    NO_COLOR: '1',
    NODE_OPTIONS: '--preserve-symlinks',
  };
  if (process.env['TMPDIR']) env['TMPDIR'] = process.env['TMPDIR'];
  if (process.env['LANG']) env['LANG'] = process.env['LANG'];

  for (const key of ['JINN_RPC_URL', 'BASE_SEPOLIA_RPC_URL', 'BASE_RPC_URL'] as const) {
    const value = process.env[key];
    if (shouldCopyRpc(value)) env[key] = value;
  }

  const cdpId = process.env['CDP_API_KEY_ID'];
  const cdpSecret = process.env['CDP_API_KEY_SECRET'];
  if (cdpId && cdpId.length > 0 && cdpSecret && cdpSecret.length > 0) {
    env['CDP_API_KEY_ID'] = cdpId;
    env['CDP_API_KEY_SECRET'] = cdpSecret;
  }

  return env;
}

function liveSepoliaRpcUrl(): string {
  for (const key of ['BASE_SEPOLIA_RPC_URL', 'JINN_RPC_URL'] as const) {
    const value = process.env[key];
    if (shouldCopyRpc(value)) {
      const first = value.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  if (isLoopbackRpcUrl(PUBLIC_BASE_SEPOLIA_RPC)) {
    throw new Error('live bytecode check refuses a loopback RPC');
  }
  return PUBLIC_BASE_SEPOLIA_RPC;
}

function runRequesterInit(childEnv: NodeJS.ProcessEnv): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TSX_BIN, [JINN_ENTRY, 'requester', 'init', '--json'], {
      cwd: CLIENT_ROOT,
      env: childEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ stdout, stderr, exitCode: code }));
  });
}

function parseJsonStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const line = trimmed.split('\n').reverse().find((candidate) => candidate.trim().startsWith('{'));
    if (!line) {
      throw new Error(`no JSON payload on stdout: ${stdout.slice(0, 500)}`);
    }
    return JSON.parse(line) as Record<string, unknown>;
  }
}

describeLive('live requester init on Base Sepolia', () => {
  let scratchHome: string | undefined;
  let childEnv: NodeJS.ProcessEnv | undefined;
  let firstMaster: string | undefined;
  let firstCreatorSafe: string | undefined;

  it('walks wallet, faucet, and creator Safe under the 4:30 budget', async () => {
    try {
      scratchHome = mkdtempSync(join(tmpdir(), 'jinn-live-requester-init-'));
      childEnv = buildChildEnv(scratchHome);

      const started = Date.now();
      const result = await runRequesterInit(childEnv);
      const elapsed = Date.now() - started;

      expect(elapsed, `wall-clock ${elapsed}ms`).toBeLessThanOrEqual(270_000);
      const dripMatch = DRIP_REACHED_RE.exec(result.stderr);
      expect(dripMatch, `missing reach-target log; stderr=${result.stderr.slice(-800)}`).not.toBeNull();
      const dripCount = Number(dripMatch![1]);
      if (dripCount >= 120) {
        throw new Error(
          `CDP faucet drip count ${dripCount} is operator-scale (>= 120); requester target must stay below 0.02 ETH`,
        );
      }
      // Floor is ~15 drips; fee quotes may raise it. Still far below ~200 operator drips.
      expect(dripCount).toBeLessThanOrEqual(80);

      expect(
        result.exitCode,
        `exit ${result.exitCode}; drips=${dripCount}; stderr=${result.stderr.slice(-800)}`,
      ).toBe(0);
      expect(result.stdout).not.toContain('funding_required');
      expect(result.stderr).not.toContain('Not enough ETH on the paying account');
      const payload = parseJsonStdout(result.stdout);
      expect(payload.chain).toBe('base-sepolia');
      expect(payload.master).toMatch(ADDRESS_RE);
      expect(payload.creatorSafe).toMatch(ADDRESS_RE);

      const earningDir = join(scratchHome, '.jinn-operator', 'earning');
      expect(existsSync(join(earningDir, 'master_keystore.json'))).toBe(true);
      const state = JSON.parse(readFileSync(join(earningDir, 'earning_state.json'), 'utf8')) as {
        master_address?: string;
        fleet_safe_address?: string;
        chain?: string;
        requester_stage?: string;
        fleet_stage?: string;
        fleet_agent_id?: string | null;
        services?: unknown;
      };
      expect(state.master_address).toBe(payload.master);
      expect(state.fleet_safe_address).toBe(payload.creatorSafe);
      expect(state.chain).toBe('base-sepolia');
      expect(state.requester_stage).toBe('safe_deployed');
      expect(state.fleet_stage).toBe('none');
      expect(state.fleet_agent_id ?? null).toBeNull();
      expect(state.services).toEqual([]);

      const rpcUrl = liveSepoliaRpcUrl();
      if (isLoopbackRpcUrl(rpcUrl)) {
        throw new Error('live bytecode check refuses a loopback RPC');
      }
      const client = createPublicClient({
        chain: baseSepolia,
        transport: http(rpcUrl),
      });
      const bytecode = await client.getBytecode({
        address: getAddress(String(payload.creatorSafe)),
      });
      expect(bytecode).toBeDefined();
      expect(bytecode).not.toBe('0x');

      console.error(
        `[live-walk] first-run elapsed_ms=${elapsed} drip_n=${dripCount} ` +
        `master=${payload.master} creatorSafe=${payload.creatorSafe}`,
      );

      firstMaster = String(payload.master);
      firstCreatorSafe = String(payload.creatorSafe);
    } catch (error) {
      throw new Error(redactRpcUrls(error));
    }
  }, 420_000);

  it('is idempotent on a second run of the same scratch HOME', async () => {
    try {
      expect(scratchHome).toBeDefined();
      expect(childEnv).toBeDefined();
      expect(firstMaster).toBeDefined();
      expect(firstCreatorSafe).toBeDefined();

      const result = await runRequesterInit(childEnv!);
      expect(result.exitCode, `exit ${result.exitCode}; stderr=${result.stderr.slice(-800)}`).toBe(0);
      expect(result.stdout).not.toContain('funding_required');
      expect(result.stderr).not.toContain('Draining CDP faucet');

      const payload = parseJsonStdout(result.stdout);
      expect(payload.master).toBe(firstMaster);
      expect(payload.creatorSafe).toBe(firstCreatorSafe);
      expect(payload.code).not.toBe('funding_required');
      console.error(`[live-walk] second-run exit=${result.exitCode} master=${payload.master}`);
    } catch (error) {
      throw new Error(redactRpcUrls(error));
    }
  }, 60_000);
});
