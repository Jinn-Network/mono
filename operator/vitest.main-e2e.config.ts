import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Dedicated config for main.ts subprocess e2e tests (issue #2407 R1).
 *
 * `test/main/**\/*.e2e.test.ts` files spawn the REAL built `dist/bin/jinn.js`
 * binary against a loopback RPC stub — they need `yarn build` to have run
 * first, which is why they're `.e2e.test.ts` (auto-excluded from the default
 * `vitest.config.ts` glob, same convention as
 * `test/dashboard/*.e2e.test.ts`) rather than plain `.test.ts`: CI's `check`
 * job runs `yarn test` BEFORE `yarn build`, so a plain `.test.ts` here would
 * throw `dist/bin/jinn.js missing` on every clean checkout.
 *
 * Invoke via `yarn e2e:degraded-daemon-guard` (which runs `yarn build` first),
 * wired into its own CI job alongside `funding-sequence-e2e`.
 */
export default defineConfig({
  test: {
    include: ['test/main/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    alias: {
      '@test/': fileURLToPath(new URL('./test/_support/', import.meta.url)),
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
});
