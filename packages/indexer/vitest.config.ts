import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const stub = fileURLToPath(
  new URL('./test/helpers/ponder-virtual-stubs.ts', import.meta.url),
);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Ponder virtual modules cannot be resolved under Vitest. Alias them to a
    // proxy stub so tests of pure helpers in src/api/* can import those
    // helpers without booting Ponder. DB-touching code paths are tested
    // elsewhere (handlers.test.ts via in-memory db) and via integration runs.
    alias: {
      'ponder:api': stub,
      'ponder:schema': stub,
    },
  },
});
