import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
// Flipped to 'operator' by the stage-5 rename commit.
const TREE = 'operator';
const treeRoot = join(root, TREE);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const out = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => out.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const text = Buffer.concat(out).toString('utf8');
      if (code === 0) resolvePromise(text);
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}:\n${text}`));
    });
  });
}

test('packed operator tarball exposes resolvable declarations', async (t) => {
  assert.ok(
    existsSync(join(treeRoot, 'dist', 'index.d.ts')),
    `run \`cd ${TREE} && yarn build\` before this canary`,
  );

  const scratch = await mkdtemp(join(tmpdir(), 'jinn-operator-packed-types-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  await run('npm', ['pack', '--silent', '--pack-destination', scratch], { cwd: treeRoot });
  const [archive] = (await readdir(scratch)).filter((name) => name.endsWith('.tgz'));
  assert.ok(archive, 'npm pack produced no tarball');

  const consumer = join(scratch, 'consumer');
  await run('mkdir', ['-p', consumer]);
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'operator-packed-types-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  await writeFile(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022',
        strict: true, noEmit: true, skipLibCheck: true, types: [],
      },
      files: ['probe.ts'],
    }, null, 2)}\n`,
  );
  await writeFile(
    join(consumer, 'probe.ts'),
    "import * as operator from '@jinn-network/client';\nexport type Probe = typeof operator;\n",
  );

  await run('npm', ['install', '--no-audit', '--no-fund', join(scratch, archive), 'typescript@5.9.3'], { cwd: consumer });
  const tsc = join(
    consumer,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  await run(tsc, ['--project', 'tsconfig.json'], { cwd: consumer });
});
