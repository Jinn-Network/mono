import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APPROVED_RUNTIME_DEV_DEPENDENCIES,
  derivePublicCodeEntrypoints,
  discoverPluginPackages,
  validateExportSubpath,
  validateExportTarget,
} from './plugin-tree-guard-common.mjs';

const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-plugin-tree-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const livePackages = discoverPluginPackages();
const liveEntrypoints = livePackages.flatMap((pkg) =>
  derivePublicCodeEntrypoints(pkg.manifest).map((entrypoint) => ({
    packageName: pkg.name,
    packageDir: pkg.absoluteDirectory,
    importSpecifier: entrypoint.subpath === '.'
      ? pkg.name
      : `${pkg.name}${entrypoint.subpath.slice(1)}`,
    conditions: entrypoint.conditions,
  })),
);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      reject(new Error(`${command} exited with ${code}:\n${output}${errorOutput}`));
    });
  });
}

async function listTarball(archivePath) {
  const output = await run('tar', ['-tzf', archivePath]);
  return output.split('\n').filter(Boolean);
}

async function packOne(directory, name) {
  const packed = JSON.parse(await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', archivesRoot],
    { cwd: directory },
  ));
  if (packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
    throw new Error(`npm pack returned an unexpected result for ${name}`);
  }
  return join(archivesRoot, packed[0].filename);
}

function assertExactTarballEntry(tarPaths, relativePath) {
  const normalized = relativePath.replace(/^\.\//, '');
  const expected = `package/${normalized}`;
  if (!tarPaths.includes(expected)) {
    throw new Error(`packed tarball missing exact entry ${expected}`);
  }
}

function assertExportMutationsFail() {
  const cases = [
    [{ name: '@jinn-network/outside', exports: { '.': { types: '../outside.d.ts', import: '../outside.js' } } }, /relative|dist/],
    [{ name: '@jinn-network/condition', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' } } }, /types before import|unsupported condition/],
    [{ name: '@jinn-network/wildcard', exports: { './*': './dist/*.js' } }, /wildcard/],
    [{ name: '@jinn-network/escape', exports: { '../escape': './dist/index.js' } }, /subpath/],
    [{ name: '@jinn-network/nested', exports: { '.': { import: { nested: true } } } }, /malformed|requires string types and import|types before import/],
    [{ name: '@jinn-network/null-export', exports: { '.': null } }, /malformed/],
    [{ name: '@jinn-network/reordered', exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } } }, /types before import/],
    [{ name: '@jinn-network/encoded', exports: { '.': { types: './dist/%2e%2e/x.d.ts', import: './dist/%2e%2e/x.js' } } }, /percent encoding/],
  ];
  for (const [manifest, pattern] of cases) {
    try {
      derivePublicCodeEntrypoints(manifest);
      throw new Error(`expected derivePublicCodeEntrypoints to reject ${JSON.stringify(manifest.exports)}`);
    } catch (error) {
      if (!pattern.test(error.message)) {
        throw error;
      }
    }
  }
}

async function validatePackedSurface(archivePath, entrypoints) {
  const tarPaths = await listTarball(archivePath);
  for (const entrypoint of entrypoints) {
    assertExactTarballEntry(tarPaths, entrypoint.conditions.import);
    assertExactTarballEntry(tarPaths, entrypoint.conditions.types);
  }
}

async function runLiveConsumer(archives) {
  await mkdir(consumerRoot, { recursive: true });
  const consumerManifest = {
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(
      livePackages.map((pkg) => [pkg.name, `file:${archives.get(pkg.name)}`]),
    ),
    devDependencies: {
      '@types/node': APPROVED_RUNTIME_DEV_DEPENDENCIES['@types/node'],
      typescript: APPROVED_RUNTIME_DEV_DEPENDENCIES.typescript,
    },
  };
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify(consumerManifest, null, 2));
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot });
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot });

  const importLines = liveEntrypoints.map((entrypoint, index) =>
    `const runtime${index} = await import(${JSON.stringify(entrypoint.importSpecifier)});`,
  );
  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    `${importLines.join('\n')}\n\nexport const loaded = [${liveEntrypoints.map((_, index) => `runtime${index}`).join(', ')}];\n`,
  );
  await writeFile(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2022',
    },
    include: ['consumer.ts'],
  }, null, 2));

  const typescript = join(
    consumerRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  await run(typescript, ['--project', 'tsconfig.json'], { cwd: consumerRoot });
  await run(process.execPath, ['--input-type=module', '-e', `
    ${importLines.join('\n')}
  `], { cwd: consumerRoot });
}

async function validateMultiExportFixture() {
  const multiExportRoot = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-multi-export-'));
  try {
    const multiExportDir = join(multiExportRoot, 'multi-export-pkg');
    mkdirSync(join(multiExportDir, 'dist'), { recursive: true });
    mkdirSync(join(multiExportDir, 'src'), { recursive: true });
    writeFileSync(join(multiExportDir, 'package.json'), JSON.stringify({
      name: '@jinn-network/multi-export-fixture',
      version: '0.0.0',
      type: 'module',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './extra': { types: './dist/extra.d.ts', import: './dist/extra.js' },
      },
    }, null, 2));
    writeFileSync(join(multiExportDir, 'dist', 'index.js'), 'export const root = 1;\n');
    writeFileSync(join(multiExportDir, 'dist', 'index.d.ts'), 'export declare const root: number;\n');
    writeFileSync(join(multiExportDir, 'dist', 'extra.js'), 'export const extra = 2;\n');
    writeFileSync(join(multiExportDir, 'dist', 'extra.d.ts'), 'export declare const extra: number;\n');
    writeFileSync(join(multiExportDir, 'src', 'index.ts'), 'export const root = 1;\n');
    writeFileSync(join(multiExportDir, 'src', 'extra.ts'), 'export const extra = 2;\n');

    const multiExportPackages = discoverPluginPackages({ root: multiExportRoot });
    const multiExportPackage = multiExportPackages.find((pkg) => pkg.name === '@jinn-network/multi-export-fixture');
    if (!multiExportPackage) {
      throw new Error('multi-export fixture package must be discovered');
    }
    const entrypoints = derivePublicCodeEntrypoints(multiExportPackage.manifest);
    if (entrypoints.length !== 2) {
      throw new Error(`expected two public code entrypoints, got ${entrypoints.length}`);
    }
    const archive = await packOne(multiExportPackage.absoluteDirectory, multiExportPackage.name);
    await validatePackedSurface(archive, entrypoints);
  } finally {
    rmSync(multiExportRoot, { recursive: true, force: true });
  }
}

try {
  assertExportMutationsFail();
  validateExportSubpath('.', '@jinn-network/runtime');
  validateExportSubpath('./extra', '@jinn-network/runtime');
  try {
    validateExportSubpath('../escape', '@jinn-network/runtime');
    throw new Error('expected ../escape to fail');
  } catch (error) {
    if (!/subpath must be/.test(error.message)) throw error;
  }
  validateExportTarget(
    { types: './dist/index.d.ts', import: './dist/index.js' },
    '@jinn-network/runtime',
    '.',
  );

  await mkdir(archivesRoot);
  const archives = new Map();
  for (const pkg of livePackages) {
    const entrypoints = derivePublicCodeEntrypoints(pkg.manifest);
    const archive = await packOne(pkg.absoluteDirectory, pkg.name);
    await validatePackedSurface(archive, entrypoints);
    archives.set(pkg.name, archive);
  }

  await runLiveConsumer(archives);

  for (const pkg of livePackages.filter((entry) => entry.directory === 'runtime')) {
    const installed = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', ...pkg.name.split('/'), 'package.json'),
      'utf8',
    ));
    if (installed.name !== pkg.name) {
      throw new Error(`${pkg.directory} installed as ${installed.name ?? 'an unnamed package'}`);
    }
    if (installed.publishConfig?.provenance !== true) {
      throw new Error(`${pkg.name} must publish with provenance (custody law C5)`);
    }
  }

  await validateMultiExportFixture();

  console.log(
    `Compiled a hermetic packed TypeScript consumer against ${liveEntrypoints.length} public code entrypoints across ${livePackages.length} plugin tree packages.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
