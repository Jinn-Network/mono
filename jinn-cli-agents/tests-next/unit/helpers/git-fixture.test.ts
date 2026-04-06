/**
 * Unit Test: Git Fixture Remote Selection
 * 
 * Tests that createGitFixture correctly selects remote repository based on TEST_GITHUB_REPO env var.
 * Validates the regression where missing env var caused fallback to template directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { createGitFixture, type GitFixture } from '../../helpers/git-fixture.js';

// Mock execSync to avoid actual git operations
const mockExecSync = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

// Mock fs operations
const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn();
const mockRmSync = vi.fn();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    existsSync: (path: string) => mockExistsSync(path),
    rmSync: (...args: any[]) => mockRmSync(...args),
  };
});

describe('git-fixture', () => {
  const originalTestRepo = process.env.TEST_GITHUB_REPO;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const templateDir = path.resolve(process.cwd(), 'tests-next/fixtures/git-template');

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env vars
    delete process.env.TEST_GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
    
    // Default mocks
    mockMkdirSync.mockImplementation(() => {});
    mockExistsSync.mockImplementation((filePath: string) => {
      // Return true for template directory checks
      if (filePath === templateDir || filePath === path.join(templateDir, '.git')) {
        return true;
      }
      return false;
    });
    mockExecSync.mockImplementation(() => '');
  });

  afterEach(() => {
    // Restore original env vars
    if (originalTestRepo !== undefined) {
      process.env.TEST_GITHUB_REPO = originalTestRepo;
    } else {
      delete process.env.TEST_GITHUB_REPO;
    }
    if (originalGithubToken !== undefined) {
      process.env.GITHUB_TOKEN = originalGithubToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  describe('createGitFixture', () => {
    it('uses TEST_GITHUB_REPO when set and stores it in remoteUrl', () => {
      const testRepo = 'https://github.com/owner/repo.git';
      process.env.TEST_GITHUB_REPO = testRepo;
      process.env.GITHUB_TOKEN = 'test-token';

      mockExecSync.mockImplementation((command: string) => {
        if (typeof command === 'string' && command.includes('git clone')) {
          // Verify clone URL includes token (GitHub format with x-access-token)
          expect(command).toContain('https://x-access-token:test-token@github.com/owner/repo.git');
          return '';
        }
        return '';
      });

      const fixture = createGitFixture();

      // Verify fixture stores the original remoteUrl (without token)
      expect(fixture.remoteUrl).toBe(testRepo);
      expect(fixture.remoteUrl).not.toContain('test-token');
      expect(mockExecSync).toHaveBeenCalled();
    });

    it('falls back to template directory when TEST_GITHUB_REPO is not set', async () => {
      delete process.env.TEST_GITHUB_REPO;

      // If the real template repo is missing or not initialized, skip this check
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const templateReady =
        realFs.existsSync(templateDir) && realFs.existsSync(path.join(templateDir, '.git'));
      if (!templateReady) {
        // Exercise the code path enough to ensure no surprises, but don't assert clone args
        expect(() => createGitFixture()).toThrow();
        return;
      }

      mockExecSync.mockImplementation((command: string) => {
        if (typeof command === 'string' && command.includes('git clone')) {
          // Should clone from template directory
          expect(command).toContain(templateDir);
          return '';
        }
        if (typeof command === 'string' && command.includes('git -C')) {
          // Branch cleanup commands
          return '';
        }
        return '';
      });

      const fixture = createGitFixture();

      expect(fixture.remoteUrl).toBe(templateDir);
      expect(mockExecSync).toHaveBeenCalled();
    });

    it('strips token from remoteUrl property while using it for clone', () => {
      const testRepo = 'https://github.com/owner/repo.git';
      process.env.TEST_GITHUB_REPO = testRepo;
      process.env.GITHUB_TOKEN = 'test-token-123';

      let cloneUrlUsed = '';
      mockExecSync.mockImplementation((command: string) => {
        if (typeof command === 'string' && command.includes('git clone')) {
          // Extract the clone URL from the command
          const match = command.match(/git clone ['"]([^'"]+)['"]/);
          if (match) {
            cloneUrlUsed = match[1];
          }
          return '';
        }
        return '';
      });

      const fixture = createGitFixture();

      // remoteUrl property should be original (without token)
      expect(fixture.remoteUrl).toBe(testRepo);
      expect(fixture.remoteUrl).not.toContain('test-token-123');
      
      // But clone command should use token
      expect(cloneUrlUsed).toContain('test-token-123');
    });

    it('handles HTTPS URL without token', () => {
      const testRepo = 'https://github.com/owner/repo.git';
      process.env.TEST_GITHUB_REPO = testRepo;
      // No GITHUB_TOKEN set

      let cloneUrlUsed = '';
      mockExecSync.mockImplementation((command: string) => {
        if (typeof command === 'string' && command.includes('git clone')) {
          const match = command.match(/git clone ['"]([^'"]+)['"]/);
          if (match) {
            cloneUrlUsed = match[1];
          }
          // Should clone without token in URL
          expect(command).toContain(testRepo);
          expect(command).not.toContain('@github.com');
          return '';
        }
        return '';
      });

      const fixture = createGitFixture();

      expect(fixture.remoteUrl).toBe(testRepo);
      expect(cloneUrlUsed).toBe(testRepo);
      expect(cloneUrlUsed).not.toContain('@');
    });
  });
});
