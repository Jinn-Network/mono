import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const operatorRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(operatorRoot, 'package.json'), 'utf8')) as {
  name: string;
  bin: Record<string, string>;
};
const operatorReadme = readFileSync(join(operatorRoot, 'README.md'), 'utf8');
const releasingDoc = readFileSync(join(operatorRoot, 'RELEASING.md'), 'utf8');
const testnetRunbook = readFileSync(join(operatorRoot, '../docs/operator-testnet.md'), 'utf8');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function packStubWithOperatorBins(): { tarball: string; consumerDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'jinn-npx-operator-'));
  tempDirs.push(root);
  const pkgDir = join(root, 'pkg');
  mkdirSync(join(pkgDir, 'dist', 'bin'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    `${JSON.stringify({
      name: pkg.name,
      version: '0.0.0-npx-invocation',
      bin: pkg.bin,
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(pkgDir, 'dist', 'bin', 'jinn.js'),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ bin: "jinn", argv: process.argv.slice(2) }) + "\\n");\n',
  );
  writeFileSync(
    join(pkgDir, 'dist', 'bin', 'jinn-stop-hook.js'),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ bin: "jinn-stop-hook" }) + "\\n");\n',
  );
  chmodSync(join(pkgDir, 'dist', 'bin', 'jinn.js'), 0o755);
  chmodSync(join(pkgDir, 'dist', 'bin', 'jinn-stop-hook.js'), 0o755);

  const packed = run('npm', ['pack', '--silent', '--pack-destination', root], pkgDir);
  expect(packed.status, packed.stderr || packed.stdout).toBe(0);
  const filename = packed.stdout.trim();
  expect(filename).toMatch(/\.tgz$/);

  const consumerDir = join(root, 'consumer');
  mkdirSync(consumerDir);
  run('npm', ['init', '-y'], consumerDir);
  const install = run('npm', ['install', '--loglevel=error', join(root, filename)], consumerDir);
  expect(install.status, install.stderr || install.stdout).toBe(0);
  return { tarball: join(root, filename), consumerDir };
}

describe('public @jinn-network/operator npx invocation', () => {
  it('declares an operator bin alias of the jinn CLI and keeps jinn-stop-hook', () => {
    expect(pkg.name).toBe('@jinn-network/operator');
    expect(pkg.bin.jinn).toBe('./dist/bin/jinn.js');
    expect(pkg.bin.operator).toBe('./dist/bin/jinn.js');
    expect(pkg.bin['jinn-stop-hook']).toBe('./dist/bin/jinn-stop-hook.js');
  });

  it('shows one public no-install command and does not name the retired client package', () => {
    expect(operatorReadme).toContain('npx @jinn-network/operator@latest doctor');
    expect(operatorReadme).not.toMatch(/@jinn-network\/client/);
    expect(operatorReadme).not.toMatch(/npx -p @jinn-network\/operator/);
    expect(releasingDoc).toContain('npx @jinn-network/operator@latest <verb>');
    expect(releasingDoc).not.toMatch(/npx -p @jinn-network\/operator/);
    expect(testnetRunbook).not.toMatch(/@jinn-network\/client/);
  });

  it('runs the public no-install command against a packed tarball', () => {
    const { consumerDir } = packStubWithOperatorBins();
    const result = run('npx', ['--no-install', '@jinn-network/operator', 'doctor'], consumerDir);
    expect(result.stderr ?? '').not.toMatch(/could not determine executable/);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ bin: 'jinn', argv: ['doctor'] });
  });

  it('keeps jinn-stop-hook invocable by name from the packed tarball', () => {
    const { consumerDir } = packStubWithOperatorBins();
    const result = run(
      'npx',
      ['--no-install', '-p', '@jinn-network/operator', 'jinn-stop-hook'],
      consumerDir,
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ bin: 'jinn-stop-hook' });
  });
});
