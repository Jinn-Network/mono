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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function fixSpawnHelper() {
  if (process.platform !== 'darwin') return;

  // The script ships in two places depending on context:
  //   - dev: client/scripts/fix-node-pty.mjs    (uses ../node_modules)
  //   - published: client/dist/scripts/         (uses ../../node_modules)
  // Try both upward paths.
  const candidateRoots = [
    path.join(__dirname, '..'),
    path.join(__dirname, '..', '..'),
  ];

  let prebuildsDir = null;
  for (const root of candidateRoots) {
    const candidate = path.join(root, 'node_modules', 'node-pty', 'prebuilds');
    try {
      await fs.access(candidate);
      prebuildsDir = candidate;
      break;
    } catch {
      // try next
    }
  }
  if (!prebuildsDir) return; // node-pty not installed; nothing to fix

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

fixSpawnHelper().catch((err) => {
  console.warn('[postinstall] fix-node-pty failed (non-fatal):', err.message);
});
