import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Release Tier 1 vitest configuration.
 *
 * The heavy Tier 1 release scenarios (T1.1, T1.2) need external prerequisites
 * the default `yarn test` run cannot assume — T1.1 forks real Base mainnet RPC
 * (~1 min) and T1.2 needs a built `dist/bin/jinn.js`. They are excluded from
 * `vitest.config.ts` so a clean-checkout `yarn test` stays green; they run only
 * via the dedicated scripts:
 *
 *   yarn release:tier-1:T1.1
 *   yarn release:tier-1:T1.2
 *   yarn release:tier-1:T1.3
 *
 * T1.3 (contract conformance) is boot-less — no daemon, no RPC — so it also runs under
 * the default `yarn test` (`test/release/**\/*.test.ts` is in `vitest.config.ts`'s
 * `nodeInclude`); it's registered here too so `yarn release:tier-1:T1.3` works standalone.
 *
 * Prerequisites:
 *   - `anvil` in PATH (Foundry — https://getfoundry.sh/)
 *   - `BASE_RPC_URL` reachable (defaults to https://mainnet.base.org)
 *   - `yarn build` run first (T1.2 spawns dist/bin/jinn.js)
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
    globals: true,
    include: [
      'test/release/tier-1/T1.1-bootstrap-fresh-anvil.test.ts',
      'test/release/tier-1/T1.2-harness-readiness-contract.test.ts',
      'test/release/tier-1/T1.3-contract-conformance.test.ts',
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
