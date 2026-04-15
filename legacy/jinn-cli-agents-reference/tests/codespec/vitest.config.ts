import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    // CodeSpec tests don't need VNet/Ponder infrastructure
    // They test the review/ledger/autofix workflow in isolation
    include: ['tests/codespec/**/*.e2e.test.ts'],

    // Sequential execution (git operations might conflict)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // Longer timeout for review operations (can take 30-120s each)
    testTimeout: 300000, // 5 minutes per test

    // Environment
    globals: true,

    // Root directory for relative imports
    root: resolve(__dirname, '../..'),
  },

  resolve: {
    alias: {
      '@codespec': resolve(__dirname, '../../codespec'),
      '@tests': resolve(__dirname, '..'),
    },
  },
});
