import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Dedicated config for the HERMETIC GATE (.github/workflows/hermetic-gate.yml,
 * `yarn test:hermetic`).
 *
 * The hermetic suite's heavy files each spawn their own Anvil (loaded from the
 * committed `--dump-state` snapshot) plus, variously, a local Ponder indexer or
 * a real daemon subprocess, and drive the production loop/adapter against real
 * bytecode (spec §3.1/§5). Two properties matter here and differ from the unit
 * `yarn test`:
 *
 *   - fileParallelism: false — the files must run SEQUENTIALLY. Running them
 *     concurrently contends for CPU / ports / RPC and flakes (e.g. the indexer
 *     round-trip's Ponder sync starves). Sequential keeps "a red is always a
 *     real regression" true.
 *   - long timeout — bootstrap-from-scratch + the full loop + Ponder sync take
 *     tens of seconds.
 *
 * The snapshot/subprocess tests are EXCLUDED from the default vitest.config.ts so
 * a clean / no-Foundry checkout never tries to spawn them; this config is the one
 * place they run. (abi-selector-conformance + rpc-fallback are pure-unit and run
 * in both.)
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['test/hermetic/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
    alias: {
      '@test/': fileURLToPath(new URL('./test/_support/', import.meta.url)),
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
});
