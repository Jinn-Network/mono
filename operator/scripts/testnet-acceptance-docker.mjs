#!/usr/bin/env node
/**
 * Docker-first real testnet release acceptance harness.
 *
 * This is the primary manual end-to-end gate before creating a stable
 * client-vX.Y.Z release. It builds the local release image, runs the daemon
 * through docker compose against the dedicated acceptance volumes, observes two
 * successful protocol cycles, then submits a real reward claim.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorClientConfig,
  resolveAcceptanceRpcUrl,
  toInt,
} from './lib/acceptance-operator-config.mjs';
import {
  buildDockerComposeEnv,
  dockerAcceptanceClaudeAuthRemedy,
  dockerAcceptanceComposeEnvPath,
  dockerAcceptanceConfigPath,
  dockerAcceptanceEvidenceRoot,
  dockerAcceptanceWorkspaceRoot,
  formatEnvFile,
  hasDockerAcceptanceClaudeToken,
  resolveDockerAcceptanceBaseEnv,
} from './lib/docker-acceptance.mjs';
import { PASSWORD_RESOLUTION_HINT, resolveAcceptancePassword } from './lib/resolve-acceptance-password.mjs';
import { isoToSqliteTimestamp, summarizeRunWindowArtifacts } from './lib/acceptance-artifacts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const repoRoot = join(clientRoot, '..');
const composeFile = join(clientRoot, 'docker-compose.acceptance.yml');
const composeService = 'jinn-acceptance-daemon';
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TARGET_CYCLES = 1;

function printHelp() {
  console.log(`Usage: node scripts/testnet-acceptance-docker.mjs [options]

Runs the Docker-first real testnet release acceptance gate:
  yarn typecheck
  yarn test
  yarn build
  yarn pack:smoke
  yarn release:operator-gate
  yarn release:testnet-acceptance
  git tag client-vX.Y.Z

Options:
  --mode <steady-state|fresh-state> Validation mode (default: steady-state)
  --evidence-dir <path>             Explicit evidence directory
  --timeout-ms <ms>                 Max daemon runtime window (default: 1200000)
  --poll-ms <ms>                    Poll interval while waiting for cycles
  --target-cycles <n>               Required new cycles (default: 1)
  --image-tag <tag>                 Local image tag (default: from .env.acceptance or jinn-client:acceptance-local)
  --help                            Show this help

Env resolution:
  1. operator/.env
  2. operator/.env.acceptance
  3. current process env

Required env after resolution:
  JINN_TESTNET_ACCEPTANCE_RPC_URL or BASE_SEPOLIA_RPC_URL
  Keystore: JINN_PASSWORD or JINN_TESTNET_ACCEPTANCE_PASSWORD, or ~/.jinn-client/keystore-password

Generated files:
  operator/.acceptance/config.json
  operator/.acceptance/docker-compose.env

Evidence:
  operator/acceptance-runs/<timestamp>-<runId>/
`);
}

function fail(message, details) {
  const error = new Error(message);
  error.details = details;
  throw error;
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

function parseOptionalJsonStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{') && !lines[i].startsWith('[')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning
    }
  }
  return null;
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeoutMs,
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

function composeArgs(composeEnvPath, extra) {
  return ['compose', '--env-file', composeEnvPath, '-f', composeFile, ...extra];
}

function readGitCommit() {
  const result = runProcess('git', ['rev-parse', 'HEAD'], { cwd: clientRoot });
  if (result.status !== 0) {
    return 'unknown';
  }
  return result.stdout.trim() || 'unknown';
}

function isGitDirty() {
  const result = runProcess('git', ['status', '--short'], { cwd: clientRoot });
  return result.status === 0 && result.stdout.trim().length > 0;
}

/**
 * Warn when the current branch is more than ~2 commits behind the tip of
 * `origin/main`. This catches the class of bug we hit on 2026-04-18: the
 * deterministic acceptance prompts lived on main but were absent from a
 * long-lived drill-fix branch, so the evaluator kept returning FAILURE on
 * vague prompts even though the acceptance harness itself was working.
 * Non-fatal: logs a warning and proceeds. Skipped when git fetch can't
 * reach origin (offline / shallow clone).
 */
function warnIfBranchLagsMain() {
  const fetch = runProcess('git', ['fetch', '--quiet', 'origin', 'main'], {
    cwd: clientRoot,
    timeoutMs: 10_000,
  });
  if (fetch.status !== 0) {
    // Offline, shallow clone, or origin/main missing — silently skip.
    return;
  }
  const mergeBase = runProcess('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: clientRoot });
  const originTip = runProcess('git', ['rev-parse', 'origin/main'], { cwd: clientRoot });
  if (mergeBase.status !== 0 || originTip.status !== 0) return;
  const mb = mergeBase.stdout.trim();
  const tip = originTip.stdout.trim();
  if (mb === tip) return; // up-to-date with main
  const behind = runProcess('git', ['rev-list', '--count', `${mb}..${tip}`], { cwd: clientRoot });
  if (behind.status !== 0) return;
  const count = parseInt(behind.stdout.trim(), 10);
  if (Number.isFinite(count) && count >= 2) {
    console.error(
      `[acceptance] WARNING: this branch is ${count} commits behind origin/main. ` +
      `Acceptance harness + prompts may have evolved since the merge-base (${mb.slice(0, 8)}). ` +
      `Consider 'git rebase origin/main' before gating a release.`,
    );
  }
}

function queryDockerArtifactRows(composeEnvPath, runStartAt, evidenceBase, taskId) {
  const script = `
    import Database from 'better-sqlite3';
    import { existsSync } from 'node:fs';
    const dbPath = '/data/jinn.db';
    const since = process.argv[1];
    const taskId = process.argv[2];
    if (!existsSync(dbPath)) {
      console.log('[]');
      process.exit(0);
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(
        \`SELECT task_id, request_id, title, tags, outcome, created_at
            FROM artifacts
           WHERE (task_id = ? OR task_id LIKE ?)
             AND created_at >= ?
           ORDER BY created_at ASC\`,
      ).all(taskId, \`\${taskId}:evaluation:%\`, since);
      console.log(JSON.stringify(rows));
    } finally {
      db.close();
    }
  `;
  const result = runLoggedProcess(
    'docker',
    composeArgs(composeEnvPath, [
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '--entrypoint',
      'node',
      composeService,
      '--input-type=module',
      '-e',
      script,
      isoToSqliteTimestamp(runStartAt),
      taskId,
    ]),
    {
      cwd: clientRoot,
      evidenceBase,
    },
  );
  expectExit(result, [0], 'docker artifact query');
  return parseJsonStdout(result.stdout, 'docker-artifact-query');
}

async function startPolymarketFixtureServer() {
  const now = Date.now();
  const endDate = new Date(now + 48 * 60 * 60 * 1000).toISOString();
  const market = {
    id: 'acceptance-market-1',
    marketId: 'acceptance-market-1',
    conditionId: '0xacceptancecondition00000000000000000000000000000000000000000000000001',
    slug: 'release-acceptance-market',
    question: 'Will the release acceptance fixture remain unresolved during this gate?',
    description: 'Deterministic local Polymarket-compatible fixture for release acceptance.',
    rules: 'This fixture is intentionally unresolved while the gate runs.',
    endDateIso: endDate,
    active: true,
    closed: false,
    archived: false,
    outcomes: JSON.stringify(['YES', 'NO']),
    clobTokenIds: JSON.stringify(['acceptance-yes-token', 'acceptance-no-token']),
    liquidity: '100000',
    volume24hr: '50000',
    url: '',
  };
  const book = {
    bids: [{ price: '0.49', size: '100' }],
    asks: [{ price: '0.51', size: '100' }],
    timestamp: Date.now(),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/markets') {
      res.end(JSON.stringify([market]));
      return;
    }
    if (url.pathname === `/markets/${market.id}`) {
      res.end(JSON.stringify(market));
      return;
    }
    if (url.pathname === '/book') {
      res.end(JSON.stringify(book));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '0.0.0.0', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('polymarket fixture server did not bind to a TCP port');
  }
  const dockerBaseUrl = `http://host.docker.internal:${address.port}`;
  market.url = `${dockerBaseUrl}/markets/${market.id}`;
  return {
    server,
    localBaseUrl: `http://127.0.0.1:${address.port}`,
    dockerBaseUrl,
    market,
    marketUrl: market.url,
    yesTokenId: 'acceptance-yes-token',
    noTokenId: 'acceptance-no-token',
    orderbook: {
      sampledAt: new Date(book.timestamp).toISOString(),
      bestBidYes: '0.4900',
      bestAskYes: '0.5100',
      midpointYes: '0.5000',
      spread: '0.0200',
      source: 'polymarket-clob',
    },
  };
}

function buildAcceptanceSeedScript(runId, fixture) {
  return `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { uploadToIpfs } from './dist/adapters/mech/ipfs.js';

    const runId = ${JSON.stringify(runId)};
    const fixture = ${JSON.stringify(fixture)};
    const config = JSON.parse(readFileSync('/acceptance/config.json', 'utf8'));
    const state = JSON.parse(readFileSync('/data/earning/earning_state.json', 'utf8'));
    const service = (state.services ?? []).find((svc) =>
      svc.step === 'complete' && svc.safe_address && svc.agent_address && svc.agent_id
    );
    if (!service) {
      throw new Error('acceptance seed: no complete service with Safe, agent EOA, and agent id');
    }

    const nowIso = new Date().toISOString();
    const solverNetId = 'acceptance_prediction-v1_' + runId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const manifest = {
      schemaVersion: 'solvernet.manifest.v1',
      solverNetId,
      network: 'base-sepolia',
      name: 'Release acceptance Prediction v1',
      description: 'Release acceptance SolverNet manifest for the public testnet gate.',
      launcher: {
        safeAddress: service.safe_address,
        agentEoa: service.agent_address,
        agentId: String(service.agent_id),
      },
      contract: {
        id: 'prediction',
        version: 'v1',
        schemas: {
          task: { type: 'object' },
          solution: { type: 'object' },
          verdict: { type: 'object' },
        },
        claimPolicyDefaults: {
          mode: 'parallel',
          maxClaims: 10,
          maxClaimsPerOperator: 1,
          claimLeaseTtlSeconds: 600,
        },
        credentialRequirements: {
          creator: [],
          solver: [],
          evaluator: [],
        },
        evaluationFunction: {
          id: 'prediction.brier-loss.v1',
          deterministic: true,
          inputs: ['prediction.v1 Task', 'prediction.v1 Solution', 'Polymarket/UMA resolution'],
          output: 'prediction.v1 Verdict',
          implementation: 'jinn:harness:prediction-v1-evaluator',
        },
        aggregationFunction: {
          id: 'prediction.trailing-mean-brier-spread.v1',
          deterministic: true,
          inputs: ['SCORED prediction.v1 Verdicts'],
          output: 'score',
          windowDays: 30,
        },
      },
      solutionPriceWei: '0',
      verdictPriceWei: '0',
      openRoles: ['solver', 'evaluator'],
      createdAt: nowIso,
      launchedAt: nowIso,
      signature: {
        alg: 'eip-191',
        signer: service.agent_address,
        value: '0x' + '00'.repeat(65),
      },
    };
    const manifestCid = await uploadToIpfs(
      config.ipfsRegistryUrl ?? 'https://registry.autonolas.tech',
      manifest,
    );

    const now = Date.now();
    const selected = fixture.market;
    const selectedOrderbook = fixture.orderbook;
    const taskPath = '/data/release-acceptance-task.json';
    const taskTemplate = {
      solverType: 'prediction.v1',
      window: {
        startTs: now,
        endTs: now + 10 * 60 * 1000,
      },
      claimPolicy: {
        mode: 'parallel',
        maxClaims: 10,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
      spec: {
        question: {
          kind: 'binary',
          text: selected.question,
          yesLabel: 'YES',
          noLabel: 'NO',
        },
        source: {
          type: 'prediction-market',
          venue: 'polymarket',
          url: fixture.marketUrl,
          identifiers: {
            marketId: selected.id,
            conditionId: selected.conditionId,
            yesTokenId: fixture.yesTokenId,
            noTokenId: fixture.noTokenId,
          },
        },
        resolution: {
          expectedResolutionTime: selected.endDateIso,
          rulesText: selected.rules,
          rulesUrl: fixture.marketUrl,
          timezone: 'UTC',
        },
        consensusSnapshot: {
          sampledAt: selectedOrderbook.sampledAt,
          probabilityYes: selectedOrderbook.midpointYes,
          method: 'best-bid-ask-midpoint',
          bestBidYes: selectedOrderbook.bestBidYes,
          bestAskYes: selectedOrderbook.bestAskYes,
          spread: selectedOrderbook.spread,
          source: 'polymarket-clob',
        },
        eligibilitySnapshot: {
          sampledAt: new Date(now).toISOString(),
          timeToResolutionHours: Number(((Date.parse(selected.endDateIso) - now) / 3600000).toFixed(2)),
          liquidityUsd: selected.liquidity,
          volume24hUsd: selected.volume24hr,
          orderbookAgeSeconds: Math.max(0, Math.round((now - Date.parse(selectedOrderbook.sampledAt)) / 1000)),
          selectionReason: 'release-acceptance-live-polymarket-cycle',
        },
      },
      eligibility: {
        maxSubmissionDelayMs: 60000,
        acceptanceRunId: runId,
      },
    };
    writeFileSync(taskPath, JSON.stringify(taskTemplate, null, 2) + '\\n', 'utf8');
    console.log(JSON.stringify({
      manifestCid,
      solverNetId,
      taskPath,
      market: {
        marketId: selected.marketId,
        conditionId: selected.conditionId,
        question: selected.question,
        url: fixture.marketUrl,
        resolutionStatus: 'unresolved',
      },
    }));
  `;
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main() {
  const parsed = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      mode: { type: 'string', default: 'steady-state' },
      'evidence-dir': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'poll-ms': { type: 'string' },
      'target-cycles': { type: 'string' },
      'image-tag': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    printHelp();
    return;
  }

  const mode = parsed.values.mode;
  if (!['steady-state', 'fresh-state'].includes(mode)) {
    fail(`Unsupported --mode: ${mode}`);
  }

  warnIfBranchLagsMain();

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
    fail('Set JINN_TESTNET_ACCEPTANCE_RPC_URL or BASE_SEPOLIA_RPC_URL for Docker acceptance.');
  }

  const workspaceRoot = dockerAcceptanceWorkspaceRoot(clientRoot);
  const configPath = dockerAcceptanceConfigPath(clientRoot);
  const composeEnvPath = dockerAcceptanceComposeEnvPath(clientRoot);
  const runId = makeRunId();
  const acceptanceTaskId = `release-acceptance-${runId}`;
  const evidenceDir = resolve(
    parsed.values['evidence-dir'] ?? join(dockerAcceptanceEvidenceRoot(clientRoot), runId),
  );
  const timeoutMs = toInt(parsed.values['timeout-ms'], DEFAULT_TIMEOUT_MS);
  const pollMs = toInt(parsed.values['poll-ms'], DEFAULT_POLL_MS);
  const targetCycles = toInt(parsed.values['target-cycles'], DEFAULT_TARGET_CYCLES);
  const imageTag = parsed.values['image-tag'] ?? baseEnv['JINN_ACCEPTANCE_IMAGE'] ?? 'jinn-client:acceptance-local';
  const buildCommit = process.env['JINN_BUILD_COMMIT'] ?? readGitCommit();
  const dirty = isGitDirty();
  const startedAt = new Date().toISOString();

  ensureDir(workspaceRoot);
  ensureDir(evidenceDir);
  const polymarketFixture = await startPolymarketFixtureServer();
  let polymarketFixtureClosed = false;
  const closePolymarketFixture = async () => {
    if (polymarketFixtureClosed) return;
    polymarketFixtureClosed = true;
    await new Promise((resolvePromise) => polymarketFixture.server.close(resolvePromise));
  };
  const acceptanceEnv = {
    ...gateEnv,
    JINN_POLYMARKET_GAMMA_BASE_URL: polymarketFixture.dockerBaseUrl,
    JINN_POLYMARKET_CLOB_BASE_URL: polymarketFixture.dockerBaseUrl,
  };

  const config = buildOperatorClientConfig({
    rpcUrl,
    clientHome: '/data',
    runIdSuffix: runId,
    env: acceptanceEnv,
  });
  if (targetCycles < 1) {
    fail(`target-cycles (${targetCycles}) must be >= 1.`);
  }

  writeJson(configPath, config);

  const composeEnv = buildDockerComposeEnv({
    clientRoot,
    env: acceptanceEnv,
    imageTag,
    configPath,
  });
  writeFileSync(composeEnvPath, formatEnvFile(composeEnv), { encoding: 'utf8', mode: 0o600 });
  chmodSync(composeEnvPath, 0o600);
  writeJson(join(evidenceDir, 'inputs.json'), {
    startedAt,
    mode,
    timeoutMs,
    pollMs,
    targetCycles,
    imageTag,
    buildCommit,
    dirty,
    composeEnvPath,
    configPath,
    cycleSubstrate: 'prediction.v1',
    acceptanceTaskId,
    polymarketFixture: {
      localBaseUrl: polymarketFixture.localBaseUrl,
      dockerBaseUrl: polymarketFixture.dockerBaseUrl,
      marketId: polymarketFixture.market.id,
      conditionId: polymarketFixture.market.conditionId,
    },
    dataVolume: composeEnv.JINN_ACCEPTANCE_DATA_VOLUME,
    claudeVolume: composeEnv.JINN_ACCEPTANCE_CLAUDE_VOLUME,
  });

  const runImage = (args, stepName, expected = [0]) => {
    const result = runLoggedProcess('docker', ['run', '--rm', imageTag, ...args], {
      cwd: clientRoot,
      evidenceBase: join(evidenceDir, stepName),
    });
    expectExit(result, expected, stepName);
    return result;
  };

  const runCompose = (args, stepName, expected = [0]) => {
    const result = runLoggedProcess('docker', composeArgs(composeEnvPath, args), {
      cwd: clientRoot,
      evidenceBase: join(evidenceDir, stepName),
    });
    expectExit(result, expected, stepName);
    return result;
  };

  const runJinnRaw = (args, stepName, expected = [0]) => runCompose(
    ['run', '--rm', '-T', '--no-deps', composeService, ...args],
    stepName,
    expected,
  );

  const runJinn = (args, stepName, expected = [0]) => runJinnRaw(
    [...args, '--config', '/acceptance/config.json'],
    stepName,
    expected,
  );

  const ensureClaudeAuthReady = () => {
    if (hasDockerAcceptanceClaudeToken(composeEnv)) return;

    const auth = runCompose(
      ['run', '--rm', '-T', '--no-deps', '--entrypoint', 'claude', composeService, 'auth', 'status'],
      '08-claude-auth-status',
      [0, 1],
    );
    const payload = parseOptionalJsonStdout(auth.stdout);
    if (auth.status === 0 && payload?.loggedIn === true) return;

    fail(dockerAcceptanceClaudeAuthRemedy(), {
      composeEnvPath,
      claudeVolume: composeEnv.JINN_ACCEPTANCE_CLAUDE_VOLUME,
      authStatus: payload ?? {
        status: auth.status,
        stdout: auth.stdout,
        stderr: auth.stderr,
      },
    });
  };

  try {
    runCompose(['down', '--remove-orphans'], '00-compose-down', [0]);

    if (mode === 'fresh-state') {
      runLoggedProcess('docker', ['volume', 'rm', '-f', composeEnv.JINN_ACCEPTANCE_DATA_VOLUME], {
        cwd: clientRoot,
        evidenceBase: join(evidenceDir, '00-volume-rm-data'),
      });
    }

    runCompose(['config'], '01-compose-config', [0]);
    runLoggedProcess('docker', ['volume', 'create', composeEnv.JINN_ACCEPTANCE_DATA_VOLUME], {
      cwd: clientRoot,
      evidenceBase: join(evidenceDir, '02-volume-create-data'),
    });
    runLoggedProcess('docker', ['volume', 'create', composeEnv.JINN_ACCEPTANCE_CLAUDE_VOLUME], {
      cwd: clientRoot,
      evidenceBase: join(evidenceDir, '03-volume-create-claude'),
    });

    const build = runLoggedProcess('docker', [
      'build',
      '--build-arg',
      `JINN_BUILD_COMMIT=${buildCommit}`,
      '-f',
      'operator/Dockerfile',
      '-t',
      imageTag,
      '.',
    ], {
      cwd: repoRoot,
      evidenceBase: join(evidenceDir, '05-docker-build'),
    });
    expectExit(build, [0], 'docker build');

    const version = parseJsonStdout(runImage(['version', '--json'], '06-version').stdout, 'version');
    const help = runImage(['--help'], '07-help');
    if (!help.stdout.includes('jinn run')) {
      fail('help: expected top-level help text to include `jinn run`.');
    }

    ensureClaudeAuthReady();

    const doctor = parseJsonStdout(runJinn(['doctor', '--json'], '09-doctor').stdout, 'doctor');
    if (doctor.ok !== true) {
      fail('doctor: expected ok=true for Docker release acceptance environment', doctor);
    }

    const bootstrapResult = runJinn(['bootstrap', '--json'], '10-bootstrap', [0, 10, 20]);
    if (bootstrapResult.status === 10) {
      const envelope = parseJsonStdout(bootstrapResult.stdout, 'bootstrap-funding');
      fail(
        'bootstrap: funding_required — fund the operator wallet and re-run.\n'
          + `  ${envelope.message ?? 'See fund-requirements output.'}`,
        envelope,
      );
    }
    expectExit(bootstrapResult, [0], '10-bootstrap');
    const bootstrap = parseJsonStdout(bootstrapResult.stdout, 'bootstrap');
    if (!Array.isArray(bootstrap.services) || !bootstrap.services.some((svc) => svc.step === 'complete')) {
      fail('bootstrap: expected at least one complete service', bootstrap);
    }

    const seed = parseJsonStdout(
      runCompose([
        'run',
        '--rm',
        '-T',
        '--no-deps',
        '--entrypoint',
        'node',
        composeService,
        '--input-type=module',
        '-e',
        buildAcceptanceSeedScript(runId, {
          market: polymarketFixture.market,
          marketUrl: polymarketFixture.marketUrl,
          yesTokenId: polymarketFixture.yesTokenId,
          noTokenId: polymarketFixture.noTokenId,
          orderbook: polymarketFixture.orderbook,
        }),
      ], '11-seed-acceptance-task').stdout,
      'acceptance-seed',
    );
    writeJson(join(evidenceDir, '11-seed-acceptance-task.json'), seed);

    config.joinedSolverNets = {
      ...(config.joinedSolverNets ?? {}),
      [seed.manifestCid]: {
        manifestCid: seed.manifestCid,
        name: 'Release acceptance Prediction v1',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'prediction-v1-baseline',
      },
    };
    writeJson(configPath, config);

    const baselineStatus = parseJsonStdout(runJinn(['status', '--json'], '12-status-before').stdout, 'status-before');
    const baselineRewards = parseJsonStdout(runJinn(['rewards', '--json'], '13-rewards-before').stdout, 'rewards-before');
    const baselineHistory = parseJsonStdout(runJinnRaw(['history', '--limit', '500', '--json'], '14-history-before').stdout, 'history-before');
    // runStartAt is the lower bound for cycle attribution: any prediction.v1
    // artifacts for acceptanceTaskId created at or after this timestamp belong
    // to this gate run.
    const runStartAt = new Date().toISOString();
    const baselineRows = queryDockerArtifactRows(
      composeEnvPath,
      runStartAt,
      join(evidenceDir, '15-artifacts-before'),
      acceptanceTaskId,
    );
    const baselineArtifacts = summarizeRunWindowArtifacts(baselineRows, runStartAt);
    writeJson(join(evidenceDir, 'baseline-summary.json'), {
      historyCounts: countHistoryKinds(baselineHistory),
      runStartAt,
      cycleSubstrate: 'prediction.v1',
      acceptanceTaskId,
      acceptanceSeed: seed,
      artifactProgress: baselineArtifacts.byTaskId,
      pendingRewardsWei: sumPendingRewards(baselineRewards).toString(),
      status: baselineStatus,
    });

    runCompose(['up', '-d', composeService], '16-compose-up', [0]);

    let startup = null;
    const startupStartedAt = Date.now();
    while (Date.now() - startupStartedAt < 60_000) {
      const logs = runCompose(['logs', '--no-color', composeService], '17-logs-startup', [0]);
      writeFileSync(join(evidenceDir, '17-daemon.logs.txt'), logs.stdout, 'utf8');
      const lines = logs.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      for (const rawLine of lines) {
        // Docker Compose prefixes lines with "<service>  | "; strip that.
        const pipeIdx = rawLine.indexOf('| ');
        const line = pipeIdx >= 0 ? rawLine.slice(pipeIdx + 2).trim() : rawLine;
        if (!line.startsWith('{')) continue;
        try {
          const payload = JSON.parse(line);
          if (payload.kind === 'daemon_started') {
            startup = payload;
            break;
          }
        } catch {
          // ignore non-json log lines
        }
      }
      if (startup) break;
      await sleep(2000);
    }
    if (!startup) {
      fail('daemon did not emit daemon_started within 60s', {
        logsPath: join(evidenceDir, '17-daemon.logs.txt'),
      });
    }
    writeJson(join(evidenceDir, '17-run.startup.json'), startup);

    const submit = parseJsonStdout(
      runJinnRaw([
        'tasks',
        'submit',
        '--id',
        acceptanceTaskId,
        '--description',
        'Release acceptance prediction.v1 protocol cycle',
        '--solver-type',
        'prediction.v1',
        '--manifest-cid',
        seed.manifestCid,
        '--spec-file',
        seed.taskPath,
        '--yes',
        '--json',
        '--config',
        '/acceptance/config.json',
      ], '18-submit-acceptance-task').stdout,
      'submit-acceptance-task',
    );
    writeJson(join(evidenceDir, '18-submit-acceptance-task.json'), submit);

    let observed = null;
    const pollPath = join(evidenceDir, '19-cycle-poll.jsonl');
    const pollStartedAt = Date.now();
    while (Date.now() - pollStartedAt < timeoutMs) {
      const status = parseJsonStdout(runJinn(['status', '--json'], '19-status-poll').stdout, 'status-poll');
      const rows = queryDockerArtifactRows(
        composeEnvPath,
        runStartAt,
        join(evidenceDir, '19-artifacts-poll'),
        acceptanceTaskId,
      );
      const artifactProgress = summarizeRunWindowArtifacts(rows, runStartAt);
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

    const logsAfter = runCompose(['logs', '--no-color', '--timestamps', composeService], '20-logs-final', [0]);
    writeFileSync(join(evidenceDir, '20-daemon.logs.txt'), logsAfter.stdout, 'utf8');

    if (!observed) {
      fail(`Timed out waiting for ${targetCycles} new protocol cycles`, {
        pollPath,
        timeoutMs,
      });
    }

    const stop = parseJsonStdout(runJinnRaw(['stop', '--json'], '21-stop').stdout, 'stop');
    await sleep(10_000);

    const fleet = parseJsonStdout(runJinn(['fleet', '--json'], '22-fleet-after').stdout, 'fleet-after');
    const statusAfter = parseJsonStdout(runJinn(['status', '--json'], '23-status-after').stdout, 'status-after');
    const rewardsBeforeClaim = parseJsonStdout(runJinn(['rewards', '--json'], '24-rewards-before-claim').stdout, 'rewards-before-claim');
    const historyAfter = parseJsonStdout(runJinnRaw(['history', '--limit', '500', '--json'], '25-history-after').stdout, 'history-after');
    const artifactsAfter = summarizeRunWindowArtifacts(
      queryDockerArtifactRows(
        composeEnvPath,
        runStartAt,
        join(evidenceDir, '26-artifacts-after'),
        acceptanceTaskId,
      ),
      runStartAt,
    );
    writeJson(join(evidenceDir, '26-artifacts-after.json'), artifactsAfter);

    const claim = parseJsonStdout(runJinn(['claim-rewards', '--yes', '--json'], '27-claim-rewards').stdout, 'claim-rewards');
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

    writeJson(join(evidenceDir, 'summary.json'), {
      startedAt,
      mode,
      imageTag,
      buildCommit,
      dirty,
      composeEnvPath,
      configPath,
      dataVolume: composeEnv.JINN_ACCEPTANCE_DATA_VOLUME,
      claudeVolume: composeEnv.JINN_ACCEPTANCE_CLAUDE_VOLUME,
      version,
      doctor,
      bootstrap,
      acceptanceTaskId,
      acceptanceSeed: seed,
      submit,
      startup,
      stop,
      runStartAt,
      cycleSubstrate: 'prediction.v1',
      observedCompletedCycles: observed.artifactProgress.completedCycles,
      observedArtifactProgress: observed.artifactProgress.byTaskId,
      pendingRewardsBeforeClaimWei: pendingBeforeClaim.toString(),
      rewardClaimMode,
      claim,
      fleet,
      statusBefore: baselineStatus,
      statusAfter,
      historyBeforeCounts: countHistoryKinds(baselineHistory),
      historyAfterCounts: countHistoryKinds(historyAfter),
      finishedAt: new Date().toISOString(),
    });

    console.log('testnet-acceptance: ok');
    console.log(`  image: ${imageTag}`);
    console.log(`  evidence: ${evidenceDir}`);
    console.log(`  version: ${version.client?.version ?? 'unknown'}`);
    console.log(`  commit: ${version.client?.commit ?? 'unknown'}`);
    console.log(`  pending before claim: ${pendingBeforeClaim.toString()} wei`);
    console.log(`  reward claim mode: ${rewardClaimMode}`);
    console.log(`  submitted claims: ${claim.submitted}`);
  } finally {
    runLoggedProcess('docker', composeArgs(composeEnvPath, ['down', '--remove-orphans']), {
      cwd: clientRoot,
      evidenceBase: join(evidenceDir, '99-compose-down'),
    });
    await closePolymarketFixture();
  }
}

main().catch((error) => {
  console.error('testnet-acceptance: failed');
  console.error(error instanceof Error ? error.message : String(error));
  if (error && typeof error === 'object' && 'details' in error && error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exit(1);
});
