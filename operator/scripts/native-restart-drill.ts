#!/usr/bin/env tsx
// operator/scripts/native-restart-drill.ts
/**
 * The Phase B restart-drill harness entrypoint (#2434, umbrella #2429).
 *
 *   yarn drill:native-restart --out ./drill-reports
 *   yarn drill:native-restart --out ./drill-reports --fork-url "$BASE_SEPOLIA_RPC_URL"
 *
 * Runs the six mandatory restart drills named by `docs/runbooks/phase-b-native-vertical.md` and
 * required by `PhaseBClosureManifestSchema.recoveryReports`, and writes one sanitized, canonical,
 * digested report per checkpoint.
 *
 * Chain modes:
 *  - default `hermetic` — a local Anvil pinned to chain id 84532. No network, fully deterministic,
 *    never skips. Anvil's own finality semantics (`finalized` trails `latest` by 64 blocks) make
 *    the "execution starts only after canonical finality" proof real rather than asserted.
 *  - `--fork-url <rpc>` — an Anvil fork of Base Sepolia pinned at `--fork-block` (recorded in every
 *    report, so the fork run is re-runnable), for forked-contract fidelity before the live run.
 *
 * The harness re-invokes itself with `--role-run <path>` for each role-host child process; that is
 * the real OS process the drill kills and restarts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNativeDeployment } from '../src/daemon/native-vertical-mode.js';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import {
  BOUNDARY_MARKER,
  OBSERVATION_MARKER,
  main as roleHostMain,
} from '../src/native-drill/role-host.js';
import { runRestartDrill, type RoleHostLauncher, type RoleRunResult } from '../src/native-drill/driver.js';
import type { DrillRecoveryReport } from '../src/native-drill/report.js';

const HERE = fileURLToPath(import.meta.url);

interface Options {
  readonly out: string;
  readonly forkUrl?: string;
  readonly forkBlock?: number;
  readonly roleRun?: string;
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`option ${token} requires a value`);
    }
    values.set(token.slice(2), next);
    index += 1;
  }
  const forkBlock = values.get('fork-block');
  if (forkBlock !== undefined && !/^\d+$/u.test(forkBlock)) {
    throw new Error('--fork-block must be a block number');
  }
  if (forkBlock !== undefined && values.get('fork-url') === undefined) {
    throw new Error('--fork-block requires --fork-url');
  }
  return {
    out: resolve(values.get('out') ?? './native-restart-drill-reports'),
    forkUrl: values.get('fork-url'),
    forkBlock: forkBlock === undefined ? undefined : Number(forkBlock),
    roleRun: values.get('role-run'),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolveWith, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not allocate an Anvil port')));
        return;
      }
      const { port } = address;
      server.close(() => resolveWith(port));
    });
  });
}

interface AnvilProcess {
  readonly rpcUrl: string;
  stop(): Promise<void>;
}

async function startAnvil(options: Options): Promise<AnvilProcess> {
  const port = await freePort();
  const args = ['--port', String(port), '--silent', '--chain-id', '84532'];
  if (options.forkUrl !== undefined) {
    args.push('--fork-url', options.forkUrl);
    if (options.forkBlock !== undefined) args.push('--fork-block-number', String(options.forkBlock));
  }
  const child = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('anvil exited before becoming ready');
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (response.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('anvil did not become ready within 30s');
    await new Promise((wait) => setTimeout(wait, 200));
  }
  return {
    rpcUrl,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGKILL');
      await new Promise((wait) => child.once('exit', wait));
    },
  };
}

/**
 * How a child re-invokes this file. The parent runs under tsx, so a TypeScript entrypoint needs
 * the loader passed on explicitly; a compiled `.js` entrypoint needs nothing.
 */
function childNodeArgs(): readonly string[] {
  const argv = [...process.execArgv];
  const hasLoader = argv.some((argument) => argument.includes('tsx'))
    || (process.env['NODE_OPTIONS'] ?? '').includes('tsx');
  if (HERE.endsWith('.ts') && !hasLoader) argv.push('--import', 'tsx');
  return argv;
}

/** Launches each role host as a real child process and SIGKILLs it at the boundary marker. */
function createLauncher(specDir: string): RoleHostLauncher {
  return {
    launch(spec, { killAtBoundary }) {
      const specPath = join(specDir, `${spec.seed}-${spec.mode}.json`);
      writeFileSync(specPath, JSON.stringify(spec), 'utf8');
      return new Promise<RoleRunResult>((resolveWith) => {
        const child: ChildProcess = spawn(
          process.execPath,
          [...childNodeArgs(), HERE, '--role-run', specPath],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        let buffer = '';
        let outcome: RoleRunResult | undefined;
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.startsWith(BOUNDARY_MARKER)) {
              if (!killAtBoundary) continue;
              outcome = { kind: 'killed-at-boundary' };
              child.kill('SIGKILL');
              continue;
            }
            if (line.startsWith(OBSERVATION_MARKER)) {
              outcome = {
                kind: 'observed',
                observation: JSON.parse(line.slice(OBSERVATION_MARKER.length + 1)),
              };
            }
          }
        });
        child.on('error', (error) => {
          resolveWith({ kind: 'failed', reason: error.message });
        });
        child.on('exit', (code, signal) => {
          if (outcome !== undefined) {
            resolveWith(outcome);
            return;
          }
          resolveWith({
            kind: 'failed',
            reason: `role host exited with code ${code ?? 'null'} signal ${signal ?? 'none'} `
              + 'without reporting an observation or reaching the boundary',
          });
        });
      });
    },
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  if (options.roleRun !== undefined) {
    await roleHostMain(readFileSync(options.roleRun, 'utf8'));
    return;
  }

  // The drill runs the native vertical's own boot gate before it runs anything else: a drill on a
  // configuration the native product would refuse proves nothing.
  assertNativeDeployment({ network: 'testnet', chain: BASE_SEPOLIA_TODAY });

  const chain: DrillRecoveryReport['chain'] = options.forkUrl === undefined
    ? { chainId: 84532, mode: 'hermetic' }
    : {
        chainId: 84532,
        mode: 'fork',
        ...(options.forkBlock === undefined ? {} : { forkBlockNumber: String(options.forkBlock) }),
      };
  if (chain.mode === 'fork' && chain.forkBlockNumber === undefined) {
    console.warn(
      '[drill] --fork-url without --fork-block pins nothing: this run is not exactly re-runnable.',
    );
  }

  mkdirSync(options.out, { recursive: true });
  const workspace = mkdtempSync(join(tmpdir(), 'jinn-native-restart-drill-'));
  const anvil = await startAnvil(options);
  try {
    console.log(`[drill] anvil ${chain.mode} at ${anvil.rpcUrl} (chain id 84532)`);
    const reports = await runRestartDrill({
      rpcUrl: anvil.rpcUrl,
      chain,
      stateRoot: join(workspace, 'runs'),
      launcher: createLauncher(workspace),
      now: () => new Date(),
      log: (message) => console.log(`[drill] ${message}`),
    });
    const index: Array<{ checkpoint: string; digest: string; file: string }> = [];
    for (const [checkpoint, sealed] of reports) {
      const file = `${checkpoint}.json`;
      writeFileSync(join(options.out, file), Buffer.from(sealed.bytes));
      index.push({ checkpoint, digest: sealed.digest, file });
      console.log(`[drill] ${checkpoint} PASSED — ${sealed.digest}`);
    }
    writeFileSync(
      join(options.out, 'recovery-reports.json'),
      `${JSON.stringify({ recoveryReports: index.map(({ checkpoint, digest }) => ({ checkpoint, digest })) }, null, 2)}\n`,
      'utf8',
    );
    console.log(
      `\n[drill] six recovery reports written to ${options.out}; `
      + 'recovery-reports.json carries the closure-manifest `recoveryReports` entries.',
    );
  } finally {
    await anvil.stop();
  }
}

main().catch((error: unknown) => {
  console.error('FATAL:', error);
  process.exit(1);
});
