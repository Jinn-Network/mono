/**
 * Global E2E Test Setup
 * Initializes shared infrastructure once for all e2e tests
 * - Creates Tenderly VNet
 * - Starts Ponder indexer
 * - Starts Control API
 * - Connects MCP client
 */

import { execa, type ResultPromise } from 'execa';
import fetch from 'cross-fetch';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';
import { Wallet } from 'ethers';
import { loadEnvOnce } from 'jinn-node/agent/mcp/tools/shared/env.js';
import { createTenderlyClient, ethToWei, type VnetResult } from 'jinn-node/lib/tenderly.js';
import { getMcpClient, cleanupWorkerProcesses } from './shared.js';
import { findAvailablePort } from './port-utils.js';
import { getTestGitRepo, type TestGitRepo } from './test-git-repo.js';
import { getServicePrivateKey, getServiceSafeAddress } from 'jinn-node/env/operate-profile.js';

let vnetResult: VnetResult | null = null;
let ponderProc: ResultPromise | null = null;
let controlApiProc: ResultPromise | null = null;
let tenderlyClient: ReturnType<typeof createTenderlyClient> | null = null;
let testGitRepo: TestGitRepo | null = null;
let testPonderPort: number | null = null;
let testRpcUrl: string | null = null;

async function assertBalance(rpcUrl: string, address: string, minimumEth: number, label: string): Promise<void> {
  const payload = {
    jsonrpc: '2.0',
    method: 'eth_getBalance',
    params: [address, 'latest'],
    id: Date.now(),
  };

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`[global-setup:${SUITE_ID}] Failed to query balance for ${label}: HTTP ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  const balanceHex = body?.result;
  if (typeof balanceHex !== 'string') {
    throw new Error(`[global-setup:${SUITE_ID}] Unexpected balance RPC response for ${label}: ${JSON.stringify(body)}`);
  }

  const balanceWei = BigInt(balanceHex);
  const minWei = BigInt(Math.floor(minimumEth * 1e18));
  if (balanceWei < minWei) {
    throw new Error(`[global-setup:${SUITE_ID}] ${label} has insufficient balance. Expected >= ${minimumEth} ETH, got ${balanceWei.toString()} wei`);
  }

  console.log(`[global-setup:${SUITE_ID}] ✓ ${label} balance confirmed: ${balanceWei.toString()} wei`);
}

// Generate unique suite ID for process isolation
const SUITE_ID = `test-${Date.now()}-${process.pid}`;

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  return false;
}

export async function setup() {
  console.log(`\n[global-setup:${SUITE_ID}] 🚀 Setting up shared E2E test infrastructure...\n`);

  process.env.RUNTIME_ENVIRONMENT = 'test';
  // Load env early and set flag to prevent child processes from reloading
  loadEnvOnce();

  // Set up suite-scoped test git repository (requires TEST_GITHUB_REPO env var)
  // Creates a local bare remote per suite and clones from it for full isolation
  // Each suite gets its own bare remote + working clone to avoid race conditions
  console.log(`[global-setup:${SUITE_ID}] Setting up suite-scoped test git repository...`);
  testGitRepo = getTestGitRepo(SUITE_ID);  // Throws if TEST_GITHUB_REPO not set
  process.env.CODE_METADATA_REPO_ROOT = testGitRepo.repoPath;
  console.log(`[global-setup:${SUITE_ID}] ✓ Test git repo at: ${testGitRepo.repoPath}`);
  console.log(`[global-setup:${SUITE_ID}] ✓ Remote repo: ${testGitRepo.remoteUrl}`);

  // Log which Tenderly account is being used
  const tenderlyAccount = process.env.TENDERLY_ACCOUNT_SLUG || 'NOT SET';
  const tenderlyProject = process.env.TENDERLY_PROJECT_SLUG || 'NOT SET';
  console.log(`[global-setup:${SUITE_ID}] Tenderly Account: ${tenderlyAccount}`);
  console.log(`[global-setup:${SUITE_ID}] Tenderly Project: ${tenderlyProject}`);

  // Create Tenderly Virtual TestNet
  tenderlyClient = createTenderlyClient();
  console.log(`[global-setup:${SUITE_ID}] Creating ephemeral Virtual TestNet...`);
  vnetResult = await tenderlyClient.createVnet(8453); // Base mainnet
  console.log(`[global-setup:${SUITE_ID}] ✓ VNet created: ${vnetResult.id}`);

  // Fund the agent wallet that will actually sign Safe transactions
  let fundedWallet = '0x6ad64135eae1a5a78ec74c44d337a596c682f690';
  try {
    const privateKey = getServicePrivateKey();
    if (privateKey && privateKey.trim().length > 0) {
      let normalizedKey = privateKey.trim();
      if (!normalizedKey.startsWith('0x')) {
        normalizedKey = `0x${normalizedKey}`;
      }
      const wallet = new Wallet(normalizedKey);
      fundedWallet = wallet.address;
      console.log(`[global-setup:${SUITE_ID}] Funding agent wallet from .operate profile: ${fundedWallet}`);
    } else {
      console.warn(`[global-setup:${SUITE_ID}] Could not read agent private key from .operate; falling back to default funding wallet ${fundedWallet}`);
    }
  } catch (error: any) {
    console.warn(`[global-setup:${SUITE_ID}] Failed to derive agent wallet from .operate: ${error?.message ?? error}. Falling back to default ${fundedWallet}`);
  }

  await tenderlyClient.fundAddress(fundedWallet, ethToWei('10'), vnetResult.adminRpcUrl);
  console.log(`[global-setup:${SUITE_ID}] ✓ Agent wallet funded`);

  const safeAddress = getServiceSafeAddress();
  if (safeAddress && safeAddress.trim().length > 0) {
    console.log(`[global-setup:${SUITE_ID}] Funding service Safe: ${safeAddress}`);
    await tenderlyClient.fundAddress(safeAddress.trim(), ethToWei('20'), vnetResult.adminRpcUrl);
    console.log(`[global-setup:${SUITE_ID}] ✓ Service Safe funded`);
  } else {
    console.warn(`[global-setup:${SUITE_ID}] Service Safe address not found in .operate profile; marketplace requests may fail due to insufficient Safe balance`);
  }

  // Use the admin RPC for all client traffic (supports both reads and writes)
  testRpcUrl = vnetResult.adminRpcUrl;
  if (!testRpcUrl) {
    throw new Error(`[global-setup:${SUITE_ID}] Virtual TestNet did not provide a usable RPC URL`);
  }
  if (vnetResult.publicRpcUrl) {
    process.env.VNET_PUBLIC_RPC_URL = vnetResult.publicRpcUrl;
  }

  process.env.RPC_URL = testRpcUrl;
  process.env.MECH_RPC_HTTP_URL = testRpcUrl;
  process.env.MECHX_CHAIN_RPC = testRpcUrl;
  process.env.BASE_RPC_URL = testRpcUrl;

  await assertBalance(testRpcUrl, fundedWallet, 5, 'Agent wallet');
  if (safeAddress && safeAddress.trim().length > 0) {
    await assertBalance(testRpcUrl, safeAddress.trim(), 10, 'Service Safe');
  }

  // Find available port for Ponder (with timestamp + PID offset to avoid parallel collisions)
  const basePonderPort = 42070 + ((Date.now() + process.pid) % 50);
  testPonderPort = await findAvailablePort(basePonderPort);
  console.log(`[global-setup:${SUITE_ID}] Using Ponder port: ${testPonderPort}`);
  const gqlUrl = `http://localhost:${testPonderPort}/graphql`;
  process.env.PONDER_PORT = String(testPonderPort);
  process.env.PONDER_GRAPHQL_URL = gqlUrl;
  process.env.E2E_GQL_URL = gqlUrl; // For tests to read

  // Each suite gets its own Control API port to avoid race conditions
  // Start searching from a unique base port derived from timestamp to reduce collisions
  const baseControlPort = 4001 + (Date.now() % 100);
  const testControlApiPort = await findAvailablePort(baseControlPort);
  const controlUrl = `http://localhost:${testControlApiPort}/graphql`;
  console.log(`[global-setup:${SUITE_ID}] Using Control API port: ${testControlApiPort}`);

  process.env.CONTROL_API_PORT = String(testControlApiPort);
  process.env.CONTROL_API_URL = controlUrl;
  process.env.E2E_CONTROL_URL = controlUrl; // For tests to read

  let controlApiReady = false;

  // Store VNet ID and Suite ID for tests
  process.env.E2E_VNET_ID = vnetResult.id;
  process.env.E2E_SUITE_ID = SUITE_ID;

  // Reset config cache in test process so getters re-read overridden env vars
  const { resetConfigForTests } = await import('jinn-node/config/index.js');
  resetConfigForTests();

  // NOW connect MCP client (spawns MCP server with overridden env vars)
  console.log(`[global-setup:${SUITE_ID}] Connecting MCP client...`);
  process.env.JINN_REPO_ROOT = process.cwd();
  const client = getMcpClient();
  await client.connect();
  console.log(`[global-setup:${SUITE_ID}] ✓ MCP client connected`);

  // REMOVED: Global pkill command that killed ALL Ponder instances
  // This allows parallel test suites to run without interfering with each other.
  // Port allocation and process tracking provide isolation instead.

  // Create suite-specific Ponder cache directory
  const ponderCacheDir = `.ponder-${SUITE_ID}`;
  process.env.PONDER_DATABASE_DIR = ponderCacheDir;
  console.log(`[global-setup:${SUITE_ID}] Using Ponder cache dir: ${ponderCacheDir}`);

  // Clean suite-specific Ponder cache
  try {
    await execa('rm', ['-rf', ponderCacheDir]);
    console.log(`[global-setup:${SUITE_ID}] ✓ Cleaned Ponder cache`);
  } catch {}

  // Start Ponder
  const ponderDir = path.join(process.cwd(), 'ponder');

  // Calculate start block
  try {
    const response = await fetch(process.env.RPC_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 })
    });
    const data = await response.json();
    const currentBlock = parseInt(data.result, 16);
    const vnetStartBlock = Math.max(0, currentBlock - 100);
    process.env.PONDER_START_BLOCK = String(vnetStartBlock);
    console.log(`[global-setup:${SUITE_ID}] Calculated PONDER_START_BLOCK: ${vnetStartBlock}`);
  } catch (error: any) {
    console.error(`[global-setup:${SUITE_ID}] Warning: Failed to calculate start block:`, error.message);
  }

  const ponderEnv = {
    ...process.env,
    RPC_URL: process.env.RPC_URL,  // Test VNet Admin RPC
    PORT: String(testPonderPort),
    PONDER_START_BLOCK: process.env.PONDER_START_BLOCK,
    MECH_ADDRESS: process.env.MECH_ADDRESS,
    PONDER_MECH_ADDRESS: process.env.MECH_ADDRESS,
    PONDER_DATABASE_DIR: ponderCacheDir,  // Suite-specific cache directory
  };

  // Run ponder:predev steps (set start block & ensure better-sqlite3) before launching server
  await execa('yarn', ['ponder:predev'], {
    stdio: 'inherit',
  });

  const ponderBin = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'ponder.cmd' : 'ponder'
  );

  // Suppress the live progress table while keeping meaningful logs available for debugging
  // Using explicit array form avoids pipe handles that prevent clean teardown
  ponderProc = execa(ponderBin, ['dev', '--port', String(testPonderPort)], {
    cwd: ponderDir,
    stdio: ['inherit', 'pipe', 'pipe'], // stdin/stdout/stderr - pipe stdout for filtering
    env: ponderEnv,
    cleanup: true,
    detached: true,
    forceKillAfterTimeout: 2000, // Force-kill after 2s if SIGTERM doesn't work
  });

  const ansiControlRegex = /\u001b\[[0-9;]*[A-Za-z]/g;
  const ponderAlertRegex = /(warn|error|fail|httprequesterror)/i;
  const ponderStdoutSkipPatterns = [
    /^sync$/i,
    /^indexing$/i,
    /^waiting to start/i,
    /^progress(?:\s*\(live\))?$/i,
    /^graphql$/i,
    /^server live at/i,
    /^│.*│$/,
    /^[\u2500-\u259F\s]+$/,
    /^[\u2580-\u259F].*$/,
    /^[\u2580-\u259F\s0-9.%]+$/
  ];
  const seenPonderAlerts = new Set<string>();
  const bufferedAlerts: string[] = [];

  ponderProc.stdout?.setEncoding('utf8');
  ponderProc.stdout?.on('data', (chunk: string) => {
    const sanitized = chunk.replace(ansiControlRegex, '').replace(/\r/g, '\n');
    for (const rawLine of sanitized.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (ponderStdoutSkipPatterns.some((pattern) => pattern.test(line))) continue;
      console.log(`[ponder] ${line}`);
    }
  });

  ponderProc.stderr?.setEncoding('utf8');
  ponderProc.stderr?.on('data', (chunk: string) => {
    const sanitized = chunk.replace(ansiControlRegex, '').replace(/\r/g, '\n');
    for (const rawLine of sanitized.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!ponderAlertRegex.test(line)) continue;
      bufferedAlerts.push(line);
      if (seenPonderAlerts.has(line)) continue;
      seenPonderAlerts.add(line);
      console.error(`[ponder] ${line}`);
    }
  });

  ponderProc.on('exit', (code, signal) => {
    if ((code ?? 0) === 0 || signal === 'SIGTERM') return;
    if (bufferedAlerts.length === 0) return;
    console.error(`[global-setup:${SUITE_ID}] Ponder stderr before exit:\n${bufferedAlerts.join('\n')}`);
  });

  console.log(`[global-setup:${SUITE_ID}] Ponder dev server spawned (PID: ${ponderProc.pid})`);
  await waitForGraphql(gqlUrl, 120_000);
  console.log(`[global-setup:${SUITE_ID}] ✓ Ponder GraphQL ready`);

  // Start Control API if needed
  let controlReady = false;

  try {
    const resp = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ _health }' })
    });
    const j = await resp.json();
    if (j?.data?._health === 'ok') controlReady = true;
  } catch {}

  if (!controlReady) {
    console.log(`[global-setup:${SUITE_ID}] Starting Control API...`);
    // Use stdio: 'inherit' to avoid creating pipe handles that prevent clean teardown
    // Spawn in a new process group so we can kill the entire tree
    const tsxBin = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
    );

    controlApiProc = execa(tsxBin, ['control-api/server.ts'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        CONTROL_API_PORT: String(testControlApiPort),
        PONDER_GRAPHQL_URL: gqlUrl,
      },
      cleanup: true,
      detached: true,
      forceKillAfterTimeout: 2000, // Force-kill after 2s if SIGTERM doesn't work
      // Note: execa doesn't expose process group control directly, so we'll use
      // process.kill(-pid) in teardown which works if the process is in its own group
    });

    const start = Date.now();
    let lastErr: any = null;
    while (Date.now() - start < 60_000) {
      try {
        const resp = await fetch(controlUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ _health }' })
        });
        const j = await resp.json();
        if (j?.data?._health === 'ok') { controlReady = true; break; }
      } catch (e: any) { lastErr = e; }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!controlReady) throw lastErr || new Error('Control API failed to start');
    console.log(`[global-setup:${SUITE_ID}] ✓ Control API ready (PID: ${controlApiProc.pid})`);
  } else {
    console.log(`[global-setup:${SUITE_ID}] ✓ Control API already running`);
  }

  console.log(`[global-setup:${SUITE_ID}] ✅ All infrastructure ready!\n`);

  // Return teardown function
  return async () => {
    console.log(`\n[global-setup:${SUITE_ID}] 🧹 Tearing down shared infrastructure...\n`);

    // Clean up test git repo (working repo + worktree)
    if (testGitRepo) {
      try {
        testGitRepo.cleanup();
        // Clean up suite-scoped bare remote (persisted for suite lifetime)
        if (testGitRepo.repoPath && fs.existsSync(testGitRepo.repoPath)) {
          fs.rmSync(testGitRepo.repoPath, { recursive: true, force: true });
          console.log(`[global-setup:${SUITE_ID}] ✓ Removed working repository`);
        }
      } catch (e: any) {
        console.warn(`[global-setup:${SUITE_ID}] Test repo cleanup warning:`, e.message);
      }
    }

    // Kill Ponder process and all its children
    if (ponderProc && ponderProc.pid) {
      try {
        console.log(`[global-setup:${SUITE_ID}] Stopping Ponder (PID: ${ponderProc.pid})...`);
        
        // Kill the entire process group to ensure yarn and its child (ponder) both terminate
        // Negative PID means kill the process group
        try {
          process.kill(-ponderProc.pid, 'SIGTERM');
        } catch {
          // If process group kill fails (e.g., process already in different group),
          // fall back to killing the process directly
          ponderProc.kill('SIGTERM');
        }
        
        // Wait for process to exit - ResultPromise is a promise that resolves/rejects on exit
        // When killed, it rejects with isTerminated: true, which is expected
        try {
          await ponderProc;
          console.log(`[global-setup:${SUITE_ID}] ✓ Ponder stopped`);
        } catch (err: any) {
          // Process rejection on kill is expected - execa rejects when process is terminated
          if (err.isCanceled || err.isTerminated || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
            console.log(`[global-setup:${SUITE_ID}] ✓ Ponder stopped`);
          } else {
            console.warn(`[global-setup:${SUITE_ID}] Ponder exit error:`, err.message || err);
          }
        }
        
        // Also kill any lingering ponder processes by port/command pattern as a fallback
        // This handles cases where the yarn wrapper exited but ponder child is still running
        if (testPonderPort) {
          try {
            const psOutput = execSync(`ps aux | grep "ponder.*--port ${testPonderPort}" | grep -v grep`, { encoding: 'utf-8' }).trim();
            if (psOutput) {
              const lines = psOutput.split('\n');
              for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parseInt(parts[1], 10);
                if (Number.isInteger(pid) && pid > 0) {
                  try {
                    process.kill(pid, 'SIGTERM');
                    let exited = await waitForProcessExit(pid, 3000);
                    if (!exited) {
                      try {
                        process.kill(pid, 'SIGKILL');
                      } catch {}
                      exited = await waitForProcessExit(pid, 2000);
                    }
                    if (!exited) {
                      console.warn(`[global-setup:${SUITE_ID}] Warning: Ponder process ${pid} did not exit after SIGKILL`);
                    }
                  } catch {
                    // Process may have already exited, ignore
                  }
                }
              }
            }
          } catch {
            // No matching processes or command failed, ignore
          }
        }
      } catch (err: any) {
        // Test cleanup exception: Process kill errors during teardown are non-critical
        console.warn(`[global-setup:${SUITE_ID}] Warning stopping Ponder:`, err.message || err);
      }
    }

    // Cleanup any lingering worker processes
    try {
      await cleanupWorkerProcesses();
      console.log(`[global-setup:${SUITE_ID}] ✓ Worker processes cleaned up`);
    } catch (err: any) {
      console.warn(`[global-setup:${SUITE_ID}] Warning cleaning up worker processes:`, err.message || err);
    }

    // Disconnect MCP client
    const client = getMcpClient();
    try {
      await client.disconnect();
      console.log(`[global-setup:${SUITE_ID}] ✓ MCP client disconnected`);
    } catch (err: any) {
      // Test cleanup exception: MCP disconnect errors are non-critical during teardown
      console.warn(`[global-setup:${SUITE_ID}] Warning disconnecting MCP client:`, err.message || err);
    }

    // Kill Control API process and all its children
    if (controlApiProc && controlApiProc.pid) {
      try {
        console.log(`[global-setup:${SUITE_ID}] Stopping Control API (PID: ${controlApiProc.pid})...`);
        
        // Kill the entire process group to ensure yarn and its child (tsx) both terminate
        // Negative PID means kill the process group
        try {
          process.kill(-controlApiProc.pid, 'SIGTERM');
        } catch {
          // If process group kill fails (e.g., process already in different group),
          // fall back to killing the process directly
          controlApiProc.kill('SIGTERM');
        }
        
        let controlStopped = false;
        try {
          await controlApiProc;
          controlStopped = true;
          console.log(`[global-setup:${SUITE_ID}] ✓ Control API stopped`);
        } catch (err: any) {
          if (err?.isCanceled || err?.isTerminated || err?.signal === 'SIGTERM' || err?.signal === 'SIGKILL') {
            controlStopped = true;
            console.log(`[global-setup:${SUITE_ID}] ✓ Control API stopped`);
          } else {
            console.warn(`[global-setup:${SUITE_ID}] Control API exit error:`, err?.message || err);
          }
        }

        // Also kill any lingering tsx control-api/server.ts processes as a fallback
        try {
          const psOutput = execSync('ps aux | grep "tsx.*control-api/server.ts" | grep -v grep', { encoding: 'utf-8' }).trim();
          if (psOutput) {
            const lines = psOutput.split('\n');
            for (const line of lines) {
              const parts = line.trim().split(/\s+/);
              const pid = parseInt(parts[1], 10);
              if (Number.isInteger(pid) && pid > 0) {
                try {
                  process.kill(pid, 'SIGTERM');
                  let exited = await waitForProcessExit(pid, 3000);
                  if (!exited) {
                    try {
                      process.kill(pid, 'SIGKILL');
                    } catch {}
                    exited = await waitForProcessExit(pid, 2000);
                  }
                  if (!exited) {
                    console.warn(`[global-setup:${SUITE_ID}] Warning: Control API process ${pid} did not exit after SIGKILL`);
                  }
                } catch {
                  // Process may have already exited, ignore
                }
              }
            }
          }
        } catch {
          // No matching processes or command failed, ignore
        }
        
        console.log(`[global-setup:${SUITE_ID}] ✓ Control API stopped`);
      } catch (err: any) {
        // Test cleanup exception: Process kill errors during teardown are non-critical
        console.warn(`[global-setup:${SUITE_ID}] Warning stopping Control API:`, err.message || err);
      }
    }

    // Delete Virtual TestNet
    if (vnetResult && tenderlyClient) {
      console.log(`[global-setup:${SUITE_ID}] Deleting Virtual TestNet: ${vnetResult.id}`);
      await tenderlyClient.deleteVnet(vnetResult.id);
      console.log(`[global-setup:${SUITE_ID}] ✓ VNet deleted`);
    }

    // Clean up suite-specific Ponder cache directory
    try {
      await execa('rm', ['-rf', ponderCacheDir]);
      console.log(`[global-setup:${SUITE_ID}] ✓ Cleaned suite-specific Ponder cache`);
    } catch (error: any) {
      console.warn(`[global-setup:${SUITE_ID}] Warning: Failed to clean Ponder cache:`, error.message);
    }

    console.log(`[global-setup:${SUITE_ID}] ✅ Teardown complete\n`);
  };
}

/**
 * Wait for GraphQL endpoint to become available
 */
async function waitForGraphql(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  const q = '{ requests(limit: 1) { items { id } } }';
  let lastErr: any = null;
  while (true) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q })
      });
      if (resp.ok) return;
      lastErr = new Error(`GraphQL HTTP ${resp.status}`);
    } catch (e: any) {
      lastErr = e;
    }
    if (Date.now() - start > timeoutMs) {
      throw lastErr || new Error('Timed out waiting for GraphQL');
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}
