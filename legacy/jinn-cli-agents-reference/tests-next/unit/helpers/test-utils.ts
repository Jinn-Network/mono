/**
 * Shared Test Utilities
 * 
 * Common helpers for unit tests, including env var snapshots and git command mocks.
 */

/**
 * Snapshot current environment variables
 */
export function snapshotEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/**
 * Restore environment variables from snapshot
 */
export function restoreEnv(snapshot: Record<string, string | undefined>): void {
  // Clear all current env vars
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  // Restore snapshot
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Set environment variables for testing
 */
export function setTestEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Clear specific environment variables
 */
export function clearEnvVars(...keys: string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

/**
 * Mock git command responses
 */
export interface GitCommandMock {
  command: string | RegExp;
  response: string;
  error?: boolean;
}

/**
 * Create a git command mock handler
 */
export function createGitMock(mocks: GitCommandMock[]): (command: string) => string {
  return (command: string) => {
    for (const mock of mocks) {
      const matches = typeof mock.command === 'string'
        ? command.includes(mock.command)
        : mock.command.test(command);
      
      if (matches) {
        if (mock.error) {
          throw new Error(mock.response);
        }
        return mock.response;
      }
    }
    return '';
  };
}

/**
 * Parse GitHub repository from URL (for testing)
 */
export function parseGitHubRepoFromUrl(url: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  
  return null;
}

/**
 * Strip token from GitHub URL
 */
export function stripTokenFromUrl(url: string): string {
  // Remove token from https://token@github.com/owner/repo.git
  return url.replace(/https:\/\/[^@]+@/, 'https://');
}

