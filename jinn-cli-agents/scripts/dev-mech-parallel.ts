#!/usr/bin/env tsx
/**
 * Parallel Worker Launcher
 *
 * Spawns multiple worker processes with isolated WORKER_IDs for parallel
 * processing of jobs in a workstream.
 *
 * Usage:
 *   yarn dev:mech:parallel --workers=3 --workstream=0x...
 *   yarn dev:mech:parallel -w 3 -s 0x... --runs=10
 *   yarn dev:mech:parallel -w 2 -s 0x... --no-fresh  # Keep existing clones
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { rmSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

/**
 * Get the base directory for worker clones
 * Matches the logic in shared/repo_utils.ts
 */
function getWorkerClonesBaseDir(): string {
  const baseDir = process.env.JINN_WORKSPACE_DIR || '~/jinn-repos';
  const expandedBase = baseDir.startsWith('~')
    ? join(homedir(), baseDir.slice(1))
    : baseDir;
  return join(expandedBase, 'workers');
}

/**
 * Kill any processes using the worker directories
 * This is necessary because Gemini CLI, MCP servers, and Chrome processes
 * may linger after worker exits, preventing directory cleanup.
 */
function killProcessesUsingWorkerDirs(): void {
  const baseDir = getWorkerClonesBaseDir();
  if (!existsSync(baseDir)) {
    return;
  }

  try {
    // Use lsof to find PIDs of processes using the worker directories
    const lsofOutput = execSync(`lsof +D "${baseDir}" 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    // Extract unique PIDs from lsof output (skip header line)
    const lines = lsofOutput.trim().split('\n').slice(1);
    const pids = new Set<string>();
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
        pids.add(parts[1]);
      }
    }

    if (pids.size > 0) {
      console.log(`[cleanup] Killing ${pids.size} lingering processes using worker directories...`);
      const pidList = Array.from(pids).join(' ');
      execSync(`kill -9 ${pidList} 2>/dev/null || true`, { encoding: 'utf-8' });
      // Brief pause to let OS release file handles
      execSync('sleep 1', { encoding: 'utf-8' });
    }
  } catch (err) {
    // Ignore errors - lsof or kill may fail if no processes exist
    console.log('[cleanup] Warning: Could not check/kill lingering processes');
  }
}

/**
 * Delete all worker clone directories to ensure fresh state
 */
function cleanWorkerClones(workerCount: number): void {
  // First, kill any lingering processes that might hold directories open
  killProcessesUsingWorkerDirs();

  const baseDir = getWorkerClonesBaseDir();

  for (let i = 1; i <= workerCount; i++) {
    const workerDir = join(baseDir, `worker-${i}`);
    if (existsSync(workerDir)) {
      console.log(`[cleanup] Removing ${workerDir}`);
      rmSync(workerDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('workers', {
      alias: 'w',
      type: 'number',
      default: 2,
      description: 'Number of parallel workers to spawn',
    })
    .option('workstream', {
      alias: 's',
      type: 'string',
      demandOption: true,
      description: 'Workstream ID to filter jobs (required)',
    })
    .option('runs', {
      type: 'number',
      description: 'Maximum number of jobs per worker',
    })
    .option('max-cycles', {
      type: 'number',
      description: 'Maximum number of cycles before stopping (root cyclic jobs only)',
    })
    .option('single', {
      type: 'boolean',
      description: 'Exit after processing one job per worker',
    })
    .option('fresh', {
      type: 'boolean',
      default: false,
      description: 'Delete worker clones before starting. Use --fresh for clean state, but may cause SSH exhaustion if cloning concurrently.',
    })
    .option('stagger', {
      type: 'number',
      default: 10,
      description: 'Delay in seconds between starting workers (default: 10)',
    })
    .example('$0 -w 3 -s 0x123...', 'Run 3 workers on workstream 0x123...')
    .example('$0 -w 2 -s 0x123... --runs=5', 'Run 2 workers, 5 jobs each')
    .example('$0 -w 2 -s 0x123... --fresh', 'Fresh start with clean clones')
    .help()
    .parse();

  const children: ChildProcess[] = [];
  const workerCount = argv.workers;
  const maxCycles = argv['max-cycles'];
  const startDelayMs = (argv.stagger || 0) * 1000;
  const stopFilePath = maxCycles ? `/tmp/jinn-stop-cycle-${argv.workstream}` : undefined;

  // Clean worker clones if --fresh is explicitly requested
  if (argv.fresh) {
    console.log('[cleanup] --fresh requested: cleaning worker clone directories...');
    cleanWorkerClones(workerCount);
    console.log('[cleanup] Clean complete. Note: Fresh clones may cause SSH rate limiting with many workers.\n');
  }

  if (stopFilePath && existsSync(stopFilePath)) {
    unlinkSync(stopFilePath);
  }

  console.log(`Starting ${workerCount} parallel workers on workstream ${argv.workstream.slice(0, 10)}...`);
  if (startDelayMs > 0) {
    console.log(`Staggering start by ${argv.stagger} seconds.`);
  }
  console.log('Press Ctrl+C to stop all workers\n');

  // Spawn workers
  for (let i = 1; i <= workerCount; i++) {
    // Stagger delay (skip for first worker)
    if (i > 1 && startDelayMs > 0) {
      console.log(`Waiting ${argv.stagger}s before starting worker-${i}...`);
      await new Promise(resolve => setTimeout(resolve, startDelayMs));
    }

    const workerId = `worker-${i}`;
    const args = ['dev:mech:raw', `--workstream=${argv.workstream}`];

    if (argv.runs) args.push(`--runs=${argv.runs}`);
    if (maxCycles) args.push(`--max-cycles=${maxCycles}`);
    if (argv.single) args.push('--single');

    const child = spawn('yarn', args, {
      env: {
        ...process.env,
        WORKER_ID: workerId,
        ...(maxCycles ? { WORKER_MAX_CYCLES: String(maxCycles) } : {}),
        ...(stopFilePath ? { WORKER_STOP_FILE: stopFilePath } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    // Prefix stdout with worker ID
    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          console.log(`[${workerId}] ${line}`);
        }
      });
    });

    // Prefix stderr with worker ID
    child.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          console.error(`[${workerId}] ${line}`);
        }
      });
    });

    child.on('exit', (code) => {
      console.log(`[${workerId}] Exited with code ${code}`);
    });

    children.push(child);
    console.log(`[${workerId}] Started (PID: ${child.pid})`);
  }

  // Handle Ctrl+C - gracefully kill all workers
  const cleanup = () => {
    console.log('\nStopping all workers...');
    children.forEach((child, i) => {
      if (!child.killed) {
        child.kill('SIGTERM');
        console.log(`[worker-${i + 1}] Sent SIGTERM`);
      }
    });

    // Force kill after 5 seconds
    setTimeout(() => {
      children.forEach((child, i) => {
        if (!child.killed) {
          child.kill('SIGKILL');
          console.log(`[worker-${i + 1}] Force killed`);
        }
      });
      process.exit(0);
    }, 5000);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Wait for all children to exit
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          child.on('exit', () => resolve());
        })
    )
  );

  console.log('\nAll workers finished.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
