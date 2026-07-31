import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  APPROVED_RUNTIME_DEV_DEPENDENCIES,
  derivePublicCodeEntrypoints,
  discoverPluginPackages,
  pluginRoot,
} from './plugin-tree-guard-common.mjs';

const treeRoot = pluginRoot;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-plugin-tree-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const packages = discoverPluginPackages();
const multiExportFixture = mkdtempSync(join(treeRoot, '.plugin-tree-multi-export-'));
const multiExportDir = join(multiExportFixture, 'multi-export-pkg');
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

const discoveredPackages = discoverPluginPackages();
const multiExportPackage = discoveredPackages.find((pkg) => pkg.name === '@jinn-network/multi-export-fixture');
if (!multiExportPackage) {
  throw new Error('multi-export fixture package must be discovered before packed-types validation');
}
const multiExportEntrypoints = derivePublicCodeEntrypoints(multiExportPackage.manifest);
if (multiExportEntrypoints.length !== 2) {
  throw new Error(`expected two public code entrypoints, got ${multiExportEntrypoints.length}`);
}

const allEntrypoints = discoveredPackages.flatMap((pkg) =>
  derivePublicCodeEntrypoints(pkg.manifest).map((entrypoint) => ({
    packageName: pkg.name,
    importSpecifier: entrypoint.subpath === '.'
      ? pkg.name
      : `${pkg.name}${entrypoint.subpath.slice(1)}`,
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

try {
  await mkdir(archivesRoot);
  const archives = new Map();
  for (const pkg of discoveredPackages) {
    archives.set(pkg.name, await packOne(pkg.absoluteDirectory, pkg.name));
  }

  await mkdir(consumerRoot);
  const consumerManifest = {
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(
      discoveredPackages.map((pkg) => [pkg.name, `file:${archives.get(pkg.name)}`]),
    ),
    devDependencies: {
      '@types/node': APPROVED_RUNTIME_DEV_DEPENDENCIES['@types/node'],
      typescript: APPROVED_RUNTIME_DEV_DEPENDENCIES.typescript,
    },
  };
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify(consumerManifest, null, 2));
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot });
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot });

  const installedTypescript = JSON.parse(await readFile(
    join(consumerRoot, 'node_modules', 'typescript', 'package.json'),
    'utf8',
  ));
  if (installedTypescript.version !== APPROVED_RUNTIME_DEV_DEPENDENCIES.typescript) {
    throw new Error(`packed consumer installed typescript@${installedTypescript.version}, expected ${APPROVED_RUNTIME_DEV_DEPENDENCIES.typescript}`);
  }

  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    allEntrypoints
      .map((entrypoint, index) => `import type * as Entry${index} from ${JSON.stringify(entrypoint.importSpecifier)};`)
      .join('\n')
      + '\n\n'
      + `export type PluginTreeEntrypoints = [\n${allEntrypoints
        .map((_, index) => `  typeof Entry${index},`)
        .join('\n')}\n];\n`,
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

  for (const pkg of discoveredPackages.filter((entry) => entry.directory === 'runtime' || entry.name === '@jinn-network/multi-export-fixture')) {
    const installed = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', ...pkg.name.split('/'), 'package.json'),
      'utf8',
    ));
    if (installed.name !== pkg.name) {
      throw new Error(`${pkg.directory} installed as ${installed.name ?? 'an unnamed package'}`);
    }
    if (pkg.directory === 'runtime' && installed.publishConfig?.provenance !== true) {
      throw new Error(`${pkg.name} must publish with provenance (custody law C5)`);
    }
  }

  console.log(
    `Compiled a hermetic packed TypeScript consumer against ${allEntrypoints.length} public code entrypoints across ${discoveredPackages.length} plugin tree packages.`,
  );
} finally {
  rmSync(multiExportFixture, { recursive: true, force: true });
  await rm(temporaryRoot, { recursive: true, force: true });
}
