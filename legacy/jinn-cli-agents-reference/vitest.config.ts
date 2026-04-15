import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import path from 'path'

// Load .env.test but DON'T merge into process.env at module level for marketplace/worker
// (prevents stale RPC_URL from overriding fresh VNet created by global setup)
const testEnv = loadEnv('test', process.cwd(), '')

// Shared alias configuration - preserves main's @jinn/types + adds our aliases
const sharedResolve = {
  alias: {
    'jinn-node': path.resolve(__dirname, './jinn-node/src'),
    'mech-client-ts': path.resolve(__dirname, './packages/mech-client-ts'),
    '@jinn/types': path.resolve(__dirname, './jinn-node/src/types'),
    '@codespec': path.resolve(__dirname, './codespec'),
    '@tests': path.resolve(__dirname, './tests'),
    // Deduplicate ethers so vi.mock('ethers') works for jinn-node modules
    // (jinn-node has its own node_modules/ethers@6.16.0; root has 6.15.0)
    'ethers': path.resolve(__dirname, './node_modules/ethers'),
    // Deduplicate cross-fetch so vi.mock('cross-fetch') works for jinn-node modules
    'cross-fetch': path.resolve(__dirname, './node_modules/cross-fetch'),
    // yaml lives in jinn-node/node_modules (not root); alias for tests-next config tests
    'yaml': path.resolve(__dirname, './jinn-node/node_modules/yaml/dist/index.js'),
  },
}

// Shared test defaults
const sharedTestDefaults = {
  globals: true,
  fileParallelism: false,
  sequence: {
    shuffle: false,
    concurrent: false,
  },
  exclude: [
    '**/.conductor/**',
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/.tmp/**',
    '**/temp-build/**',
  ],
}

export default defineConfig({
  resolve: sharedResolve,
  test: {
    ...sharedTestDefaults,
    // Define all test suites as projects for auto-detection
    projects: [
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestDefaults,
          name: 'marketplace',
          // Don't pass testEnv here - it would override dynamic values set by global setup
          include: ['tests/marketplace/*.test.ts'],
          globalSetup: path.resolve(__dirname, './tests/helpers/setup.ts'),
          poolOptions: {
            threads: {
              singleThread: true,
            }
          },
          reporters: ['default', 'hanging-process'],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestDefaults,
          name: 'worker',
          // Don't use 'env: testEnv' here - it overrides runtime values set by globalSetup
          include: ['tests/worker/*.test.ts'],
          globalSetup: path.resolve(__dirname, './tests/helpers/setup.ts'),
          bail: 1, // Stop after first test failure (e.g., quota errors)
          poolOptions: {
            threads: {
              singleThread: true,
            }
          },
          reporters: ['default', 'hanging-process'],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestDefaults,
          name: 'git',
          // Don't use 'env: testEnv' here - it overrides runtime values set by globalSetup
          include: ['tests/git/*.test.ts'],
          globalSetup: path.resolve(__dirname, './tests/helpers/setup.ts'),
          bail: 1, // Stop after first test failure (e.g., quota errors)
          poolOptions: {
            threads: {
              singleThread: true,
            }
          },
          reporters: ['default', 'hanging-process'],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestDefaults,
          name: 'service',
          env: testEnv,
          include: ['tests/service-deployment/*.test.ts'],
          globalSetup: path.resolve(__dirname, './tests/helpers/setup.ts'),
          poolOptions: {
            threads: {
              singleThread: true,
            }
          },
          reporters: ['default', 'hanging-process'],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestDefaults,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestDefaults,
          name: 'codespec',
          // CodeSpec tests don't need VNet/Ponder infrastructure
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
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestDefaults,
          name: 'e2e',
          // Pattern-based matching for e2e tests (from main's config)
          include: ['tests/e2e/**/*.e2e.test.ts'],
          environment: 'node',
          timeout: 120000, // 2 minutes per test (from main's config)
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestDefaults,
          name: 'integration',
          // Pattern-based matching for integration tests (from main's config)
          include: ['tests/integration/**/*.integration.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
