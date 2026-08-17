import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = join(root, 'packages', 'read-plane');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-read-plane-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');
const name = '@jinn-network/read-plane';

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
      if (code === 0) { resolvePromise(output); return; }
      reject(new Error(`${command} exited with ${code}:\n${output}${errorOutput}`));
    });
  });
}

try {
  await mkdir(archivesRoot);
  const packed = JSON.parse(await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', archivesRoot],
    { cwd: packageRoot },
  ));
  if (packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
    throw new Error(`npm pack returned an unexpected result for ${name}`);
  }
  const archive = join(archivesRoot, packed[0].filename);
  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      [name]: `file:${archive}`,
      '@types/node': '^22.0.0',
      typescript: '^5.9.3',
    },
  }, null, 2));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot });
  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    `import { ConstructorTokenGate, healthResponse, parseLastEventId } from ${JSON.stringify(name)};\n`
      + 'export const health: typeof healthResponse = healthResponse;\n'
      + 'export const parseId: typeof parseLastEventId = parseLastEventId;\n'
      + 'export type Gate = ConstructorTokenGate;\n',
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
  const typescript = join(consumerRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  await run(typescript, ['--project', 'tsconfig.json'], { cwd: consumerRoot });
  console.log('Compiled a packed TypeScript consumer against @jinn-network/read-plane.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
