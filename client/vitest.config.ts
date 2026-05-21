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
    ],
    exclude: ['test/e2e/**', 'test/**/*.e2e.test.ts', 'node_modules/**'],
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
