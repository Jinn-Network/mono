#!/usr/bin/env node
/**
 * Real testnet packaged-operator acceptance harness.
 *
 * This validates the packaged `jinn` artifact in the same shape operators use it:
 * install package -> generate operator config -> bootstrap -> run daemon ->
 * observe two new protocol cycles -> inspect state -> claim rewards.
 *
 * The harness is intentionally manual / release-manager driven. It is not part of
 * PR CI or canary publishing.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  defaultAcceptanceHome,
  toInt,
  buildOperatorClientConfig,
  buildAcceptanceChildEnv,
  acceptanceClientHome,
  acceptanceXdgPaths,
  resolveAcceptanceRpcUrl,
} from './lib/acceptance-operator-config.mjs';
import { PASSWORD_RESOLUTION_HINT, resolveAcceptancePassword } from './lib/resolve-acceptance-password.mjs';
import { readRunWindowArtifactProgress } from './lib/acceptance-artifacts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const DEFAULT_PACKAGE_SPEC = '@jinn-network/operator@canary';
const DEFAULT_TARBALL = join(clientRoot, 'jinn-client.tgz');
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TARGET_CYCLES = 1;

function printHelp() {
  console.log(`Usage: node scripts/testnet-acceptance.mjs [options]

Runs the legacy host-installed real-testnet acceptance harness. The primary
release gate is now Docker-first via \`yarn release:testnet-acceptance\`.
Use this host path only for secondary smoke/debug coverage:
  yarn typecheck
  yarn test
  yarn build
  yarn pack:smoke
  yarn release:operator-gate
  yarn release:testnet-acceptance
  yarn release:testnet-acceptance:host
  git tag client-vX.Y.Z

Options:
  --artifact-source <tarball|npm>   Package source (default: tarball)
  --tarball <path>                  Tarball path for tarball mode
  --package-spec <spec>             npm package spec for npm mode
  --mode <steady-state|fresh-state> Validation mode (default: steady-state)
  --home <path>                     Acceptance HOME root (default: ~/.jinn-testnet-acceptance)
  --evidence-dir <path>             Explicit evidence directory
  --timeout-ms <ms>                 Max daemon runtime window (default: 1200000)
  --poll-ms <ms>                    Poll interval while waiting for cycles
  --target-cycles <n>               Required new cycles (default: 1)
  --help                            Show this help

Required environment:
  JINN_TESTNET_ACCEPTANCE_RPC_URL or BASE_SEPOLIA_RPC_URL   Base Sepolia RPC

Keystore password: JINN_PASSWORD or JINN_TESTNET_ACCEPTANCE_PASSWORD, or
  <home>/.jinn-client/keystore-password / ~/.jinn-client/keystore-password

Optional environment:
  JINN_TESTNET_ACCEPTANCE_HOME
  JINN_TESTNET_ACCEPTANCE_NETWORK                (default: testnet)
  JINN_TESTNET_ACCEPTANCE_CLAUDE_PATH
  JINN_TESTNET_ACCEPTANCE_CLAUDE_MODEL
  JINN_TESTNET_ACCEPTANCE_NODE_ENDPOINT
  JINN_TESTNET_ACCEPTANCE_POLL_INTERVAL_MS
  JINN_TESTNET_ACCEPTANCE_TARGET_SERVICES
  JINN_TESTNET_ACCEPTANCE_TESTNET_L2_DEPLOYMENT
  JINN_TESTNET_ACCEPTANCE_TESTNET_TOKEN_DEPLOYMENT
  JINN_TESTNET_ACCEPTANCE_TESTNET_MECH_DEPLOYMENT
  JINN_TESTNET_ACCEPTANCE_TESTNET_STOLAS_DEPLOYMENT

The harness writes evidence under:
  <home>/acceptance-runs/<timestamp>-<runId>/
`);
}

function fail(message, details) {
  const err = new Error(message);
  err.details = details;
  throw err;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function makeRunId() {
  return `${timestampSlug()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJsonStdout(stdout, label) {
  const trimmed = stdout.trim();
  if (!trimmed) fail(`${label}: expected JSON stdout but stdout was empty`);
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{') && !lines[i].startsWith('[')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning
    }
  }
  fail(`${label}: stdout did not contain JSON`, { stdout });
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runLoggedProcess(command, args, options = {}) {
  const result = runProcess(command, args, options);
  if (options.evidenceBase) {
    writeFileSync(`${options.evidenceBase}.stdout`, result.stdout, 'utf8');
    writeFileSync(`${options.evidenceBase}.stderr`, result.stderr, 'utf8');
  }
  return result;
}

function expectExit(result, expected, label) {
  if (!expected.includes(result.status)) {
    fail(`${label}: unexpected exit ${result.status}`, {
      expected,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}

function countHistoryKinds(payload) {
  const counts = {};
  for (const event of payload.events ?? []) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}

function sumPendingRewards(payload) {
  return (payload.services ?? []).reduce((sum, svc) => sum + BigInt(svc.pending ?? '0'), 0n);
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main() {
  const parsed = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      'artifact-source': { type: 'string', default: 'tarball' },
      tarball: { type: 'string' },
      'package-spec': { type: 'string' },
      mode: { type: 'string', default: 'steady-state' },
      home: { type: 'string' },
      'evidence-dir': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'poll-ms': { type: 'string' },
      'target-cycles': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    printHelp();
    return;
  }

  const artifactSource = parsed.values['artifact-source'];
  const mode = parsed.values.mode;
  if (!['tarball', 'npm'].includes(artifactSource)) {
    fail(`Unsupported --artifact-source: ${artifactSource}`);
  }
  if (!['steady-state', 'fresh-state'].includes(mode)) {
    fail(`Unsupported --mode: ${mode}`);
  }

  const env = process.env;
  const acceptanceHome = resolve(
    parsed.values.home
      ?? env['JINN_TESTNET_ACCEPTANCE_HOME']
      ?? defaultAcceptanceHome(),
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
  const evidenceDir = resolve(
    parsed.values['evidence-dir']
      ?? join(acceptanceHome, 'acceptance-runs', makeRunId()),
  );
  const installDir = join(evidenceDir, 'package-install');
  const runId = evidenceDir.split('/').pop() ?? makeRunId();
  const timeoutMs = toInt(parsed.values['timeout-ms'], DEFAULT_TIMEOUT_MS);
  const pollMs = toInt(parsed.values['poll-ms'], DEFAULT_POLL_MS);
  const targetCycles = toInt(parsed.values['target-cycles'], DEFAULT_TARGET_CYCLES);

  ensureDir(evidenceDir);
  ensureDir(dirname(clientHome));

  const summary = {
    startedAt: new Date().toISOString(),
    artifactSource,
    mode,
    acceptanceHome,
    clientHome,
    evidenceDir,
    installDir,
    timeoutMs,
    pollMs,
    targetCycles,
  };
  writeJson(join(evidenceDir, 'inputs.json'), summary);

  if (mode === 'fresh-state') {
    rmSync(clientHome, { recursive: true, force: true });
  }
  ensureDir(clientHome);
  ensureDir(xdg.configHome);
  ensureDir(xdg.dataHome);
  ensureDir(xdg.cacheHome);

  const config = buildOperatorClientConfig({
    rpcUrl,
    clientHome,
    runIdSuffix: runId,
    env,
  });
  if (targetCycles < 1) {
    fail(`target-cycles (${targetCycles}) must be >= 1.`);
  }
  writeJson(join(clientHome, 'config.json'), config);

  const childEnv = buildAcceptanceChildEnv(acceptanceHome, password);

  ensureDir(installDir);
  const npmInit = runLoggedProcess('npm', ['init', '-y'], {
    cwd: installDir,
    env: childEnv,
    evidenceBase: join(evidenceDir, 'npm-init'),
  });
  expectExit(npmInit, [0], 'npm init');

  let artifactLabel;
  if (artifactSource === 'tarball') {
    const tarballPath = resolve(parsed.values.tarball ?? DEFAULT_TARBALL);
    if (!existsSync(tarballPath)) {
      fail(`Tarball not found: ${tarballPath}. Run yarn pack -o jinn-client.tgz first.`);
    }
    artifactLabel = tarballPath;
    const install = runLoggedProcess('npm', ['install', tarballPath], {
      cwd: installDir,
      env: childEnv,
      evidenceBase: join(evidenceDir, 'npm-install'),
    });
    expectExit(install, [0], 'npm install tarball');
  } else {
    const packageSpec = parsed.values['package-spec'] ?? env['JINN_TESTNET_ACCEPTANCE_PACKAGE_SPEC'] ?? DEFAULT_PACKAGE_SPEC;
    artifactLabel = packageSpec;
    const install = runLoggedProcess('npm', ['install', packageSpec], {
      cwd: installDir,
      env: childEnv,
      evidenceBase: join(evidenceDir, 'npm-install'),
    });
    expectExit(install, [0], 'npm install package');
  }
  writeJson(join(evidenceDir, 'artifact.json'), { source: artifactSource, value: artifactLabel });

  const execJinn = (args, stepName, expected = [0]) => {
    const result = runLoggedProcess('npm', ['exec', '--yes', '--', 'jinn', ...args], {
      cwd: installDir,
      env: childEnv,
      evidenceBase: join(evidenceDir, stepName),
    });
    expectExit(result, expected, stepName);
    return result;
  };

  const version = parseJsonStdout(execJinn(['version', '--json'], '01-version').stdout, 'version');
  const help = execJinn(['--help'], '02-help');
  if (!help.stdout.includes('jinn run')) {
    fail('help: expected top-level help text to include `jinn run`.');
  }

  const doctor = parseJsonStdout(execJinn(['doctor', '--json'], '03-doctor').stdout, 'doctor');
  if (doctor.ok !== true) {
    fail('doctor: expected ok=true for release acceptance environment', doctor);
  }

  const bootstrap = parseJsonStdout(execJinn(['bootstrap', '--json'], '04-bootstrap').stdout, 'bootstrap');
  if (!Array.isArray(bootstrap.services) || bootstrap.services.length === 0) {
    fail('bootstrap: expected at least one service in bootstrap response', bootstrap);
  }
  if (!bootstrap.services.some((svc) => svc.step === 'complete')) {
    fail('bootstrap: expected at least one complete service', bootstrap);
  }

  const baselineHistory = parseJsonStdout(execJinn(['history', '--limit', '500', '--json'], '05-history-before').stdout, 'history-before');
  const baselineCounts = countHistoryKinds(baselineHistory);
  const runStartAt = new Date().toISOString();
  const baselineArtifacts = readRunWindowArtifactProgress(config.dbPath, runStartAt);
  const baselineRewards = parseJsonStdout(execJinn(['rewards', '--json'], '06-rewards-before').stdout, 'rewards-before');
  const baselineStatus = parseJsonStdout(execJinn(['status', '--json'], '07-status-before').stdout, 'status-before');
  writeJson(join(evidenceDir, 'baseline-summary.json'), {
    historyCounts: baselineCounts,
    runStartAt,
    cycleSubstrate: 'prediction.v0',
    artifactProgress: baselineArtifacts.byTaskId,
    pendingRewardsWei: sumPendingRewards(baselineRewards).toString(),
    status: baselineStatus,
  });

  const daemonStdoutPath = join(evidenceDir, '08-run.stdout.log');
  const daemonStderrPath = join(evidenceDir, '08-run.stderr.log');
  let daemonStdout;
  let daemonStderr;
  let daemon;
  let daemonExited;
  let daemonExitCode = null;

  try {
    daemonStdout = createWriteStream(daemonStdoutPath, { flags: 'a' });
    daemonStderr = createWriteStream(daemonStderrPath, { flags: 'a' });
    daemon = spawn('npm', ['exec', '--yes', '--', 'jinn', 'run', '--json'], {
      cwd: installDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let startupPayload = null;
    let startupBuffer = '';
    daemonExited = new Promise((resolvePromise) => {
      daemon.on('close', (code) => {
        daemonExitCode = code;
        resolvePromise(code);
      });
    });
    const startupReady = new Promise((resolvePromise, rejectPromise) => {
      daemon.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        daemonStdout.write(text);
        startupBuffer += text;
        const lines = startupBuffer.split('\n');
        startupBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const payload = JSON.parse(trimmed);
            if (payload.kind === 'daemon_started') {
              startupPayload = payload;
              resolvePromise(payload);
              return;
            }
          } catch {
            // ignore non-json lines
          }
        }
      });
      daemon.stderr.on('data', (chunk) => {
        daemonStderr.write(chunk);
      });
      daemon.on('error', rejectPromise);
      daemon.on('close', (code) => {
        if (!startupPayload) {
          rejectPromise(new Error(`daemon exited before startup record (exit ${code})`));
        }
      });
    });

    const startup = await startupReady;
    writeJson(join(evidenceDir, '08-run.startup.json'), startup);

    let observed = null;
    const pollPath = join(evidenceDir, '09-cycle-poll.jsonl');
    const pollStartedAt = Date.now();
    while (Date.now() - pollStartedAt < timeoutMs) {
      if (daemonExitCode !== null) {
        fail(`daemon exited before acceptance completed (exit ${daemonExitCode})`);
      }

      const status = parseJsonStdout(execJinn(['status', '--json'], '09-status-poll').stdout, 'status-poll');
      const artifactProgress = readRunWindowArtifactProgress(config.dbPath, runStartAt);
      const snapshot = {
        at: new Date().toISOString(),
        runStartAt,
        completedCycles: artifactProgress.completedCycles,
        artifactProgress: artifactProgress.byTaskId,
        blocking: status.exit?.blocking ?? false,
        daemonShutdownState: status.daemon?.shutdownState ?? null,
      };
      appendFileSync(pollPath, `${JSON.stringify(snapshot)}\n`, 'utf8');

      if (artifactProgress.completedCycles >= targetCycles) {
        observed = { artifactProgress, status };
        break;
      }
      await sleep(pollMs);
    }

    if (!observed) {
      fail(`Timed out waiting for ${targetCycles} new protocol cycles`, {
        pollPath,
        timeoutMs,
      });
    }

    const stop = parseJsonStdout(execJinn(['stop', '--json'], '10-stop').stdout, 'stop');
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('daemon did not exit within 60s after jinn stop')), 60_000);
      daemonExited.then((value) => {
        clearTimeout(timer);
        resolvePromise(value);
      }, rejectPromise);
    });

    const fleet = parseJsonStdout(execJinn(['fleet', '--json'], '11-fleet-after').stdout, 'fleet-after');
    const statusAfter = parseJsonStdout(execJinn(['status', '--json'], '12-status-after').stdout, 'status-after');
    const rewardsBeforeClaim = parseJsonStdout(execJinn(['rewards', '--json'], '13-rewards-before-claim').stdout, 'rewards-before-claim');
    const historyAfter = parseJsonStdout(execJinn(['history', '--limit', '500', '--json'], '14-history-after').stdout, 'history-after');
    const artifactsAfter = readRunWindowArtifactProgress(config.dbPath, runStartAt);
    writeJson(join(evidenceDir, '14-artifacts-after.json'), artifactsAfter);

    const claim = parseJsonStdout(execJinn(['claim-rewards', '--yes', '--json'], '15-claim-rewards').stdout, 'claim-rewards');
    const pendingBeforeClaim = sumPendingRewards(rewardsBeforeClaim);
    const rewardClaimMode = pendingBeforeClaim > 0n ? 'submitted' : 'no-pending';
    if (pendingBeforeClaim > 0n && (claim.submitted ?? 0) <= 0) {
      fail('claim-rewards: expected submitted > 0 when pending rewards are visible', claim);
    }
    if (
      pendingBeforeClaim === 0n
      && (claim.submitted ?? 0) <= 0
      && (claim.skippedNoPending ?? 0) <= 0
    ) {
      fail('claim-rewards: expected an idempotent no-pending result when pending rewards are zero', claim);
    }

    const summaryOut = {
      ...summary,
      finishedAt: new Date().toISOString(),
      artifact: { source: artifactSource, value: artifactLabel },
      version,
      bootstrap,
      startup,
      stop,
      runStartAt,
      cycleSubstrate: 'prediction.v0',
      observedCompletedCycles: observed.artifactProgress.completedCycles,
      observedArtifactProgress: observed.artifactProgress.byTaskId,
      baselineHistoryCounts: baselineCounts,
      baselineArtifactProgress: baselineArtifacts.byTaskId,
      pendingRewardsBeforeClaimWei: pendingBeforeClaim.toString(),
      rewardClaimMode,
      claim,
      fleet,
      statusBefore: baselineStatus,
      statusAfter,
      historyAfterCounts: countHistoryKinds(historyAfter),
    };
    writeJson(join(evidenceDir, 'summary.json'), summaryOut);

    console.log(`testnet-acceptance:host ok`);
    console.log(`  artifact: ${artifactLabel}`);
    console.log(`  home: ${acceptanceHome}`);
    console.log(`  evidence: ${evidenceDir}`);
    console.log(`  version: ${version.client?.version ?? 'unknown'}`);
    console.log(`  commit: ${version.client?.commit ?? 'unknown'}`);
    console.log(`  pending before claim: ${pendingBeforeClaim.toString()} wei`);
    console.log(`  submitted claims: ${claim.submitted}`);
  } finally {
    daemonStdout?.end();
    daemonStderr?.end();
    if (daemon && daemon.exitCode === null && !daemon.killed) {
      daemon.kill('SIGTERM');
      if (daemonExited) {
        await Promise.race([daemonExited, sleep(10_000)]);
      }
      if (daemon.exitCode === null && !daemon.killed) {
        daemon.kill('SIGKILL');
      }
    }
  }
}

main().catch((error) => {
  console.error('testnet-acceptance:host failed');
  console.error(error instanceof Error ? error.message : String(error));
  if (error && typeof error === 'object' && 'details' in error && error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exit(1);
});
