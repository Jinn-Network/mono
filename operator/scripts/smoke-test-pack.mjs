#!/usr/bin/env node
/**
 * Validates the tarball shape produced by npm, matching `npm publish`.
 * Installs the pack with npm and Yarn 4 node-modules consumers, then validates:
 * 1) private runtime packages are bundled and their public modules import
 * 2) the exact installed CLI loads through both package-manager layouts
 * 3) local bin execution via `npm exec jinn ...`
 * 4) no-install package execution (`npm exec --package <tarball> -- jinn ...`)
 * 5) legacy `npx -p <tarball> jinn ...`
 * Expects cwd to be operator/ (see package.json pack:smoke).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertSafeTarballEntries,
  assertSafeTarballPackageManifests,
} from './lib/bundled-workspaces.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const smokeDir = mkdtempSync(join(tmpdir(), 'jinn-pack-smoke-'));
const smokeEnv = { ...process.env, HOME: smokeDir, NO_COLOR: '1' };
const installedPackageRoot = join(smokeDir, 'node_modules', '@jinn-network', 'operator');
const installedBundledWorkspaceRoot = join(
  installedPackageRoot,
  'node_modules',
  '@jinn-network',
);
const bundledWorkspaceNames = JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8'))
  .bundledDependencies
  .filter((name) => name.startsWith('@jinn-network/'));
const bundledWorkspaceResolutions = Object.fromEntries(bundledWorkspaceNames.map((name) => [
  name,
  `file:${join(installedBundledWorkspaceRoot, name.slice('@jinn-network/'.length))}`,
]));
// The candidate client and its bundled plugin both declare Zod 4. Yarn's node-modules linker
// otherwise hoists the Zod 3 copy requested by zod-to-json-schema above the file-resolved plugin,
// making Node load a version that violates the plugin's own manifest. Pin the consumer to the
// package's declared runtime major while exercising these exact bundled workspaces.
const yarnConsumerResolutions = {
  ...bundledWorkspaceResolutions,
  zod: 'npm:4.4.3',
};
const outputArgIndex = process.argv.indexOf('--output');
const outputArg = outputArgIndex === -1 ? undefined : process.argv[outputArgIndex + 1];
if (outputArgIndex !== -1 && (!outputArg || outputArg.startsWith('--'))) {
  console.error('smoke-test-pack: --output requires a path');
  process.exit(1);
}
const outputPath = outputArg ? resolve(clientRoot, outputArg) : undefined;
const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', smokeDir], {
  cwd: clientRoot,
  encoding: 'utf8',
});
if (pack.status !== 0) {
  console.error('smoke-test-pack: npm pack failed');
  console.error(pack.error?.message || pack.stderr || pack.stdout);
  process.exit(pack.status ?? 1);
}
const packedFilename = pack.stdout.trim();
if (!packedFilename || packedFilename.includes('\n')) {
  console.error('smoke-test-pack: npm pack did not return one archive filename');
  console.error(pack.stdout);
  process.exit(1);
}
const tarball = join(smokeDir, packedFilename);

function parseJsonOrExit(stdout, context) {
  try {
    return JSON.parse((stdout || '').trim());
  } catch {
    console.error(`smoke-test-pack: ${context} stdout was not JSON`);
    console.error(stdout);
    process.exit(1);
  }
}

function assertVersionPayload(payload, context) {
  if (payload.schemaVersion !== 1) {
    console.error(`smoke-test-pack: expected schemaVersion 1 (${context})`);
    process.exit(1);
  }
  if (!payload.client?.version) {
    console.error(`smoke-test-pack: expected client.version (${context})`);
    process.exit(1);
  }
}

function assertTarballCleanAndComplete() {
  const result = spawnSync('tar', ['-tzf', tarball], {
    cwd: smokeDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error('smoke-test-pack: could not inspect tarball contents');
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  const entries = result.stdout.split('\n');
  try {
    assertSafeTarballEntries(entries);
    assertSafeTarballPackageManifests(entries, (entry) => {
      const extracted = spawnSync('tar', ['-xOf', tarball, entry], {
        cwd: smokeDir,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (extracted.status !== 0) {
        throw new Error(extracted.stderr || extracted.stdout || `could not read ${entry}`);
      }
      return extracted.stdout;
    });
  } catch (error) {
    console.error(`smoke-test-pack: ${error?.message ?? String(error)}`);
    process.exit(1);
  }
  const forbidden = entries
    .filter((entry) => (
      entry.startsWith('package/.acceptance/') ||
      entry.startsWith('package/acceptance-runs/') ||
      entry.startsWith('package/.local/') ||
      entry.includes('/.env')
      || entry === 'package/dist/bin/jinn-layer.js'
      || entry === 'package/dist/bin/jinn-distill-mcp.js'
      || entry.startsWith('package/plugins/local-trace-distiller')
    ));
  if (forbidden.length > 0) {
    console.error('smoke-test-pack: tarball includes local acceptance or secret-bearing state');
    console.error(forbidden.slice(0, 20).join('\n'));
    process.exit(1);
  }
  for (const required of [
    'package/node_modules/@jinn-network/core/dist/corpus-read/index.js',
    'package/node_modules/@jinn-network/plugin/dist/index.js',
  ]) {
    if (!entries.includes(required)) {
      console.error(`smoke-test-pack: tarball is missing bundled runtime ${required}`);
      process.exit(1);
    }
  }
}

function runOrExit(command, args, context, options = {}) {
  const result = spawnSync(command, args, {
    cwd: smokeDir,
    encoding: 'utf8',
    env: smokeEnv,
    ...options,
  });
  if (result.status !== 0) {
    console.error(`smoke-test-pack: ${context} failed`);
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  return result;
}

try {
  assertTarballCleanAndComplete();

  const init = spawnSync('npm', ['init', '-y'], {
    cwd: smokeDir,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (init.status !== 0) process.exit(init.status ?? 1);

  const install = spawnSync('npm', ['install', '--loglevel=error', tarball], {
    cwd: smokeDir,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (install.status !== 0) process.exit(install.status ?? 1);

  runOrExit(
    'npm',
    ['ls', '--all', '@jinn-network/core', '@jinn-network/plugin'],
    'installed bundled dependency graph',
  );
  const installedJinn = join(installedPackageRoot, 'dist', 'bin', 'jinn.js');
  runOrExit(process.execPath, [installedJinn, '--help'], 'exact installed jinn --help');
  runOrExit(process.execPath, [installedJinn, 'scrub', '--help'], 'exact installed jinn scrub --help');

  const yarnConsumerDir = join(smokeDir, 'yarn-consumer');
  mkdirSync(yarnConsumerDir);
  writeFileSync(
    join(yarnConsumerDir, 'package.json'),
    `${JSON.stringify({
      private: true,
      packageManager: 'yarn@4.13.0',
      dependencies: {
        '@jinn-network/operator': `file:${tarball}`,
      },
      // Exercise Yarn's node-modules layout against every exact private workspace bundled in
      // this candidate tarball. A newly bundled workspace can itself depend on another private
      // workspace; mapping only the first two historic roots would make Yarn reach the registry
      // for that already-vendored runtime and hide a real packed-closure regression.
      resolutions: yarnConsumerResolutions,
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(yarnConsumerDir, '.yarnrc.yml'),
    'nodeLinker: node-modules\n',
  );
  writeFileSync(join(yarnConsumerDir, 'yarn.lock'), '');
  runOrExit(
    'corepack',
    ['yarn', 'install', '--no-immutable'],
    'Yarn 4 node-modules consumer install',
    { cwd: yarnConsumerDir, stdio: 'inherit' },
  );
  const yarnInstalledJinn = join(
    yarnConsumerDir,
    'node_modules',
    '@jinn-network',
    'operator',
    'dist',
    'bin',
    'jinn.js',
  );
  runOrExit(
    process.execPath,
    [yarnInstalledJinn, '--help'],
    'yarn consumer exact installed jinn --help',
    { cwd: yarnConsumerDir },
  );
  runOrExit(
    process.execPath,
    [yarnInstalledJinn, 'scrub', '--help'],
    'yarn consumer exact installed jinn scrub --help',
    { cwd: yarnConsumerDir },
  );

  runOrExit(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "const trajectory = await import('@jinn-network/operator/dist/trajectory/schema.js');",
        "const corpus = await import('@jinn-network/operator/dist/corpus/index.js');",
        `const plugin = await import(${JSON.stringify(pathToFileURL(
          join(installedPackageRoot, 'node_modules', '@jinn-network', 'plugin', 'dist', 'index.js'),
        ).href)});`,
        "if (typeof trajectory.JinnTrajectoryV1Schema?.safeParse !== 'function') throw new Error('trajectory shim unavailable');",
        "if (typeof corpus.createCorpus !== 'function') throw new Error('corpus shim unavailable');",
        "if (typeof plugin.createJinnPlugin !== 'function') throw new Error('bundled plugin unavailable');",
      ].join('\n'),
    ],
    'client core-backed public imports',
  );
  console.log('smoke-test-pack: client-only install and core-backed imports ok');

  if (!process.argv.includes('--client-only')) {
    const nodePtyFix = join(installedPackageRoot, 'dist', 'scripts', 'fix-node-pty.mjs');
    if (!existsSync(nodePtyFix)) {
      console.error(`smoke-test-pack: missing node-pty fix script ${nodePtyFix}`);
      process.exit(1);
    }

    const run = runOrExit('npm', ['exec', '--', 'jinn', 'version', '--json'], 'npm exec');
    const payload = parseJsonOrExit(run.stdout, 'npm exec');
    assertVersionPayload(payload, 'npm exec');

    runOrExit('npm', ['exec', '--', 'jinn', '--help'], 'packed jinn --help');
    const doctor = spawnSync('npm', ['exec', '--', 'jinn', 'doctor', '--json'], {
      cwd: smokeDir,
      encoding: 'utf8',
      env: smokeEnv,
      timeout: 60_000,
    });
    if (doctor.error || doctor.status === 50) {
      console.error('smoke-test-pack: packed jinn doctor crashed');
      console.error(doctor.error ?? doctor.stderr ?? doctor.stdout);
      process.exit(doctor.status ?? 1);
    }
    parseJsonOrExit(doctor.stdout, 'packed jinn doctor');

    runOrExit(process.execPath, [nodePtyFix, '--verify'], 'node-pty verification');

    const npxDirect = runOrExit('npm', ['exec', '--yes', '--package', tarball, '--', 'jinn', 'version', '--json'], 'npx direct');
    assertVersionPayload(parseJsonOrExit(npxDirect.stdout, 'npx direct'), 'npx direct');

    const npxLegacy = runOrExit('npx', ['-p', tarball, 'jinn', 'version', '--json'], 'npx -p');
    assertVersionPayload(parseJsonOrExit(npxLegacy.stdout, 'npx -p'), 'npx -p');

    const publicNpx = spawnSync('npx', ['--no-install', '@jinn-network/operator', 'doctor'], {
      cwd: smokeDir,
      encoding: 'utf8',
      env: smokeEnv,
      timeout: 60_000,
    });
    const publicOutput = `${publicNpx.stdout}\n${publicNpx.stderr}`;
    if (publicNpx.error || publicOutput.includes('could not determine executable')) {
      console.error('smoke-test-pack: public npx @jinn-network/operator doctor is ambiguous or failed');
      console.error(publicNpx.error ?? publicOutput);
      process.exit(publicNpx.status ?? 1);
    }
    if (publicNpx.status === 50) {
      console.error('smoke-test-pack: public npx doctor crashed');
      console.error(publicNpx.stderr || publicNpx.stdout);
      process.exit(publicNpx.status);
    }
    parseJsonOrExit(publicNpx.stdout, 'public npx doctor');

    runOrExit(
      'npx',
      ['--no-install', '-p', '@jinn-network/operator', 'jinn-stop-hook', '--help'],
      'packed jinn-stop-hook remains named',
    );

    console.log('smoke-test-pack: ok', payload.client.version);
  }

  if (outputPath) {
    copyFileSync(tarball, outputPath);
    console.log(`smoke-test-pack: artifact written to ${outputPath}`);
  }
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
