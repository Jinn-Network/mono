#!/usr/bin/env node
/**
 * Fix node-pty spawn-helper permissions on macOS.
 *
 * node-pty's prebuilt darwin-{arm64,x64} packages ship the `spawn-helper`
 * binary with mode 644 instead of 755. posix_spawnp can't exec it, so the
 * first pty.spawn() call throws with "posix_spawnp failed". The fix is a
 * 1-line chmod; without it the agent panel's claude subprocess fails to
 * start with a misleading "no stdin data received" error.
 *
 * Pattern lifted from siteboon/claudecodeui (scripts/fix-node-pty.js).
 * Upstream issue: https://github.com/microsoft/node-pty/issues/850
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function unique(values) {
  return [...new Set(values)];
}

function candidateRoots() {
  // The script ships in two places depending on context:
  //   - dev: operator/scripts/fix-node-pty.mjs
  //   - published: operator/dist/scripts/
  // npm/npx may hoist node-pty to an ancestor node_modules, so use normal
  // Node resolution with several package-root candidates instead of assuming
  // @jinn-network/operator/node_modules exists.
  return unique([
    __dirname,
    path.join(__dirname, '..'),
    path.join(__dirname, '..', '..'),
    process.cwd(),
  ]);
}

function resolveNodePtyPackageDir(required) {
  try {
    return path.dirname(require.resolve('node-pty/package.json', { paths: candidateRoots() }));
  } catch (err) {
    if (required) throw err;
    return null;
  }
}

async function fixSpawnHelper({ required = false } = {}) {
  const packageDir = resolveNodePtyPackageDir(required);
  if (!packageDir) return;
  if (process.platform !== 'darwin') return;

  const prebuildsDir = path.join(packageDir, 'prebuilds');

  for (const dir of ['darwin-arm64', 'darwin-x64']) {
    const helper = path.join(prebuildsDir, dir, 'spawn-helper');
    try {
      await fs.access(helper);
      await fs.chmod(helper, 0o755);
      console.log(`[postinstall] chmod 755 ${helper}`);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.warn(`[postinstall] could not fix ${helper}: ${err.message}`);
      }
    }
  }
}

async function verifyNodePty() {
  const ptyModule = await import('node-pty');
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('node-pty verification timed out'));
    }, 5000);
    try {
      const pty = ptyModule.spawn(process.execPath, ['-e', 'process.exit(0)'], {
        name: 'xterm-256color',
        cols: 10,
        rows: 4,
        cwd: process.cwd(),
        env: process.env,
      });
      pty.onExit(({ exitCode }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitCode === 0) resolve();
        else reject(new Error(`node-pty verification exited with ${exitCode}`));
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
  console.log('[postinstall] node-pty verification ok');
}

const verify = process.argv.includes('--verify');

fixSpawnHelper({ required: verify })
  .then(() => verify ? verifyNodePty() : undefined)
  .catch((err) => {
    console.warn('[postinstall] fix-node-pty failed:', err instanceof Error ? err.message : String(err));
    if (verify) process.exit(1);
  });
