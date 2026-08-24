#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertSafeTarballEntries,
  assertSafeTarballPackageManifests,
} from './lib/bundled-workspaces.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const repoRoot = resolve(clientRoot, '..');
const sdkRoot = join(repoRoot, 'packages', 'sdk');
const exactVersionPattern = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?`;

export function renderHelp() {
  return `Usage:
  node scripts/external-consumer-acceptance.mjs
  node scripts/external-consumer-acceptance.mjs --registry \\
    --sdk-spec @jinn-network/sdk@<exact-version> \\
    --client-spec @jinn-network/operator@<exact-version>
`;
}

function exactPackageSpec(packageName, spec) {
  const pattern = new RegExp(`^${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@${exactVersionPattern}$`);
  if (typeof spec !== 'string' || !pattern.test(spec)) {
    throw new Error(`${packageName} registry spec must use an exact version`);
  }
  return spec;
}

function exactProductSpec(spec) {
  return exactPackageSpec('@jinn-network/operator', spec);
}

function productNameFromSpec(_spec) {
  return '@jinn-network/operator';
}

export function parseAcceptanceArgs(argv) {
  if (argv.length === 0) return { mode: 'local' };
  if (argv.includes('--help')) return { mode: 'help' };
  const allowed = new Set(['--registry', '--sdk-spec', '--client-spec']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (arg === '--sdk-spec' || arg === '--client-spec') index += 1;
  }
  if (!argv.includes('--registry')) {
    throw new Error('--sdk-spec and --client-spec require --registry');
  }
  const sdkIndex = argv.indexOf('--sdk-spec');
  const clientIndex = argv.indexOf('--client-spec');
  const sdkSpec = exactPackageSpec('@jinn-network/sdk', argv[sdkIndex + 1]);
  const clientSpec = exactProductSpec(argv[clientIndex + 1]);
  return { mode: 'registry', sdkSpec, clientSpec };
}

function parseJsonOutput(stdout, label) {
  try {
    return JSON.parse(String(stdout ?? '').trim());
  } catch (error) {
    throw new Error(`${label} did not emit JSON: ${error?.message ?? String(error)}`);
  }
}

export function assertInvalidInvocation(result, label) {
  let payload;
  try {
    payload = parseJsonOutput(result.stdout, label);
  } catch (error) {
    throw new Error(`${label} must return invalid_invocation: ${error.message}`);
  }
  const code = payload?.code ?? payload?.error?.code;
  if (result.status !== 11 || code !== 'invalid_invocation') {
    throw new Error(
      `${label} must return invalid_invocation with exit 11; got exit ${result.status} and code ${String(code)}`,
    );
  }
}

export function resolveFixtureSchema(schemaName, autopilot, jinnRepo) {
  const aliases = {
    'jinn-autopilot-session.v1': 'AutopilotSessionCapsuleSchema',
    'jinn-autopilot-mutation-result.v1': 'AutopilotMutationResultSchema',
    'jinn-autopilot-review-result.v1': 'AutopilotReviewResultSchema',
    'jinn-autopilot-marketplace-adoption.v1': 'AutopilotAdoptionReceiptSchema',
    'jinn-task-submit-request.v1': 'TaskSubmitRequestV1Schema',
    'jinn-task-submit-result.v1': 'TaskSubmitResultV1Schema',
    'jinn-autopilot-delivery-expectation.v1': 'AutopilotDeliveryExpectationSchema',
    'jinn-autopilot-delivery-observation.v1': 'AutopilotDeliveryObservationSchema',
    'jinn-autopilot-delivery-command-result.v1': 'AutopilotDeliveryCommandResultV1Schema',
    'jinn-repo-task.v1': 'JinnRepoTaskSchema',
    'jinn-repo-solution.v1': 'JinnRepoSolutionPayloadSchema',
    'jinn-repo-verdict.v1': 'JinnRepoVerdictPayloadSchema',
    AutopilotAdoptionReceiptComment: 'parseAutopilotAdoptionReceiptComment',
  };
  const exportName = aliases[schemaName] ?? schemaName;
  const schema = autopilot[exportName] ?? jinnRepo[exportName];
  if (
    typeof schema?.safeParse !== 'function'
    && typeof schema !== 'function'
  ) {
    throw new Error(`fixture schema ${schemaName} is not exported through the public SDK paths`);
  }
  return schema;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeout ?? 10 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function runOrThrow(command, args, label, options = {}) {
  const result = run(command, args, options);
  if (result.error || result.status !== 0) {
    const combined = [result.stdout, result.stderr]
      .filter((chunk) => typeof chunk === 'string' && chunk.trim().length > 0)
      .join('\n');
    throw new Error(
      `${label} failed with exit ${result.status}: ${result.error?.message ?? (combined || '(no output)')}`,
    );
  }
  return result;
}

export function bareVersionFromPackageSpec(packageName, spec) {
  const prefix = `${packageName}@`;
  if (typeof spec !== 'string' || !spec.startsWith(prefix) || spec.length === prefix.length) {
    throw new Error(`${packageName} registry spec must use an exact version`);
  }
  return spec.slice(prefix.length);
}

export function yarnConsumerManifest(options) {
  return {
    private: true,
    packageManager: 'yarn@4.13.0',
    dependencies: {
      '@jinn-network/sdk': bareVersionFromPackageSpec('@jinn-network/sdk', options.sdkSpec),
      [productNameFromSpec(options.clientSpec)]: bareVersionFromPackageSpec(
        productNameFromSpec(options.clientSpec),
        options.clientSpec,
      ),
    },
  };
}

function packTo(packageRootOrSpec, destination, label, registry = false) {
  const args = ['pack', '--silent', '--pack-destination', destination];
  if (registry) args.push(packageRootOrSpec);
  const result = runOrThrow('npm', args, label, {
    cwd: registry ? destination : packageRootOrSpec,
  });
  const filename = result.stdout.trim();
  if (!filename || filename.includes('\n')) {
    throw new Error(`${label} did not return exactly one archive filename`);
  }
  return join(destination, filename);
}

function readTarEntry(tarball, entry, cwd) {
  return runOrThrow('tar', ['-xOf', tarball, entry], `read ${entry}`, { cwd }).stdout;
}

function inspectTarball(tarball, cwd) {
  const listing = runOrThrow('tar', ['-tzf', tarball], `inspect ${tarball}`, { cwd });
  const entries = listing.stdout.split('\n').filter(Boolean);
  assertSafeTarballEntries(entries);
  assertSafeTarballPackageManifests(
    entries,
    (entry) => readTarEntry(tarball, entry, cwd),
  );
  const rootManifest = JSON.parse(readTarEntry(tarball, 'package/package.json', cwd));
  return { entries, rootManifest };
}

function assertClientPublishManifest(manifest) {
  for (const forbidden of ['workspaces', 'devDependencies', 'resolutions']) {
    if (Object.hasOwn(manifest, forbidden)) {
      throw new Error(`packed client manifest must omit ${forbidden}`);
    }
  }
  if (typeof manifest.scripts?.postinstall !== 'string') {
    throw new Error('packed client manifest must retain its postinstall');
  }
}

function installedSdkVerificationSource() {
  return `
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as autopilot from '@jinn-network/sdk/autopilot';
import * as jinnRepo from '@jinn-network/sdk/solvernets/jinn-repo';

${resolveFixtureSchema.toString()}

if (Object.keys(autopilot).length === 0 || Object.keys(jinnRepo).length === 0) {
  throw new Error('public SDK imports were empty');
}
const manifestUrl = import.meta.resolve('@jinn-network/sdk/fixtures/autopilot/manifest.json');
const manifest = JSON.parse(await readFile(fileURLToPath(manifestUrl), 'utf8'));
if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
  throw new Error('autopilot fixture manifest is empty');
}
for (const fixture of manifest.fixtures) {
  const relativePath = String(fixture.path).replace(/^fixtures\\/autopilot\\//, '');
  const fixtureUrl = import.meta.resolve('@jinn-network/sdk/fixtures/autopilot/' + relativePath);
  const bytes = await readFile(fileURLToPath(fixtureUrl));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== fixture.sha256) {
    throw new Error('fixture hash mismatch for ' + fixture.path);
  }
  const schema = resolveFixtureSchema(fixture.schema, autopilot, jinnRepo);
  let decoded = false;
  if (typeof schema === 'function') {
    decoded = schema(bytes.toString('utf8').trimEnd()) !== null;
  } else {
    try {
      decoded = schema.safeParse(JSON.parse(bytes.toString('utf8'))).success;
    } catch {}
  }
  const expected = fixture.decode === 'accept';
  if (decoded !== expected) {
    throw new Error('fixture decode mismatch for ' + fixture.path);
  }
}
process.stdout.write(JSON.stringify({ fixtureCount: manifest.fixtures.length }));
`;
}

function isolatedConsumerEnv(consumerRoot) {
  const consumerHome = join(consumerRoot, 'home');
  const consumerTmp = join(consumerRoot, 'tmp');
  const npmCache = join(consumerRoot, 'npm-cache');
  mkdirSync(consumerHome, { recursive: true });
  mkdirSync(consumerTmp, { recursive: true });
  mkdirSync(npmCache, { recursive: true });
  return {
    ...process.env,
    HOME: consumerHome,
    TMPDIR: consumerTmp,
    NO_COLOR: '1',
    npm_config_cache: npmCache,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function probeEnv(baseEnv) {
  return {
    PATH: baseEnv.PATH,
    HOME: baseEnv.HOME,
    TMPDIR: baseEnv.TMPDIR,
    NO_COLOR: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    JINN_RPC_URL: 'http://127.0.0.1:9',
    BASE_RPC_URL: 'http://127.0.0.1:9',
    BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9',
  };
}

function runRegistryYarnConsumerAcceptance(options, consumerRoot) {
  const yarnConsumerRoot = join(consumerRoot, 'yarn-consumer');
  mkdirSync(yarnConsumerRoot, { recursive: true });
  writeFileSync(
    join(yarnConsumerRoot, 'package.json'),
    `${JSON.stringify(yarnConsumerManifest(options), null, 2)}\n`,
  );
  writeFileSync(
    join(yarnConsumerRoot, '.yarnrc.yml'),
    'nodeLinker: node-modules\n',
  );
  const yarnEnv = isolatedConsumerEnv(yarnConsumerRoot);
  runOrThrow(
    'corepack', ['yarn', 'install', '--no-immutable'],
    'install exact registry packages with Yarn 4',
    { cwd: yarnConsumerRoot, env: yarnEnv },
  );
  const yarnBin = process.platform === 'win32'
    ? join(yarnConsumerRoot, 'node_modules', '.bin', 'jinn.cmd')
    : join(yarnConsumerRoot, 'node_modules', '.bin', 'jinn');
  const help = runOrThrow(
    yarnBin,
    ['tasks', '--help'],
    'registry Yarn consumer installed jinn tasks --help',
    {
      cwd: yarnConsumerRoot,
      env: probeEnv(yarnEnv),
      timeout: 30_000,
    },
  ).stdout;
  for (const command of ['submit', 'observe-autopilot-delivery']) {
    if (!help.includes(command)) {
      throw new Error(`registry Yarn consumer tasks --help is missing ${command}`);
    }
  }
}

export function runAcceptance(options) {
  const consumerRoot = mkdtempSync(join(tmpdir(), 'jinn-external-consumer-'));
  const env = isolatedConsumerEnv(consumerRoot);
  try {
    writeFileSync(
      join(consumerRoot, 'package.json'),
      '{"name":"jinn-external-consumer","version":"1.0.0","private":true,"type":"module"}\n',
    );

    const sdkTarball = options.mode === 'registry'
      ? packTo(options.sdkSpec, consumerRoot, 'pack registry SDK', true)
      : packTo(sdkRoot, consumerRoot, 'pack local SDK');
    const clientTarball = options.mode === 'registry'
      ? packTo(options.clientSpec, consumerRoot, 'pack registry client', true)
      : packTo(clientRoot, consumerRoot, 'pack local client');
    const sdkPackage = inspectTarball(sdkTarball, consumerRoot).rootManifest;
    const clientPackage = inspectTarball(clientTarball, consumerRoot).rootManifest;
    assertClientPublishManifest(clientPackage);

    const installSpecs = options.mode === 'registry'
      ? [options.sdkSpec, options.clientSpec]
      : [sdkTarball, clientTarball];
    runOrThrow(
      'npm',
      ['install', '--loglevel=error', '--no-audit', '--no-fund', ...installSpecs],
      'install SDK and client',
      { cwd: consumerRoot, env },
    );

    const fixtureVerification = runOrThrow(
      process.execPath,
      ['--input-type=module', '--eval', installedSdkVerificationSource()],
      'verify public SDK imports and fixtures',
      { cwd: consumerRoot, env },
    );
    const fixtureSummary = parseJsonOutput(fixtureVerification.stdout, 'fixture verification');

    const bin = process.platform === 'win32'
      ? join(consumerRoot, 'node_modules', '.bin', 'jinn.cmd')
      : join(consumerRoot, 'node_modules', '.bin', 'jinn');
    const help = runOrThrow(bin, ['tasks', '--help'], 'installed jinn tasks --help', {
      cwd: consumerRoot,
      env: probeEnv(env),
      timeout: 30_000,
    }).stdout;
    for (const command of ['submit', 'observe-autopilot-delivery']) {
      if (!help.includes(command)) {
        throw new Error(`installed jinn tasks --help is missing ${command}`);
      }
    }

    const malformedRequest = join(consumerRoot, 'malformed-submit.json');
    const malformedExpectation = join(consumerRoot, 'malformed-observation.json');
    const malformedConfig = join(consumerRoot, 'malformed-config.json');
    writeFileSync(malformedRequest, '{}\n');
    writeFileSync(malformedExpectation, '{}\n');
    writeFileSync(malformedConfig, '{not-json\n');
    const machineEnv = probeEnv(env);
    assertInvalidInvocation(
      run(bin, [
        'tasks',
        'submit',
        '--request-file',
        malformedRequest,
        '--yes',
        '--json',
        '--config',
        malformedConfig,
      ], { cwd: consumerRoot, env: machineEnv, timeout: 30_000 }),
      'malformed submit',
    );
    assertInvalidInvocation(
      run(bin, [
        'tasks',
        'observe-autopilot-delivery',
        '--expectation-file',
        malformedExpectation,
        '--json',
        '--config',
        malformedConfig,
      ], { cwd: consumerRoot, env: machineEnv, timeout: 30_000 }),
      'malformed observation',
    );

    if (options.mode === 'registry') {
      runRegistryYarnConsumerAcceptance(options, consumerRoot);
    }

    return {
      mode: options.mode,
      sdk: { name: sdkPackage.name, version: sdkPackage.version },
      client: { name: clientPackage.name, version: clientPackage.version },
      fixtureCount: fixtureSummary.fixtureCount,
      commands: ['tasks submit', 'tasks observe-autopilot-delivery'],
    };
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const options = parseAcceptanceArgs(process.argv.slice(2));
    if (options.mode === 'help') {
      process.stdout.write(renderHelp());
    } else {
      process.stdout.write(`${JSON.stringify(runAcceptance(options))}\n`);
    }
  } catch (error) {
    console.error(`external-consumer-acceptance: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}
