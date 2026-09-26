import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Dedicated config for the Phase B restart-drill verification (#2434,
 * `yarn drill:native-restart:verify`).
 *
 * The drill's own end-to-end test spawns Anvil twelve times and eighteen role-host processes, so
 * it is excluded from the default `yarn test` by `vitest.config.ts`'s `test/**\/*.e2e.test.ts`
 * rule — a clean or no-Foundry checkout must not try to run it. That exclusion is not overridable
 * from the CLI, so this config is the one place the file runs.
 *
 * Sequential and long-timeout for the same reason as the hermetic gate: the drill owns real ports
 * and real processes, and a red here must always be a real regression rather than contention.
 */
export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('./test/_support/isolate-home.ts', import.meta.url))],
    globalSetup: [fileURLToPath(new URL('./test/_support/global-tmp-root.ts', import.meta.url))],
    globals: true,
    include: ['test/native-drill/**/*.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    alias: {
      '@test/': fileURLToPath(new URL('./test/_support/', import.meta.url)),
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
});
