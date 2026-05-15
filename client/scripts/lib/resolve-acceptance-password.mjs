/**
 * Password resolution for release acceptance / setup scripts (Node .mjs).
 *
 * Mirrors `src/cli/password.ts` `resolveCliPassword` so operators who use
 * `jinn run` (keystore-password file) do not need to export
 * JINN_PASSWORD every time they run acceptance gates.
 *
 * Priority:
 *   1. JINN_TESTNET_ACCEPTANCE_PASSWORD  (acceptance-only override)
 *   2. JINN_PASSWORD
 *   3. <acceptanceHome>/.jinn-client/keystore-password  (if acceptanceHome set)
 *   4. ~/.jinn-client/keystore-password
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acceptanceClientHome } from './acceptance-operator-config.mjs';

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ acceptanceHome?: string }} [opts]
 * @returns {string | undefined}
 */
export function resolveAcceptancePassword(env, opts = {}) {
  const a = env['JINN_TESTNET_ACCEPTANCE_PASSWORD']?.trim();
  if (a) return a;
  const b = env['JINN_PASSWORD']?.trim();
  if (b) return b;

  const { acceptanceHome } = opts;
  const candidates = [];
  if (acceptanceHome) {
    candidates.push(join(acceptanceClientHome(acceptanceHome), 'keystore-password'));
  }
  const home = env['HOME']?.trim() || homedir();
  candidates.push(join(home, '.jinn-client', 'keystore-password'));

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const v = readFileSync(p, 'utf8').trim();
    if (v.length > 0) return v;
  }
  return undefined;
}

export const PASSWORD_RESOLUTION_HINT =
  'Set JINN_PASSWORD or JINN_TESTNET_ACCEPTANCE_PASSWORD, or ensure '
  + '~/.jinn-client/keystore-password exists (from `jinn run`).';
