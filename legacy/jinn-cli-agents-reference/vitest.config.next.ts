import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

export default defineConfig({
  resolve: {
    alias: {
      'jinn-node': path.resolve(__dirname, './jinn-node/src'),
      'mech-client-ts': path.resolve(__dirname, './packages/mech-client-ts'),
      '@jinn/types': path.resolve(__dirname, './jinn-node/src/types'),
      '@codespec': path.resolve(__dirname, './codespec'),
      '@tests-next': path.resolve(__dirname, './tests-next'),
      '@': path.resolve(__dirname, './frontend/explorer/src'),
      // Deduplicate packages that exist in nested node_modules/ so vi.mock() works
      // (jinn-node subtree and x402-gateway have their own node_modules; test mocks target root copies)
      'web3': path.resolve(__dirname, './node_modules/web3'),
      '@jinn-network/mech-client-ts': path.resolve(__dirname, './node_modules/@jinn-network/mech-client-ts'),
      'cross-fetch': path.resolve(__dirname, './node_modules/cross-fetch'),
      'pg': path.resolve(__dirname, './node_modules/pg'),
      'yaml': path.resolve(__dirname, './jinn-node/node_modules/yaml/dist/index.js'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests-next/**/*.test.ts'],
    exclude: [
      '**/.conductor/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.tmp/**',
      '**/temp-build/**',
    ],
    fileParallelism: false,
    sequence: {
      shuffle: false,
      concurrent: false,
    },
    testTimeout: 240_000, // 4 minutes max for system tests
  },
});

