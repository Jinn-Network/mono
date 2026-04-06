import { mkdir, writeFile, rm } from 'fs/promises';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Creates a temporary git repository for testing
 */
export class TestRepo {
  public path: string;
  private cleanup: boolean;

  constructor(path?: string, cleanup = true) {
    this.path = path || join(tmpdir(), `codespec-test-${Date.now()}`);
    this.cleanup = cleanup;
  }

  /**
   * Initializes the test repository with git
   */
  async init() {
    await mkdir(this.path, { recursive: true });

    // Initialize git repo
    this.exec('git init');
    this.exec('git config user.name "Test User"');
    this.exec('git config user.email "test@example.com"');

    // Create initial commit
    await writeFile(join(this.path, 'README.md'), '# Test Repo\n');
    this.exec('git add README.md');
    this.exec('git commit -m "Initial commit"');
  }

  /**
   * Writes a file to the repository
   */
  async writeFile(relativePath: string, content: string) {
    const fullPath = join(this.path, relativePath);
    const dir = join(fullPath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content);
  }

  /**
   * Stages a file
   */
  stage(relativePath: string) {
    this.exec(`git add ${relativePath}`);
  }

  /**
   * Stages all changes
   */
  stageAll() {
    this.exec('git add -A');
  }

  /**
   * Creates a commit
   */
  commit(message: string) {
    this.exec(`git commit -m "${message}"`);
  }

  /**
   * Creates a new branch
   */
  createBranch(name: string) {
    this.exec(`git checkout -b ${name}`);
  }

  /**
   * Checks out a branch
   */
  checkout(branch: string) {
    this.exec(`git checkout ${branch}`);
  }

  /**
   * Gets current branch name
   */
  getCurrentBranch(): string {
    return this.exec('git branch --show-current').trim();
  }

  /**
   * Gets list of staged files
   */
  getStagedFiles(): string[] {
    const output = this.exec('git diff --cached --name-only');
    return output.trim().split('\n').filter(f => f);
  }

  /**
   * Gets git diff for staged changes
   */
  getStagedDiff(): string {
    return this.exec('git diff --cached');
  }

  /**
   * Executes a command in the repository directory
   */
  exec(command: string): string {
    try {
      return execSync(command, {
        cwd: this.path,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      // Include stderr in error message
      const stderr = error.stderr?.toString() || '';
      throw new Error(`Command failed: ${command}\n${stderr}`);
    }
  }

  /**
   * Executes a command and returns exit code
   */
  execWithCode(command: string): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execSync(command, {
        cwd: this.path,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error: any) {
      return {
        code: error.status || 1,
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || '',
      };
    }
  }

  /**
   * Cleans up the test repository
   */
  async destroy() {
    if (this.cleanup) {
      await rm(this.path, { recursive: true, force: true });
    }
  }
}

/**
 * Creates a test repository with CodeSpec infrastructure
 */
export async function createTestRepoWithCodeSpec(): Promise<TestRepo> {
  const repo = new TestRepo();
  await repo.init();

  // Copy CodeSpec scripts and config
  const scriptsContent = `#!/usr/bin/env bash
# Stub review script for testing
echo "File: test.ts"
echo "Line: 1"
echo "Issue: Test violation"
echo "---"
`;

  await repo.writeFile('codespec/scripts/detect-violations.sh', scriptsContent);
  await repo.writeFile('codespec/scripts/review-guardrails.sh', scriptsContent);
  await repo.writeFile('codespec/scripts/review-obj1.sh', scriptsContent);
  await repo.writeFile('codespec/scripts/review-obj2.sh', scriptsContent);
  await repo.writeFile('codespec/scripts/review-obj3.sh', scriptsContent);

  // Make scripts executable
  repo.exec('chmod +x codespec/scripts/*.sh');

  // Create .codespec directory
  await repo.writeFile('.codespec/ledger.jsonl', '');
  await repo.writeFile('.codespec/suppressions.yml', 'suppressions: []\n');
  await repo.writeFile('.codespec/owners.yml', 'paths: {}\nclauses: {}\n');

  repo.stageAll();
  repo.commit('Add CodeSpec infrastructure');

  return repo;
}
