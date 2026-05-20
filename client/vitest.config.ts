import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    // CI runners are slower than dev machines; bootstrap tests that take ~1.8s
    // locally have crossed the 5s default under runner load. Give every test
    // 30s and every hook 30s so transient CI slowness doesn't masquerade as a
    // test regression and block canary publishes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      'test/**/*.test.ts',
      // Plugin tests live next to the plugin source under plugins/*/test/.
      'plugins/**/test/**/*.test.ts',
      // SPA component tests live next to their components in src/dashboard/spa.
      'src/dashboard/spa/src/**/*.test.{ts,tsx}',
      // Release-tier scenario tests live in *.test.ts siblings next to the
      // callable *.ts files (which have no Vitest deps and are safe to import
      // from the orchestrator without triggering Vitest at module load time).
      'test/release/**/*.test.ts',
      // The release-readiness scaffolding unit test lives next to its source
      // under scripts/release/ (pure unit test, no network or real spend).
      'scripts/release/**/*.test.ts',
    ],
    exclude: [
      'test/e2e/**',
      'test/**/*.e2e.test.ts',
      'node_modules/**',
      // Heavy Tier 1 release scenarios need external prerequisites — T1.1 forks
      // real Base mainnet RPC (~1min), T1.2 needs a built `dist/bin/jinn.js`.
      // They break a clean-checkout `yarn test` run, so they are excluded from
      // the default suite and run only via `yarn release:tier-1[:T1.x]`.
      // The pure-unit tests in that dir (scenario-types, T1.3 skip stub) stay
      // in the default run.
      'test/release/tier-1/T1.1-bootstrap-fresh-anvil.test.ts',
      'test/release/tier-1/T1.2-harness-readiness-contract.test.ts',
    ],
    // Default to node; SPA component tests opt into jsdom via the .tsx
    // matcher below. Keeps the daemon-side suite as fast as it is today.
    environmentMatchGlobs: [
      ['src/dashboard/spa/src/**/*.test.tsx', 'jsdom'],
    ],
    alias: {
      '@test/': fileURLToPath(new URL('./test/_support/', import.meta.url)),
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
});
