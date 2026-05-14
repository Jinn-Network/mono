import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
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
