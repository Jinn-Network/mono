import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import path from 'path'

// Load .env.test and merge into process.env so tests have access
const testEnv = loadEnv('test', process.cwd(), '')
Object.assign(process.env, testEnv)

export default defineConfig({
  resolve: {
    alias: {
      'mech-client-ts': path.resolve(__dirname, '../../packages/mech-client-ts'),
    },
  },
  test: {
    globals: true,
    env: testEnv,
    include: [path.resolve(__dirname, '*.test.ts')],
    globalSetup: path.resolve(__dirname, '../helpers/setup.ts'),
    fileParallelism: false,
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
