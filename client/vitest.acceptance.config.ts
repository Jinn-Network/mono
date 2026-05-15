import { defineConfig } from 'vitest/config';

/**
 * Acceptance-tier vitest configuration.
 *
 * This tier runs slow, real-integration tests that require external binaries
 * (Foundry's `anvil`) and exercise the full CLI dispatch surface. It is NOT
 * included in the default `yarn test` run — invoke explicitly:
 *
 *   yarn e2e:cold-start-builder
 *
 * Prerequisites:
 *   - `anvil` in PATH (Foundry — https://getfoundry.sh/)
 *   - Node 22+
 *
 * Timing budget: ~90 s for the combined cold-start + dual-role describes.
 * Single-fork pool prevents concurrent Anvil port collisions.
 */
export default defineConfig({
  test: {
    include: ['test/acceptance/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
    coverage: { enabled: false },
    passWithNoTests: true,
  },
});
