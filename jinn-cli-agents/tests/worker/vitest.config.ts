import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import path from 'path'

// Load .env.test but DON'T merge into process.env at module level
// This prevents stale RPC_URL from overriding fresh VNet created by global setup
const testEnv = loadEnv('test', process.cwd(), '')

export default defineConfig({
  resolve: {
    alias: {
      'mech-client-ts': path.resolve(__dirname, '../../packages/mech-client-ts'),
    },
  },
  test: {
    globals: true,
    // Don't use 'env: testEnv' here - it overrides runtime values set by globalSetup
    // The globalSetup loads .env.test and sets fresh VNet RPC_URL dynamically
    include: [path.resolve(__dirname, '*.test.ts')],
    globalSetup: path.resolve(__dirname, '../helpers/setup.ts'),
    fileParallelism: false,
    bail: 1, // Stop after first test failure (e.g., quota errors)
    poolOptions: {
      threads: {
        singleThread: true,
      }
    },
    sequence: {
      shuffle: false,
      concurrent: false,
    },
    reporters: ['default', 'hanging-process'],
  },
})
