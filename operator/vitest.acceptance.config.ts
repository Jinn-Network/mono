import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

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
    // Every test file gets its own isolated home, with `$TMPDIR` redirected inside it and swept on
    // teardown, so no test in this tier reads or rewrites the developer's real `~/.jinn-client` and
    // nothing it creates in the temp directory outlives the run. Same seam as `vitest.config.ts`.
    setupFiles: [fileURLToPath(new URL('./test/_support/isolate-home.ts', import.meta.url))],
    // Per-run registry in the main process, swept once every worker is gone — the only thing that
    // cleans up after a fully-skipped file, a hard-killed worker, or Ctrl-C.
    globalSetup: [fileURLToPath(new URL('./test/_support/global-tmp-root.ts', import.meta.url))],
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
