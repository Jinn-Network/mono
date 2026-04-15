/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapping: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ESNext',
        moduleResolution: 'Node',
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
      }
    }]
  },
  testMatch: [
    '**/worker/**/*.test.ts',
    '**/gemini-agent/mcp/tools/**/*.test.ts',
    '**/packages/**/*.test.ts'
  ],
  collectCoverageFrom: [
    'worker/**/*.ts',
    'gemini-agent/mcp/tools/**/*.ts',
    'packages/**/*.ts',
    '!**/*.test.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/dist/**'
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  coverageDirectory: 'coverage',
  verbose: true,
  testTimeout: 30000,
  globals: {
    'ts-jest': {
      useESM: true
    }
  }
};
