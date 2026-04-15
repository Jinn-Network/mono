#!/usr/bin/env npx tsx
/**
 * Docker Run Wrapper — runs jinn-node worker in Docker with correct mounts.
 *
 * Handles:
 *   - Individual auth file mounts (avoids host extension symlinks)
 *   - macOS host.docker.internal detection
 *   - All fixed env vars and flags
 *   - Cross-mech job pickup (WORKER_MECH_FILTER_MODE=any)
 *   - Additional env var passthrough (--env KEY=VALUE)
 *
 * Usage:
 *   yarn test:e2e:docker-run --cwd /path/to/clone
 *   yarn test:e2e:docker-run --cwd /path/to/clone --single
 *   yarn test:e2e:docker-run --cwd /path/to/clone --healthcheck
 *   yarn test:e2e:docker-run --cwd /path/to/clone --workstream 0x1234...
 *   yarn test:e2e:docker-run --cwd /path/to/clone --env X402_GATEWAY_URL=http://host.docker.internal:3001
 *
 * Telemetry files are always mounted at /tmp/jinn-telemetry/ on the host.
 */

import { execSync, spawnSync } from 'child_process';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

function parseArgs(args: string[]): { flags: Record<string, string>; envPairs: string[] } {
  const flags: Record<string, string> = {};
  const envPairs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && i + 1 < args.length) {
      envPairs.push(args[++i]);
    } else if (args[i].startsWith('--env=')) {
      envPairs.push(args[i].slice(6));
    } else if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = 'true';
      }
    }
  }
  return { flags, envPairs };
}

const { flags, envPairs } = parseArgs(process.argv.slice(2));

const cloneDir = flags['cwd'];
if (!cloneDir) {
  console.error('Usage: yarn test:e2e:docker-run --cwd <clone-dir> [--single] [--healthcheck] [--workstream <id>] [--env KEY=VALUE ...]');
  process.exit(1);
}

const resolvedCloneDir = resolve(cloneDir);
const envFile = join(resolvedCloneDir, '.env');
if (!existsSync(envFile)) {
  console.error(`No .env file found at ${envFile}`);
  process.exit(1);
}

// Detect macOS early — needed for pre-flight URL resolution
const isMac = process.platform === 'darwin';

// Pre-flight: verify local stack is alive before starting Docker container
// Always check localhost — pre-flight runs on the host, not inside Docker.
const localPonderUrl = 'http://localhost:42069/graphql';
const localControlUrl = 'http://localhost:4001/graphql';

const stackChecks: Array<{ name: string; url: string; method: string; body?: string }> = [
  { name: 'Ponder', url: localPonderUrl, method: 'POST', body: '{"query":"{ _meta { status } }"}' },
  { name: 'Control API', url: localControlUrl, method: 'POST', body: '{"query":"{ __typename }"}' },
];

// Gateway check — derive localhost URL from the env or default
const gwEnvPair = envPairs.find(p => p.startsWith('X402_GATEWAY_URL='));
const gwUrl = gwEnvPair
  ? gwEnvPair.split('=').slice(1).join('=').replace('host.docker.internal', 'localhost')
  : 'http://localhost:3001';
stackChecks.push({ name: 'Gateway', url: gwUrl.replace(/\/$/, '') + '/health', method: 'GET' });

for (const check of stackChecks) {
  try {
    const res = await fetch(check.url, {
      method: check.method,
      headers: check.body ? { 'Content-Type': 'application/json' } : {},
      body: check.body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err: any) {
    console.error(`Pre-flight FAIL: ${check.name} at ${check.url} — ${err.message}`);
    console.error('  Start the local stack first: yarn test:e2e:stack');
    process.exit(1);
  }
}
console.log('Pre-flight: local stack healthy');

const home = homedir();
const single = flags['single'] === 'true';
const healthcheck = flags['healthcheck'] === 'true';
const image = flags['image'] || 'jinn-node:e2e';
const workstream = flags['workstream'];
const explicitEnvKeys = new Set(
  envPairs
    .map(pair => pair.split('=')[0]?.trim())
    .filter(Boolean),
);

// Docker URLs — use host.docker.internal on macOS so container can reach host services
const ponderUrl = isMac
  ? 'http://host.docker.internal:42069/graphql'
  : 'http://localhost:42069/graphql';
const controlUrl = isMac
  ? 'http://host.docker.internal:4001/graphql'
  : 'http://localhost:4001/graphql';

const containerName = healthcheck ? 'jinn-e2e-healthcheck' : 'jinn-e2e-worker';

// Build docker run args
const dockerArgs: string[] = ['docker', 'run'];

if (healthcheck) {
  dockerArgs.push('-d');
} else {
  dockerArgs.push('--rm');
}

dockerArgs.push('--name', containerName);

if (!isMac) {
  dockerArgs.push('--network', 'host');
}

dockerArgs.push('--env-file', envFile);
dockerArgs.push('-e', 'GEMINI_SANDBOX=false');
dockerArgs.push('-e', 'OPERATE_PROFILE_DIR=/home/jinn/.operate');
dockerArgs.push('-e', 'JINN_WORKSPACE_DIR=/app/jinn-repos');
dockerArgs.push('-e', `PONDER_GRAPHQL_URL=${ponderUrl}`);
dockerArgs.push('-e', `CONTROL_API_URL=${controlUrl}`);

// Enable cross-mech job pickup — any mech can claim any unclaimed request.
// The OLAS marketplace contract does not enforce priorityMech; this relaxes
// the worker's Ponder query filter to match.
dockerArgs.push('-e', 'WORKER_MECH_FILTER_MODE=any');

// Enable multi-service rotation — required when 2+ services are provisioned.
// Without this, the worker runs in single-service mode and skips rotation.
dockerArgs.push('-e', 'WORKER_MULTI_SERVICE=true');

// Forward GITHUB_TOKEN from host env (operator-level credential, not bridge).
// The clone .env may have a placeholder; -e flag takes precedence over --env-file.
if (process.env.GITHUB_TOKEN) {
  dockerArgs.push('-e', `GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`);
}

// Workstream filter — restrict worker to requests in a specific workstream
if (workstream) {
  dockerArgs.push('-e', `WORKSTREAM_FILTER=${workstream}`);
}

// macOS footgun guard:
// If caller did not explicitly pass X402_GATEWAY_URL, force host.docker.internal.
// This avoids localhost resolution failures inside Docker on macOS.
if (isMac && !explicitEnvKeys.has('X402_GATEWAY_URL')) {
  dockerArgs.push('-e', 'X402_GATEWAY_URL=http://host.docker.internal:3001');
  console.log('Auto-set X402_GATEWAY_URL for macOS: http://host.docker.internal:3001');
}

// Additional env vars from --env flags (e.g., X402_GATEWAY_URL)
for (const pair of envPairs) {
  dockerArgs.push('-e', pair);
}

// Mounts
dockerArgs.push('-v', `${resolvedCloneDir}/.operate:/home/jinn/.operate`);

// Individual auth file mounts — avoids host extension symlinks crashing the CLI.
// agent.ts copies these from ~/.gemini/ to GEMINI_CLI_HOME/.gemini/ before spawning CLI.
const oauthCreds = join(home, '.gemini', 'oauth_creds.json');
const googleAccounts = join(home, '.gemini', 'google_accounts.json');
const settingsJson = join(home, '.gemini', 'settings.json');

if (existsSync(oauthCreds)) {
  dockerArgs.push('-v', `${oauthCreds}:/home/jinn/.gemini/oauth_creds.json`);
}
if (existsSync(googleAccounts)) {
  dockerArgs.push('-v', `${googleAccounts}:/home/jinn/.gemini/google_accounts.json`);
}
if (existsSync(settingsJson)) {
  dockerArgs.push('-v', `${settingsJson}:/home/jinn/.gemini/settings.json`);
}

// Mount telemetry subdirectory so files survive container exit (--rm).
// JINN_TELEMETRY_DIR tells agent.ts where to write telemetry files.
// Do NOT set TMPDIR — that pollutes the temp directory with non-telemetry files
// (Gemini CLI extensions, symlinks) which break cp -r on the host.
try {
  execSync('rm -f /tmp/jinn-telemetry/telemetry-*.json', { stdio: 'pipe' });
  execSync('rm -f /tmp/jinn-telemetry-worker/telemetry-*.json', { stdio: 'pipe' });
  execSync('rm -f /tmp/jinn-telemetry-rotation/telemetry-*.json', { stdio: 'pipe' });
  execSync('rm -f /tmp/jinn-telemetry-rotation-cred/telemetry-*.json', { stdio: 'pipe' });
} catch { /* directories may not exist yet */ }
execSync('mkdir -p /tmp/jinn-telemetry');
dockerArgs.push('-v', '/tmp/jinn-telemetry:/tmp/jinn-telemetry');
dockerArgs.push('-e', 'JINN_TELEMETRY_DIR=/tmp/jinn-telemetry');

dockerArgs.push('--shm-size=2g');

if (healthcheck) {
  dockerArgs.push('-p', '8080:8080');
}

dockerArgs.push(image);

// CMD override
if (single) {
  dockerArgs.push('node', 'dist/worker/mech_worker.js', '--single');
}
// healthcheck and default: use image's CMD (worker_launcher.js)

console.log(`Running: ${dockerArgs.join(' ')}`);

// Persist Docker output to a log file for post-run analysis while also streaming to console.
const logDir = process.env.E2E_LOG_DIR || '/tmp/jinn-e2e-logs';
const logSuffix = flags['log-suffix'] || (healthcheck ? 'healthcheck' : 'worker');
const logPath = join(logDir, `docker-${logSuffix}.log`);
mkdirSync(logDir, { recursive: true });
const logStream = createWriteStream(logPath);
console.log(`Logging Docker output to: ${logPath}`);

const result = spawnSync(dockerArgs[0], dockerArgs.slice(1), {
  stdio: ['inherit', 'pipe', 'pipe'],
  timeout: 10 * 60 * 1000,
  maxBuffer: 50 * 1024 * 1024, // 50 MB
});

// Write output to both console and log file
if (result.stdout?.length) {
  process.stdout.write(result.stdout);
  logStream.write(result.stdout);
}
if (result.stderr?.length) {
  process.stderr.write(result.stderr);
  logStream.write(result.stderr);
}
logStream.end();

if (result.error) {
  console.error(`Docker run error: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`Docker exited with code ${result.status}`);
  process.exit(result.status || 1);
}
