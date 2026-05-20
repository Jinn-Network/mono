import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Release Tier 1 vitest configuration.
 *
 * The heavy Tier 1 release scenarios (T1.1, T1.2) need external prerequisites
 * the default `yarn test` run cannot assume — T1.1 forks real Base mainnet RPC
 * (~1 min), T1.2 needs a built `dist/bin/jinn.js`. They are excluded from
 * `vitest.config.ts` so a clean-checkout `yarn test` stays green; they run
 * only via the dedicated scripts:
 *
 *   yarn release:tier-1:T1.1
 *   yarn release:tier-1:T1.2
 *
 * Prerequisites:
 *   - `anvil` in PATH (Foundry — https://getfoundry.sh/)
 *   - `BASE_RPC_URL` reachable (defaults to https://mainnet.base.org)
 *   - `yarn build` run first (T1.2 spawns dist/bin/jinn.js)
 */
export default defineConfig({
  test: {
    globals: true,
    include: [
      'test/release/tier-1/T1.1-bootstrap-fresh-anvil.test.ts',
      'test/release/tier-1/T1.2-harness-readiness-contract.test.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
    alias: {
      '@test/': fileURLToPath(new URL('./test/_support/', import.meta.url)),
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
});
