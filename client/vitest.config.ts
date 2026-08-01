import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const nodeInclude = [
  'test/**/*.test.ts',
  // Plugin tests live next to the plugin source under plugins/*/test/.
  'plugins/**/test/**/*.test.ts',
  // Workspace-package tests live next to the package source under
  // packages/*/test/ (e.g. @jinn-network/harness-layer).
  'packages/*/test/**/*.test.ts',
  // SPA unit tests that do not render React components can stay in node.
  'src/dashboard/spa/src/**/*.test.ts',
  // Release-tier scenario tests live in *.test.ts siblings next to the
  // callable *.ts files (which have no Vitest deps and are safe to import
  // from the orchestrator without triggering Vitest at module load time).
  'test/release/**/*.test.ts',
  // The release-readiness scaffolding unit test lives next to its source
  // under scripts/release/ (pure unit test, no network or real spend).
  'scripts/release/**/*.test.ts',
];

const spaDomInclude = ['src/dashboard/spa/src/**/*.test.tsx'];

const exclude = [
  'test/e2e/**',
  'test/**/*.e2e.test.ts',
  'node_modules/**',
  // Fixtures are data, not tests. The jinn-repo corpus fixtures embed real
  // gold-test files (e.g. .../gold-test/client/test/.../safe.test.ts) that the
  // default glob would otherwise collect and fail to resolve (their imports are
  // repo-root-relative to a checkout, not to this tree).
  'test/fixtures/**',
  // Heavy Tier 1 release scenarios need external prerequisites — T1.1 forks
  // real Base mainnet RPC (~1min) and T1.2 needs a built `dist/bin/jinn.js`.
  // They break a clean-checkout `yarn test`, so they are excluded from the
  // default suite and run ONLY via `yarn release:tier-1[:T1.x]`. Only the
  // pure-unit scenario-types test in that dir stays in the default run.
  'test/release/tier-1/T1.1-bootstrap-fresh-anvil.test.ts',
  'test/release/tier-1/T1.2-harness-readiness-contract.test.ts',
  // Snapshot/subprocess-heavy hermetic-gate tests: each spawns Anvil
  // (+ Ponder / a real daemon) against the committed snapshot fixture and
  // needs Foundry on PATH. They run ONLY via the hermetic gate
  // (vitest.hermetic.config.ts, sequential) — not the default unit `yarn test`
  // (which a clean / no-Foundry checkout runs). The two pure-unit hermetic
  // tests (abi-selector-conformance, rpc-fallback) deliberately stay in the
  // default run.
  'test/hermetic/adversarial-claim-delivery.test.ts',
  'test/hermetic/adapter-claim-delivery.test.ts',
  'test/hermetic/bootstrap-from-scratch.test.ts',
  'test/hermetic/full-loop.test.ts',
  'test/hermetic/indexer-roundtrip.test.ts',
  // G0b's on-chain public-repository lifecycle compiles contracts and spawns
  // local Anvil. It runs only through task-creator:public-repo-anvil-e2e.
  'test/hermetic/public-repo-anvil-lifecycle.test.ts',
];

const alias = {
  '@test/': fileURLToPath(new URL('./test/_support/', import.meta.url)),
  '@/': fileURLToPath(new URL('./src/', import.meta.url)),
};

export default defineConfig({
  test: {
    globals: true,
    // CI runners are slower than dev machines; bootstrap tests that take ~1.8s
    // locally have crossed the 5s default under runner load. Give every test
    // 30s and every hook 30s so transient CI slowness doesn't masquerade as a
    // test regression and block canary publishes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Point `~` at a temp directory before any test module loads. `loadConfig()` with no
    // argument reads AND (since the shape-v2 migration) writes `~/.jinn-client/config.json`,
    // so without this the suite mutates the operator's real config. See
    // test/_support/isolate-home.ts.
    setupFiles: [fileURLToPath(new URL('./test/_support/isolate-home.ts', import.meta.url))],
    exclude,
    alias,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: nodeInclude,
        },
      },
      {
        extends: true,
        test: {
          name: 'spa-jsdom',
          environment: 'jsdom',
          include: spaDomInclude,
        },
      },
    ],
  },
});
