/**
 * Launch an isolated SWE-rebench v2 SolverNet on Base Sepolia.
 *
 * Why this exists
 * ---------------
 * T3.1 (`operator/test/release/tier-3/T3.1-producer-evaluator-real.test.ts`)
 * historically posted to the live "SWE-rebench v2" mainline (manifestCid
 * `bafkreichdzxtj…shpi`). The mainline is shared with an external griefer
 * (`0x26e96ba6dCbB86C1d18553b3F3D3202f3A3E0638`) that grabs solve / verdict
 * slots within ~2 blocks of each task creation and squats them. T3.1 can only
 * green when the controlled substrate operator wins the race against its own
 * pipeline latency — by luck.
 *
 * The fix is structural, not tuning: launch a *new* SWE-rebench v2 SolverNet
 * that the griefer is not joined to, and post T3.1's task to it. Because
 * claim eligibility filters on `joinedSolverNets[<manifestCid>]` (per spec
 * §12), the griefer cannot claim from a manifestCid they have not joined.
 *
 * The script used to drive the live launcher HTTP the same way the SPA did.
 * That HTTP surface retired in Stage 6 Task 17; calling this helper now fails
 * loudly rather than posting to a 404.
 *
 *   1. Spawn op-a's daemon against its gold substrate.
 *   2. Read op-a's `~/.jinn-client/ui-token` (the protection the launcher
 *      routes sit behind — see `operator/src/api/handshake.ts`).
 *   3. POST /v1/solvernets/drafts with all required wizard fields populated.
 *   4. POST /v1/solvernets/drafts/:id/launch.
 *   5. Poll /v1/solvernets/launched/:solverNetId until status === 'launched',
 *      capturing the `manifestCid` and on-chain anchor tx hash.
 *   6. Teardown the daemon.
 *
 * The output is a single JSON object on stdout:
 *
 *   { manifestCid, solverNetId, metadataTxHash, metadataBlockNumber }
 *
 * The caller (operator config edit; T3.1 fixture wiring) consumes that
 * manifestCid as the isolated SolverNet identifier.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` (§5 lifecycle,
 * §7 manifest, §10 launch state machine).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goldPath } from './substrate-paths.js';

const DEFAULT_NAME = 'T3.1 isolated';
const DEFAULT_DESCRIPTION =
  'Isolated SWE-rebench v2 SolverNet for T3.1 release-readiness gate. ' +
  'External griefer (0x26e96ba6…0638) is NOT joined to this manifestCid, ' +
  'so the controlled substrate operator can close the loop deterministically.';

// Pricing mirrors the live SWE-rebench v2 mainline so T3.1's wallet maths stays
// equivalent: 10 gwei per Solution, 5 gwei per Verdict.
const DEFAULT_SOLUTION_PRICE_WEI = '10000000000';
const DEFAULT_VERDICT_PRICE_WEI = '5000000000';

interface LaunchOutput {
  manifestCid: string;
  solverNetId: string;
  metadataTxHash: `0x${string}`;
  metadataBlockNumber: number;
  name: string;
  launchedAt: string;
}

function logErr(msg: string): void {
  // stdout is reserved for the final JSON. Diagnostics go to stderr.
  process.stderr.write(`[launch-isolated-solvernet] ${msg}\n`);
}

async function readUiToken(opHome: string): Promise<string> {
  const tokenPath = path.join(opHome, '.jinn-client', 'ui-token');
  try {
    const raw = await fs.readFile(tokenPath, 'utf-8');
    return raw.trim();
  } catch (err) {
    throw new Error(
      `failed to read ui-token at ${tokenPath} — has op-a been bootstrapped? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

async function waitForBootstrap(args: {
  apiPort: number;
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null;
  getOutputTail: () => string;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (args.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${args.apiPort}/v1/bootstrap`, { method: 'GET' });
      // 200 = ready, 401 = ready but unauth (means bound and ui-token gate up)
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // not yet
    }
    const exit = args.getExit();
    if (exit) {
      throw new Error(
        `daemon exited before its API became reachable ` +
          `(code=${exit.code} signal=${exit.signal}). Tail:\n${args.getOutputTail()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `daemon API did not bind within ${args.timeoutMs ?? 120000}ms. Tail:\n${args.getOutputTail()}`,
  );
}

interface DaemonHandle {
  process: ChildProcess;
  kill: () => Promise<void>;
  getOutputTail: () => string;
}

async function spawnOpADaemon(args: {
  opAHome: string;
  apiPort: number;
}): Promise<DaemonHandle> {
  const jinnBin = fileURLToPath(new URL('../../dist/bin/jinn.js', import.meta.url));
  await fs.access(jinnBin).catch(() => {
    throw new Error(`jinn binary not found at ${jinnBin} — run \`yarn build\` first`);
  });

  const fallbackRpcUrl =
    process.env['JINN_RPC_URL'] ??
    process.env['BASE_SEPOLIA_RPC_URL'] ??
    'https://base-sepolia.gateway.tenderly.co/75tyLMQuD8EHpXxMwINIKu';

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JINN_RPC_URL: fallbackRpcUrl,
    HOME: args.opAHome,
    JINN_API_PORT: args.apiPort.toString(),
  };
  // Each substrate has its own keystore-password file; an inherited
  // JINN_PASSWORD would override it and fail decryption.
  delete env['JINN_PASSWORD'];

  const proc = spawn('node', [jinnBin, 'run'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let outputTail = '';
  const captureTail = (chunk: Buffer): void => {
    outputTail += chunk.toString();
    const lines = outputTail.split('\n');
    if (lines.length > 80) outputTail = lines.slice(-80).join('\n');
  };
  proc.stdout?.on('data', captureTail);
  proc.stderr?.on('data', captureTail);

  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  proc.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  await waitForBootstrap({
    apiPort: args.apiPort,
    getExit: () => exit,
    getOutputTail: () => outputTail,
  });

  return {
    process: proc,
    getOutputTail: () => outputTail,
    kill: async () => {
      if (proc.killed) return;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      // Wait briefly for clean exit; SIGKILL if it lingers.
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* best-effort */
          }
          resolve(undefined);
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(t);
          resolve(undefined);
        });
      });
    },
  };
}

interface DraftResponse {
  draftId: string;
  schemaVersion: string;
  name?: string;
  description?: string;
  templateContractId?: string;
  templateContractVersion?: string;
  solutionPriceWei?: string;
  verdictPriceWei?: string;
  openRoles?: string[];
}

async function apiPost<T>(args: {
  apiPort: number;
  uiToken: string;
  pathPart: string;
  body: unknown;
}): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${args.apiPort}${args.pathPart}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-jinn-ui-token': args.uiToken,
    },
    body: JSON.stringify(args.body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new Error(
      `POST ${args.pathPart} returned non-JSON body (status=${res.status}):\n${text.slice(0, 400)}`,
    );
  }
  return { status: res.status, json: json as T };
}

async function apiGet<T>(args: {
  apiPort: number;
  uiToken: string;
  pathPart: string;
}): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${args.apiPort}${args.pathPart}`, {
    method: 'GET',
    headers: { 'x-jinn-ui-token': args.uiToken },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new Error(
      `GET ${args.pathPart} returned non-JSON body (status=${res.status}):\n${text.slice(0, 400)}`,
    );
  }
  return { status: res.status, json: json as T };
}

async function waitForSubsystemReady(args: {
  apiPort: number;
  uiToken: string;
  timeoutMs?: number;
}): Promise<void> {
  // /v1/solvernets/drafts returns 503 while the SolverNet subsystem is still
  // booting (the holder.current proxy is unpopulated). Poll until it accepts
  // a list call.
  const deadline = Date.now() + (args.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    const res = await apiGet<{ drafts?: unknown; error?: string }>({
      apiPort: args.apiPort,
      uiToken: args.uiToken,
      pathPart: '/v1/solvernets/drafts',
    });
    if (res.status === 200) return;
    if (res.status !== 503) {
      throw new Error(
        `unexpected status from /v1/solvernets/drafts during subsystem-ready wait: ${res.status} ${JSON.stringify(res.json)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`SolverNet subsystem did not become ready within ${args.timeoutMs ?? 90000}ms`);
}

interface LaunchedRecord {
  solverNetId: string;
  manifestCid: string;
  status: 'launching' | 'launched' | 'paused' | 'retired' | 'failed';
  statusUpdatedAt: string;
  launchProgress?: {
    phase?: string;
    txError?: { message: string; at: string };
    attemptCount: number;
  };
  registry: {
    metadataTxHash?: `0x${string}`;
    metadataBlockNumber?: number;
  };
}

async function pollUntilLaunched(args: {
  apiPort: number;
  uiToken: string;
  solverNetId: string;
  timeoutMs?: number;
}): Promise<LaunchedRecord> {
  const deadline = Date.now() + (args.timeoutMs ?? 5 * 60 * 1000);
  let lastPhase = '';
  while (Date.now() < deadline) {
    const res = await apiGet<LaunchedRecord & { error?: string }>({
      apiPort: args.apiPort,
      uiToken: args.uiToken,
      pathPart: `/v1/solvernets/launched/${encodeURIComponent(args.solverNetId)}`,
    });
    if (res.status === 200) {
      const phase = res.json.launchProgress?.phase ?? res.json.status;
      if (phase !== lastPhase) {
        logErr(`launched-record status=${res.json.status} phase=${phase}`);
        lastPhase = phase;
      }
      if (res.json.status === 'launched') return res.json;
      if (res.json.status === 'failed') {
        const errMsg = res.json.launchProgress?.txError?.message ?? '(no error message)';
        throw new Error(
          `launch failed for ${args.solverNetId}: ${errMsg}`,
        );
      }
    } else if (res.status !== 404) {
      throw new Error(
        `unexpected /v1/solvernets/launched/:id status ${res.status}: ${JSON.stringify(res.json)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `timed out waiting for launched record to reach status=launched after ${args.timeoutMs ?? 5 * 60 * 1000}ms`,
  );
}

export interface LaunchIsolatedOptions {
  opAName?: string;
  apiPort?: number;
  name?: string;
  description?: string;
  solutionPriceWei?: string;
  verdictPriceWei?: string;
}

export async function launchIsolatedSolverNet(opts: LaunchIsolatedOptions = {}): Promise<LaunchOutput> {
  throw new Error(
    'SolverNet creation/launch HTTP retired in Stage 6 Task 17. This helper cannot drive /v1/solvernets/drafts any more.',
  );
  const opAName = opts.opAName ?? 'op-a';
  const opAHome = goldPath(opAName);
  const apiPort = opts.apiPort ?? 7390;
  const name = opts.name ?? DEFAULT_NAME;
  const description = opts.description ?? DEFAULT_DESCRIPTION;
  const solutionPriceWei = opts.solutionPriceWei ?? DEFAULT_SOLUTION_PRICE_WEI;
  const verdictPriceWei = opts.verdictPriceWei ?? DEFAULT_VERDICT_PRICE_WEI;

  logErr(`opAHome=${opAHome}`);
  logErr(`apiPort=${apiPort}`);
  logErr(`name="${name}"`);

  const uiToken = await readUiToken(opAHome);
  logErr(`ui-token loaded (len=${uiToken.length})`);

  const daemon = await spawnOpADaemon({ opAHome, apiPort });
  logErr(`op-a daemon up (pid=${daemon.process.pid})`);

  try {
    await waitForSubsystemReady({ apiPort, uiToken });
    logErr('SolverNet subsystem ready');

    // 1. Create the draft with all required fields in one POST (the wizard
    //    PATCHes incrementally, but a single POST is equivalent so long as
    //    the body validates).
    const createBody = {
      name,
      description,
      templateContractId: 'swe-rebench-v2',
      templateContractVersion: 'v1',
      solutionPriceWei,
      verdictPriceWei,
      openRoles: ['solver', 'evaluator'] as const,
      completedSteps: ['define', 'reviewContract', 'configureGenerator', 'configurePricing'] as const,
    };
    const create = await apiPost<DraftResponse & { error?: string; message?: string }>({
      apiPort,
      uiToken,
      pathPart: '/v1/solvernets/drafts',
      body: createBody,
    });
    if (create.status !== 200 || !create.json.draftId) {
      throw new Error(
        `POST /v1/solvernets/drafts failed: status=${create.status} body=${JSON.stringify(create.json)}`,
      );
    }
    const draftId = create.json.draftId;
    logErr(`draft created: ${draftId}`);

    // 2. Launch.
    const launch = await apiPost<{
      solverNetId?: string;
      status?: string;
      pollUrl?: string;
      error?: string;
      message?: string;
      missingFields?: string[];
    }>({
      apiPort,
      uiToken,
      pathPart: `/v1/solvernets/drafts/${encodeURIComponent(draftId)}/launch`,
      body: {},
    });
    if (launch.status !== 202 || !launch.json.solverNetId) {
      throw new Error(
        `POST /v1/solvernets/drafts/:id/launch failed: status=${launch.status} body=${JSON.stringify(launch.json)}`,
      );
    }
    const solverNetId = launch.json.solverNetId;
    logErr(`launch kicked off: solverNetId=${solverNetId}`);

    // 3. Poll until launched.
    const record = await pollUntilLaunched({
      apiPort,
      uiToken,
      solverNetId,
      // IPFS pin + setMetadata tx + receipt + post-launch subsystem warm-up
      // can run ~1–3 minutes on Base Sepolia in practice; give 5 minutes.
      timeoutMs: 5 * 60 * 1000,
    });

    const metadataTxHash = record.registry.metadataTxHash;
    const metadataBlockNumber = record.registry.metadataBlockNumber;
    if (!metadataTxHash || metadataBlockNumber === undefined) {
      throw new Error(
        `launched record reached status=launched but registry.metadata{TxHash,BlockNumber} missing: ${JSON.stringify(record)}`,
      );
    }

    return {
      manifestCid: record.manifestCid,
      solverNetId: record.solverNetId,
      metadataTxHash,
      metadataBlockNumber,
      name,
      launchedAt: record.statusUpdatedAt,
    };
  } finally {
    await daemon.kill();
    logErr(`op-a daemon terminated`);
  }
}

async function cliMain(): Promise<void> {
  // Argument parsing — minimal, all optional.
  const args = process.argv.slice(2);
  const opts: LaunchIsolatedOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--name' && args[i + 1]) {
      opts.name = args[++i];
    } else if (a === '--port' && args[i + 1]) {
      opts.apiPort = parseInt(args[++i]!, 10);
    } else if (a === '--description' && args[i + 1]) {
      opts.description = args[++i];
    } else if (a === '--solution-price-wei' && args[i + 1]) {
      opts.solutionPriceWei = args[++i];
    } else if (a === '--verdict-price-wei' && args[i + 1]) {
      opts.verdictPriceWei = args[++i];
    } else if (a === '--op-a-name' && args[i + 1]) {
      opts.opAName = args[++i];
    } else if (a === '--help' || a === '-h') {
      process.stderr.write(
        `Usage: tsx scripts/release/launch-isolated-solvernet.ts \\\n` +
          `  [--name <name>] [--description <text>] \\\n` +
          `  [--solution-price-wei <wei>] [--verdict-price-wei <wei>] \\\n` +
          `  [--op-a-name <op-a>] [--port <api-port>]\n`,
      );
      process.exit(0);
    }
  }
  const result = await launchIsolatedSolverNet(opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    process.stderr.write(`[launch-isolated-solvernet] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exit(1);
  });
}
