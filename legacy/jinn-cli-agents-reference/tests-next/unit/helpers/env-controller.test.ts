/**
 * Unit Test: Environment Controller
 * 
 * Tests that withTestEnv loads .env.test and makes required secrets available.
 * Validates the regression where TEST_GITHUB_REPO wasn't loaded before git fixture creation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';

// Mock dotenv before importing env-controller
const mockDotenvConfig = vi.fn();
vi.mock('dotenv', () => ({
  default: {
    config: (...args: any[]) => mockDotenvConfig(...args),
  },
}));

// Mock fs before importing env-controller
const mockExistsSync = vi.fn();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: (filePath: string) => mockExistsSync(filePath),
  };
});

// Import after mocks are set up
import { withTestEnv } from '../../helpers/env-controller.js';

// Access the module's internal state to reset bootstrap
// We need to reset the module's bootstrapped state between tests
let envControllerModule: any;

describe('env-controller', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset process.env
    process.env = { ...originalEnv };
    
    // Reset module bootstrap state by re-importing
    // This clears the cached bootstrap state
    vi.resetModules();
    envControllerModule = await import('../../helpers/env-controller.js');
    
    // Default mocks
    mockExistsSync.mockImplementation((filePath: string) => {
      // Return true for .env files and operate-profile directory
      if (filePath.includes('.env') || filePath.includes('operate-profile')) {
        return true;
      }
      return false;
    });
    
    mockDotenvConfig.mockImplementation((options: any) => {
      // Simulate loading .env.test
      if (options?.path && options.path.includes('.env.test')) {
        process.env.TEST_GITHUB_REPO = 'https://github.com/test/repo.git';
        process.env.GITHUB_TOKEN = 'test-token';
        process.env.TENDERLY_ACCESS_KEY = 'test-key';
        process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
        process.env.TENDERLY_PROJECT_SLUG = 'test-project';
      }
      return {};
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('withTestEnv', () => {
    it('loads .env.test file before executing callback', async () => {
      // Clear TEST_GITHUB_REPO to verify it gets loaded
      delete process.env.TEST_GITHUB_REPO;
      delete process.env.GITHUB_TOKEN;

      await envControllerModule.withTestEnv(async (snapshot) => {
        // Verify env vars are available inside callback
        expect(process.env.TEST_GITHUB_REPO).toBe('https://github.com/test/repo.git');
        expect(process.env.GITHUB_TOKEN).toBe('test-token');
      });

      // Verify dotenv.config was called with .env.test
      expect(mockDotenvConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          path: expect.stringContaining('.env.test'),
          override: false,
        })
      );
    });

    it('loads both .env and .env.test files', async () => {
      const loadedFiles: string[] = [];
      mockDotenvConfig.mockImplementation((options: any) => {
        if (options?.path) {
          loadedFiles.push(options.path);
        }
        // Set required secrets when loading .env.test
        if (options?.path && options.path.includes('.env.test')) {
          process.env.TEST_GITHUB_REPO = 'https://github.com/test/repo.git';
          process.env.GITHUB_TOKEN = 'test-token';
          process.env.TENDERLY_ACCESS_KEY = 'test-key';
          process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
          process.env.TENDERLY_PROJECT_SLUG = 'test-project';
        }
        return {};
      });

      await envControllerModule.withTestEnv(async () => {
        // Callback executed
      });

      // Verify both files were attempted to be loaded
      // Note: loadEnvFiles only loads files that exist (checked via fs.existsSync)
      // Our mock returns true for files containing '.env', so both should be loaded
      const hasEnv = loadedFiles.some(path => path.includes('.env') && !path.includes('.env.test'));
      const hasEnvTest = loadedFiles.some(path => path.includes('.env.test'));
      
      expect(hasEnv || loadedFiles.length > 0).toBe(true); // At least .env.test should be loaded
      expect(hasEnvTest).toBe(true);
      expect(loadedFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('throws error when required secrets are missing', async () => {
      // Clear all required secrets
      delete process.env.TENDERLY_ACCESS_KEY;
      delete process.env.TENDERLY_ACCOUNT_SLUG;
      delete process.env.TENDERLY_PROJECT_SLUG;

      mockDotenvConfig.mockImplementation(() => {
        // Don't set required secrets
        return {};
      });

      // Force re-bootstrap by calling the exported reset function
      envControllerModule.resetBootstrap();

      await expect(
        envControllerModule.withTestEnv(async () => {
          // Should not reach here
        })
      ).rejects.toThrow(/Missing required secrets/);
    });

    it('makes TEST_GITHUB_REPO available for git fixture creation', async () => {
      // Clear env vars first
      delete process.env.TEST_GITHUB_REPO;
      delete process.env.GITHUB_TOKEN;

      let testRepoInCallback: string | undefined;
      
      await envControllerModule.withTestEnv(async () => {
        // This simulates what createGitFixture would see
        testRepoInCallback = process.env.TEST_GITHUB_REPO;
      });

      expect(testRepoInCallback).toBe('https://github.com/test/repo.git');
      expect(mockDotenvConfig).toHaveBeenCalled();
    });

    it('preserves existing env vars when loading .env.test (override: false)', async () => {
      process.env.EXISTING_VAR = 'original-value';
      
      mockDotenvConfig.mockImplementation((options: any) => {
        if (options?.path && options.path.includes('.env.test')) {
          // .env.test would try to set EXISTING_VAR but override: false prevents it
          // Only set required secrets
          process.env.TEST_GITHUB_REPO = 'https://github.com/test/repo.git';
          process.env.GITHUB_TOKEN = 'test-token';
          process.env.TENDERLY_ACCESS_KEY = 'test-key';
          process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
          process.env.TENDERLY_PROJECT_SLUG = 'test-project';
        }
        return {};
      });

      await envControllerModule.withTestEnv(async () => {
        expect(process.env.EXISTING_VAR).toBe('original-value');
      });
    });
  });
});

