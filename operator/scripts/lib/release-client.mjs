import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dockerAcceptanceClaudeAuthRemedy,
  dockerAcceptanceComposeEnvPath,
  hasDockerAcceptanceClaudeToken,
  resolveDockerAcceptanceBaseEnv,
} from './docker-acceptance.mjs';

export const REPO_FULL_NAME = 'Jinn-Network/mono';
export const PACKAGE_NAME = '@jinn-network/operator';
export const SDK_PACKAGE_NAME = '@jinn-network/sdk';
export const REPORT_SCHEMA_VERSION = 1;

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CLIENT_ROOT = resolve(__dirname, '..', '..');
export const DEFAULT_REPO_ROOT = resolve(DEFAULT_CLIENT_ROOT, '..');

// The stable client release requires the current sdk manifest version to be
// published (marketplace-surfaces design §6 R1: the release train tracks the
// sdk manifest, not a pinned literal, so this never redlines on a sdk bump).
// Resolved from the script's own location, not the CWD.
export const REQUIRED_SDK_VERSION = JSON.parse(
  readFileSync(resolve(DEFAULT_REPO_ROOT, 'packages', 'sdk', 'package.json'), 'utf8'),
).version;

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /\b(sk-[A-Za-z0-9][A-Za-z0-9_-]{12,})\b/g,
  /((?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|JINN_PASSWORD|JINN_TESTNET_ACCEPTANCE_PASSWORD)=)[^\s\r\n]+/g,
];

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix) => {
      if (typeof prefix === 'string' && match.startsWith(prefix)) return `${prefix}[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return text;
}

export function parseStableVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version ?? '').trim());
  if (!match) return null;
  return {
    version: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function clientReleaseTag(version) {
  const parsed = parseStableVersion(version);
  if (!parsed) {
    throw new Error(`Invalid stable client version: ${version}`);
  }
  return `client-v${parsed.version}`;
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function makeReleaseRunId(version, date = new Date(), suffix = Math.random().toString(36).slice(2, 8)) {
  return `${version}-${timestampSlug(date)}-${suffix}`;
}

export function createSpawnCommandRunner() {
  return (command, args, options = {}) => {
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
      error: result.error?.message,
    };
  };
}

export function readPackageMetadata(clientRoot = DEFAULT_CLIENT_ROOT) {
  const packagePath = join(clientRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const parsed = parseStableVersion(pkg.version);
  if (!parsed) {
    throw new Error(`operator/package.json version must be stable semver X.Y.Z; got ${pkg.version}`);
  }
  return {
    packagePath,
    packageName: pkg.name,
    version: parsed.version,
    tag: clientReleaseTag(parsed.version),
  };
}

export function defaultReportRoot(clientRoot, version, now = new Date()) {
  return join(clientRoot, 'release-runs', makeReleaseRunId(version, now));
}

export function resolveReportDir(rawReportDir, clientRoot, repoRoot) {
  if (!rawReportDir) return null;
  const candidates = [
    resolve(rawReportDir),
    resolve(clientRoot, rawReportDir),
    resolve(repoRoot, rawReportDir),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function loadReport(reportDir) {
  const reportPath = join(reportDir, 'report.json');
  if (!existsSync(reportPath)) {
    throw new Error(`No release report found at ${reportPath}`);
  }
  return JSON.parse(readFileSync(reportPath, 'utf8'));
}

export function saveReport(report) {
  mkdirSync(report.reportDir, { recursive: true });
  writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function findStep(report, id) {
  return report.steps.find((step) => step.id === id);
}

export function isStepComplete(report, id) {
  return findStep(report, id)?.status === 'passed';
}

export function upsertStep(report, step) {
  const idx = report.steps.findIndex((existing) => existing.id === step.id);
  if (idx >= 0) {
    report.steps[idx] = step;
  } else {
    report.steps.push(step);
  }
}

function relPath(from, to) {
  return to.startsWith(from) ? to.slice(from.length + 1) : to;
}

export function makeInitialReport({
  clientRoot,
  repoRoot,
  contractsRoot,
  reportDir,
  mode,
  packageMeta,
  startedAt,
}) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    packageName: packageMeta.packageName,
    version: packageMeta.version,
    tag: packageMeta.tag,
    mode,
    startedAt,
    updatedAt: startedAt,
    clientRoot,
    repoRoot,
    contractsRoot,
    reportDir,
    reportPath: join(reportDir, 'report.json'),
    logsDir: join(reportDir, 'logs'),
    commit: null,
    branch: null,
    dirty: null,
    skippedAcceptance: false,
    acceptanceEvidenceDir: null,
    githubReleaseUrl: null,
    npmVerification: null,
    sdkVerification: null,
    consumerGate: null,
    dockerVerification: null,
    steps: [],
  };
}

function commandLabel(command, args) {
  return [command, ...args].join(' ');
}

export function makeReleaseContext(options = {}) {
  const clientRoot = resolve(options.clientRoot ?? DEFAULT_CLIENT_ROOT);
  const repoRoot = resolve(options.repoRoot ?? join(clientRoot, '..'));
  const contractsRoot = resolve(options.contractsRoot ?? join(repoRoot, 'contracts'));
  const packageMeta = readPackageMetadata(clientRoot);
  const now = options.now ?? new Date();
  const mode = options.mode ?? 'prepare';
  const explicitReportDir = resolveReportDir(options.resumeDir ?? options.reportDir, clientRoot, repoRoot);
  const reportDir = explicitReportDir ?? defaultReportRoot(clientRoot, packageMeta.version, now);
  const report = options.resumeDir
    ? loadReport(reportDir)
    : makeInitialReport({
      clientRoot,
      repoRoot,
      contractsRoot,
      reportDir,
      mode,
      packageMeta,
      startedAt: now.toISOString(),
    });

  report.mode = mode;
  report.updatedAt = now.toISOString();
  report.clientRoot = clientRoot;
  report.repoRoot = repoRoot;
  report.contractsRoot = contractsRoot;
  report.reportDir = reportDir;
  report.reportPath = join(reportDir, 'report.json');
  report.logsDir = join(reportDir, 'logs');
  report.skippedAcceptance = Boolean(options.skipAcceptance);
  mkdirSync(report.logsDir, { recursive: true });
  saveReport(report);

  return {
    clientRoot,
    repoRoot,
    contractsRoot,
    packageMeta,
    report,
    commandRunner: options.commandRunner ?? createSpawnCommandRunner(),
    sleep: options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    workflowPollMs: options.workflowPollMs ?? 15_000,
    workflowTimeoutMs: options.workflowTimeoutMs ?? 30 * 60 * 1000,
    skipAcceptance: Boolean(options.skipAcceptance),
    now: () => (options.nowFactory ? options.nowFactory() : new Date()),
  };
}

export function runCommand(context, command, args, options = {}) {
  return context.commandRunner(command, args, {
    cwd: options.cwd ?? context.clientRoot,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
}

export function runStep(context, stepDef) {
  const {
    id,
    label = id,
    command,
    args,
    cwd = context.clientRoot,
    acceptableExitCodes = [0],
    timeoutMs,
    skipIfPassed = true,
  } = stepDef;

  if (skipIfPassed && isStepComplete(context.report, id)) {
    return { skipped: true, step: findStep(context.report, id) };
  }

  const startedAt = context.now().toISOString();
  const startedMs = Date.now();
  const result = runCommand(context, command, args, { cwd, timeoutMs });
  const endedAt = context.now().toISOString();
  const durationMs = Date.now() - startedMs;
  const stdoutPath = join(context.report.logsDir, `${id}.stdout.log`);
  const stderrPath = join(context.report.logsDir, `${id}.stderr.log`);
  writeFileSync(stdoutPath, redactSecrets(result.stdout), 'utf8');
  writeFileSync(stderrPath, redactSecrets(result.stderr || result.error || ''), 'utf8');

  const passed = acceptableExitCodes.includes(result.status);
  const step = {
    id,
    label,
    command,
    args,
    commandLine: commandLabel(command, args),
    cwd,
    status: passed ? 'passed' : 'failed',
    exitCode: result.status,
    startedAt,
    endedAt,
    durationMs,
    stdoutPath,
    stderrPath,
    stdoutRelPath: relPath(context.report.reportDir, stdoutPath),
    stderrRelPath: relPath(context.report.reportDir, stderrPath),
  };
  upsertStep(context.report, step);
  context.report.updatedAt = endedAt;
  saveReport(context.report);

  if (!passed) {
    const error = new Error(`${label} failed with exit ${result.status}; see ${stdoutPath} and ${stderrPath}`);
    error.step = step;
    error.result = result;
    throw error;
  }

  return { skipped: false, step, result };
}

function expectStdout(result, label) {
  const text = (result.stdout ?? '').trim();
  if (!text) throw new Error(`${label}: expected stdout`);
  return text;
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`${label}: expected JSON stdout (${err.message})`);
  }
}

function commandSucceeded(context, command, args, cwd = context.repoRoot) {
  const result = runCommand(context, command, args, { cwd });
  return result.status === 0;
}

function commandStdout(context, command, args, cwd = context.repoRoot) {
  const result = runCommand(context, command, args, { cwd });
  if (result.status !== 0) {
    throw new Error(`${commandLabel(command, args)} failed with exit ${result.status}: ${redactSecrets(result.stderr)}`);
  }
  return (result.stdout ?? '').trim();
}

function localTagTarget(context, tag) {
  return commandStdout(context, 'git', ['rev-list', '-n', '1', tag]);
}

function remoteTagTarget(remoteTagOutput) {
  const firstLine = String(remoteTagOutput ?? '').trim().split('\n').find(Boolean);
  return firstLine?.split(/\s+/)[0] ?? '';
}

export function collectPreflightState(context) {
  const branch = commandStdout(context, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = commandStdout(context, 'git', ['rev-parse', 'HEAD']);
  const status = commandStdout(context, 'git', ['status', '--short']);
  const dirty = status.length > 0;

  context.report.branch = branch;
  context.report.commit = commit;
  context.report.dirty = dirty;
  context.report.updatedAt = context.now().toISOString();
  saveReport(context.report);

  return { branch, commit, dirty };
}

export function hasConfiguredAcceptanceAuth(clientRoot, env = process.env) {
  const baseEnv = resolveDockerAcceptanceBaseEnv({ clientRoot, env });
  return hasDockerAcceptanceClaudeToken(baseEnv);
}

export function checkAcceptanceAuth(context) {
  if (hasConfiguredAcceptanceAuth(context.clientRoot)) return;

  const composeEnvPath = dockerAcceptanceComposeEnvPath(context.clientRoot);
  if (!existsSync(composeEnvPath)) {
    throw new Error(dockerAcceptanceClaudeAuthRemedy());
  }

  const composeFile = join(context.clientRoot, 'docker-compose.acceptance.yml');
  const result = runCommand(context, 'docker', [
    'compose',
    '--env-file',
    composeEnvPath,
    '-f',
    composeFile,
    'run',
    '--rm',
    '-T',
    '--no-deps',
    '--entrypoint',
    'claude',
    'jinn-acceptance-daemon',
    'auth',
    'status',
  ], { cwd: context.clientRoot });

  if (result.status === 0) return;
  throw new Error(dockerAcceptanceClaudeAuthRemedy());
}

export function runPreflights(context) {
  const state = collectPreflightState(context);
  const { packageMeta } = context;
  const tag = packageMeta.tag;

  if (state.branch !== 'main') {
    throw new Error(`Release must run from main; current branch is ${state.branch}`);
  }
  if (state.dirty) {
    throw new Error('Release requires a clean working tree.');
  }

  runStep(context, {
    id: 'preflight-fetch-main',
    label: 'fetch origin/main',
    command: 'git',
    args: ['fetch', '--quiet', 'origin', 'main'],
    cwd: context.repoRoot,
  });
  runStep(context, {
    id: 'preflight-not-behind-main',
    label: 'verify HEAD is not behind origin/main',
    command: 'git',
    args: ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'],
    cwd: context.repoRoot,
  });

  const localTagExists = commandSucceeded(context, 'git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  const remoteTag = commandStdout(context, 'git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  const remoteTarget = remoteTagTarget(remoteTag);
  const publishAlreadyStarted = isStepComplete(context.report, 'publish-create-github-release')
    || isStepComplete(context.report, 'publish-push-tag')
    || isStepComplete(context.report, 'publish-create-local-tag')
    || isStepComplete(context.report, 'verify-npm-view');
  const commandFlowValidation = context.report.mode === 'prepare' && context.skipAcceptance;

  if ((localTagExists || remoteTag.length > 0) && !publishAlreadyStarted && !commandFlowValidation) {
    throw new Error(`Release tag ${tag} already exists. Use --resume only for an in-progress release report.`);
  }
  if (localTagExists && publishAlreadyStarted) {
    const target = localTagTarget(context, tag);
    if (target !== state.commit) {
      throw new Error(`Local tag ${tag} points at ${target}, not release commit ${state.commit}.`);
    }
  }
  if (remoteTarget && publishAlreadyStarted && remoteTarget !== state.commit) {
    throw new Error(`Remote tag ${tag} points at ${remoteTarget}, not release commit ${state.commit}.`);
  }

  const npmView = runCommand(context, 'npm', ['view', `${PACKAGE_NAME}@${packageMeta.version}`, 'version'], {
    cwd: context.clientRoot,
  });
  const npmExists = npmView.status === 0 && npmView.stdout.trim() === packageMeta.version;
  if (npmExists && !publishAlreadyStarted && !commandFlowValidation) {
    throw new Error(`${PACKAGE_NAME}@${packageMeta.version} already exists on npm.`);
  }

  runStep(context, {
    id: 'preflight-gh-auth',
    label: 'verify GitHub CLI auth',
    command: 'gh',
    args: ['auth', 'status'],
    cwd: context.repoRoot,
  });
  runStep(context, {
    id: 'preflight-gh-repo',
    label: 'verify GitHub repo access',
    command: 'gh',
    args: ['repo', 'view', REPO_FULL_NAME, '--json', 'nameWithOwner'],
    cwd: context.repoRoot,
  });
  runStep(context, {
    id: 'preflight-docker',
    label: 'verify Docker availability',
    command: 'docker',
    args: ['version', '--format', '{{.Server.Version}}'],
    cwd: context.clientRoot,
  });

  if (!context.skipAcceptance) {
    checkAcceptanceAuth(context);
  }
}

export function releaseGateSteps(skipAcceptance = false) {
  const steps = [
    ['gate-yarn-install', 'yarn install --immutable', 'yarn', ['install', '--immutable'], 'clientRoot'],
    ['gate-typecheck', 'yarn typecheck', 'yarn', ['typecheck'], 'clientRoot'],
    ['gate-test', 'yarn test', 'yarn', ['test'], 'clientRoot'],
    ['gate-build', 'yarn build', 'yarn', ['build'], 'clientRoot'],
    ['gate-pack-smoke', 'yarn pack:smoke', 'yarn', ['pack:smoke'], 'clientRoot'],
    ['gate-contracts-install', 'contracts: yarn install --immutable', 'yarn', ['install', '--immutable'], 'contractsRoot'],
    ['gate-operator', 'yarn release:operator-gate', 'yarn', ['release:operator-gate'], 'clientRoot'],
    ['gate-contracts-test', 'contracts: yarn test', 'yarn', ['test'], 'contractsRoot'],
    ['gate-contracts-foundry-install', 'contracts: ensure forge-std', 'node', ['../operator/scripts/ensure-forge-std.mjs'], 'contractsRoot'],
    ['gate-contracts-foundry-invariants', 'contracts: forge test --match-contract Invariant', 'forge', ['test', '--match-contract', 'Invariant'], 'contractsRoot'],
  ];
  if (!skipAcceptance) {
    steps.push(
      ['gate-acceptance-setup', 'yarn setup:testnet-acceptance-operator --bootstrap', 'yarn', ['setup:testnet-acceptance-operator', '--bootstrap'], 'clientRoot'],
      ['gate-acceptance', 'yarn release:testnet-acceptance', 'yarn', ['release:testnet-acceptance'], 'clientRoot'],
      ['gate-olas-rails-smoke', 'yarn release:olas-rails-smoke', 'yarn', ['release:olas-rails-smoke'], 'clientRoot'],
    );
  }
  return steps.map(([id, label, command, args, cwdKey]) => ({ id, label, command, args, cwdKey }));
}

export function verifyStableSdkRelease(context) {
  const spec = `${SDK_PACKAGE_NAME}@${REQUIRED_SDK_VERSION}`;
  const verification = runStep(context, {
    id: 'preflight-sdk-release',
    label: `verify npm ${spec}`,
    command: 'npm',
    args: ['view', spec, 'version'],
    cwd: context.clientRoot,
  });
  const version = verification.result
    ? expectStdout(verification.result, `npm view ${spec}`)
    : REQUIRED_SDK_VERSION;
  if (version !== REQUIRED_SDK_VERSION) {
    throw new Error(`${spec} is required before releasing the client; got ${version}`);
  }
  context.report.sdkVerification = {
    package: SDK_PACKAGE_NAME,
    version,
  };
  saveReport(context.report);
}

export function runGateSequence(context) {
  for (const step of releaseGateSteps(context.skipAcceptance)) {
    const result = runStep(context, {
      ...step,
      cwd: step.cwdKey === 'contractsRoot' ? context.contractsRoot : context.clientRoot,
    });
    if (step.id === 'gate-acceptance' && result.result?.stdout) {
      const match = result.result.stdout.match(/operator\/acceptance-runs\/[^\s"'`]+/);
      if (match) {
        context.report.acceptanceEvidenceDir = match[0];
        saveReport(context.report);
      }
    }
    if (step.id === 'gate-pack-smoke') {
      context.report.consumerGate = {
        mode: 'local',
        sdkVersion: REQUIRED_SDK_VERSION,
        stepId: step.id,
      };
      saveReport(context.report);
    }
  }
}

export function publishSteps(version, tag) {
  return [
    {
      id: 'publish-create-local-tag',
      label: `create ${tag}`,
      command: 'git',
      args: ['tag', tag],
      cwdKey: 'repoRoot',
    },
    {
      id: 'publish-push-tag',
      label: `push ${tag}`,
      command: 'git',
      args: ['push', 'origin', tag],
      cwdKey: 'repoRoot',
    },
    {
      id: 'publish-create-github-release',
      label: `create GitHub release ${tag}`,
      command: 'gh',
      args: ['release', 'create', tag, '--repo', REPO_FULL_NAME, '--title', `client v${version}`, '--notes', `Release ${PACKAGE_NAME} v${version}`],
      cwdKey: 'repoRoot',
    },
  ];
}

export function runPublishSequence(context) {
  for (const step of publishSteps(context.packageMeta.version, context.packageMeta.tag)) {
    const result = runStep(context, {
      ...step,
      cwd: step.cwdKey === 'repoRoot' ? context.repoRoot : context.clientRoot,
    });
    if (step.id === 'publish-create-github-release' && result.result?.stdout) {
      const url = result.result.stdout.trim().split('\n').find((line) => line.startsWith('http'));
      if (url) {
        context.report.githubReleaseUrl = url;
        saveReport(context.report);
      }
    }
  }
}

export async function waitForWorkflow(context, { workflow, stepId, label }) {
  if (isStepComplete(context.report, stepId)) return findStep(context.report, stepId);

  const startedAt = context.now().toISOString();
  const startedMs = Date.now();
  const deadline = startedMs + context.workflowTimeoutMs;
  let lastResult = null;
  let selectedRun = null;

  while (Date.now() <= deadline) {
    lastResult = runCommand(context, 'gh', [
      'run',
      'list',
      '--repo',
      REPO_FULL_NAME,
      '--workflow',
      workflow,
      '--event',
      'release',
      '--commit',
      context.report.commit,
      '--json',
      'databaseId,status,conclusion,headSha,url,displayTitle,createdAt',
      '--limit',
      '20',
    ], { cwd: context.repoRoot });

    if (lastResult.status !== 0) break;
    const runs = parseJson(lastResult.stdout, `${workflow} run list`);
    selectedRun = runs.find((run) => run.headSha === context.report.commit) ?? runs[0] ?? null;
    if (selectedRun?.status === 'completed') {
      break;
    }
    await context.sleep(context.workflowPollMs);
  }

  const passed = lastResult?.status === 0
    && selectedRun?.status === 'completed'
    && selectedRun?.conclusion === 'success';
  const endedAt = context.now().toISOString();
  const stdoutPath = join(context.report.logsDir, `${stepId}.stdout.log`);
  const stderrPath = join(context.report.logsDir, `${stepId}.stderr.log`);
  writeFileSync(stdoutPath, redactSecrets(JSON.stringify({ selectedRun, stdout: lastResult?.stdout ?? '' }, null, 2)), 'utf8');
  writeFileSync(stderrPath, redactSecrets(lastResult?.stderr ?? ''), 'utf8');

  const step = {
    id: stepId,
    label,
    command: 'gh',
    args: ['run', 'list', '--workflow', workflow, '--commit', context.report.commit],
    commandLine: `gh run list --workflow ${workflow} --event release --commit ${context.report.commit}`,
    cwd: context.repoRoot,
    status: passed ? 'passed' : 'failed',
    exitCode: lastResult?.status ?? 1,
    startedAt,
    endedAt,
    durationMs: Date.now() - startedMs,
    stdoutPath,
    stderrPath,
    stdoutRelPath: relPath(context.report.reportDir, stdoutPath),
    stderrRelPath: relPath(context.report.reportDir, stderrPath),
  };
  upsertStep(context.report, step);
  context.report.updatedAt = endedAt;
  saveReport(context.report);

  if (!passed) {
    throw new Error(`${label} did not complete successfully; see ${stdoutPath}`);
  }
  return step;
}

export async function waitForReleaseWorkflows(context) {
  await waitForWorkflow(context, {
    workflow: 'npm-publish.yml',
    stepId: 'publish-wait-npm-workflow',
    label: 'wait for npm publish workflow',
  });
  await waitForWorkflow(context, {
    workflow: 'docker.yml',
    stepId: 'publish-wait-docker-workflow',
    label: 'wait for Docker workflow',
  });
}

export function runPublishVerifications(context) {
  const { version } = context.packageMeta;

  const npmView = runStep(context, {
    id: 'verify-npm-view',
    label: `verify npm ${PACKAGE_NAME}@${version}`,
    command: 'npm',
    args: ['view', `${PACKAGE_NAME}@${version}`, 'version'],
  });
  const npmVersion = npmView.result ? expectStdout(npmView.result, 'npm view') : version;
  if (npmVersion !== version) {
    throw new Error(`npm verification expected ${version}, got ${npmVersion}`);
  }
  context.report.npmVerification = { package: PACKAGE_NAME, version: npmVersion };
  saveReport(context.report);

  runStep(context, {
    id: 'verify-external-consumer',
    label: `verify external consumer with SDK ${REQUIRED_SDK_VERSION} and client ${version}`,
    command: 'node',
    args: [
      'scripts/external-consumer-acceptance.mjs',
      '--registry',
      '--sdk-spec',
      `${SDK_PACKAGE_NAME}@${REQUIRED_SDK_VERSION}`,
      '--client-spec',
      `${PACKAGE_NAME}@${version}`,
    ],
  });
  context.report.consumerGate = {
    mode: 'registry',
    sdkVersion: REQUIRED_SDK_VERSION,
    clientVersion: version,
    stepId: 'verify-external-consumer',
  };
  saveReport(context.report);

  runStep(context, {
    id: 'verify-npx-version',
    label: `verify npx ${PACKAGE_NAME}@${version}`,
    command: 'npx',
    args: ['--yes', `${PACKAGE_NAME}@${version}`, 'version', '--json'],
  });

  runStep(context, {
    id: 'verify-docker-version',
    label: `verify GHCR image ${version} version`,
    command: 'docker',
    args: ['run', '--rm', `ghcr.io/jinn-network/client:${version}`, 'version', '--json'],
  });
  runStep(context, {
    id: 'verify-docker-doctor',
    label: `verify GHCR image ${version} doctor`,
    command: 'docker',
    args: ['run', '--rm', `ghcr.io/jinn-network/client:${version}`, 'doctor', '--json'],
  });
  context.report.dockerVerification = {
    image: `ghcr.io/jinn-network/client:${version}`,
    version,
  };
  saveReport(context.report);
}

export async function runRelease(options = {}) {
  const context = makeReleaseContext(options);
  if (context.packageMeta.packageName !== PACKAGE_NAME) {
    throw new Error(`Expected ${PACKAGE_NAME}; got ${context.packageMeta.packageName}`);
  }
  if (!['prepare', 'publish'].includes(context.report.mode)) {
    throw new Error(`Unsupported release mode: ${context.report.mode}`);
  }
  if (context.report.mode === 'publish' && context.skipAcceptance) {
    throw new Error('--skip-acceptance is only allowed with --prepare; publish releases must include Docker testnet acceptance.');
  }

  runPreflights(context);
  verifyStableSdkRelease(context);
  runGateSequence(context);

  if (context.report.mode === 'publish') {
    runPublishSequence(context);
    await waitForReleaseWorkflows(context);
    runPublishVerifications(context);
  }

  context.report.completedAt = context.now().toISOString();
  context.report.status = 'completed';
  saveReport(context.report);
  return context.report;
}

export function renderHelp(scriptName = `node scripts/${basename(fileURLToPath(import.meta.url))}`) {
  return `Usage: ${scriptName} [--prepare | --publish] [options]

Runs the @jinn-network/operator release gate and writes an evidence report.

Modes:
  --prepare                  Run release gates only; do not tag or publish (default)
  --publish                  Run missing gates, create client-vX.Y.Z, publish, and verify

Options:
  --resume <report-dir>      Continue from an existing operator/release-runs report
  --skip-acceptance          With --prepare only: skip Docker acceptance for command-flow validation
  --workflow-timeout-ms <ms> Max wait per GitHub workflow in --publish
  --workflow-poll-ms <ms>    Poll interval while watching GitHub workflows
  --help                     Show this help

Reports:
  operator/release-runs/<version>-<timestamp>/report.json
`;
}
