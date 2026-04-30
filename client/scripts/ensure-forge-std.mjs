#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const contractsRoot = resolve(process.cwd());
const forgeStdRoot = join(contractsRoot, 'lib', 'forge-std');
const sentinel = join(forgeStdRoot, 'src', 'Test.sol');

if (existsSync(sentinel)) {
  console.log(`forge-std already present at ${forgeStdRoot}`);
  process.exit(0);
}

const result = spawnSync('forge', ['install', 'foundry-rs/forge-std', '--no-git'], {
  cwd: contractsRoot,
  encoding: 'utf8',
  stdio: 'pipe',
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status === 0 || existsSync(sentinel)) {
  process.exit(0);
}

process.exit(result.status ?? 1);
