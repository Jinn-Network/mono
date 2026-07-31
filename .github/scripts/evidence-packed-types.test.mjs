import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceRoot = join(root, 'packages', 'evidence');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-evidence-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const packages = [
  ['protocol', '@jinn-network/evidence-protocol'],
  ['repository', '@jinn-network/evidence-repository'],
  ['repository-oci', '@jinn-network/evidence-repository-oci'],
  ['repository-ipfs', '@jinn-network/evidence-repository-ipfs'],
  ['discovery', '@jinn-network/evidence-discovery'],
  ['catalog-sqlite', '@jinn-network/evidence-catalog-sqlite'],
  ['execution-recorder', '@jinn-network/execution-recorder'],
  ['attestation-issuer', '@jinn-network/attestation-issuer'],
  ['derivation', '@jinn-network/evidence-derivation'],
  ['publication', '@jinn-network/evidence-publication'],
  ['local-runtime', '@jinn-network/evidence-local-runtime'],
  ['execution-recorder-bridge', '@jinn-network/execution-recorder-bridge'],
  ['retrieval', '@jinn-network/evidence-retrieval'],
  ['contribution', '@jinn-network/evidence-contribution'],
  ['trajectory', '@jinn-network/evidence-trajectory'],
];

const codeEntrypoints = [
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-repository/testing',
  '@jinn-network/evidence-repository/fs',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-repository-ipfs/cid',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-discovery/testing',
  '@jinn-network/evidence-discovery/indexer',
  '@jinn-network/evidence-discovery/journal',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder/testing',
  '@jinn-network/attestation-issuer',
  '@jinn-network/attestation-issuer/testing',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-derivation/testing',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-publication/testing',
  '@jinn-network/evidence-publication/fs',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/evidence-retrieval',
  '@jinn-network/evidence-retrieval/testing',
  '@jinn-network/evidence-contribution',
  '@jinn-network/evidence-contribution/testing',
  '@jinn-network/evidence-trajectory',
  '@jinn-network/evidence-trajectory/testing',
];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
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
      reject(new Error(
        `${command} exited with ${code}:\n${output}${errorOutput}`,
      ));
    });
  });
}

try {
  await mkdir(archivesRoot);
  const archives = new Map();
  for (const [directory, name] of packages) {
    const packed = JSON.parse(await run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', archivesRoot],
      { cwd: join(evidenceRoot, directory) },
    ));
    if (packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
      throw new Error(`npm pack returned an unexpected result for ${name}`);
    }
    archives.set(name, join(archivesRoot, packed[0].filename));
  }

  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([
      ...packages.map(([, name]) => [name, `file:${archives.get(name)}`]),
      ['@types/better-sqlite3', '7.6.13'],
      ['@types/node', '^22.0.0'],
      ['typescript', '^5.9.3'],
      ['vitest', '^4.1.8'],
    ]),
  }, null, 2));
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: consumerRoot },
  );

  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    codeEntrypoints
      .map((specifier, index) => `import type * as Entry${index} from ${JSON.stringify(specifier)};`)
      .join('\n')
      + '\n\n'
      + `export type EvidenceEntrypoints = [\n${codeEntrypoints
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

  for (const [directory, name] of packages) {
    const installed = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', ...name.split('/'), 'package.json'),
      'utf8',
    ));
    if (installed.name !== name) {
      throw new Error(`${directory} installed as ${installed.name ?? 'an unnamed package'}`);
    }
  }

  console.log(
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoints across all ${packages.length} evidence packages.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
