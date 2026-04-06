import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

export interface GitFixture {
  repoPath: string;
  remoteUrl: string;
  cleanup: () => void;
}

const TEMPLATE_DIR = path.resolve(process.cwd(), 'tests-next/fixtures/git-template');
const TMP_ROOT = path.join(
  os.tmpdir(),
  'jinn-gemini-tests',
  process.pid.toString(),
  'git-fixtures'
);

function assertTemplateRepo(): void {
  if (!fs.existsSync(TEMPLATE_DIR)) {
    throw new Error(`Git template directory missing: ${TEMPLATE_DIR}`);
  }
  if (!fs.existsSync(path.join(TEMPLATE_DIR, '.git'))) {
    throw new Error(`Git template at ${TEMPLATE_DIR} is not a repository. Run 'git init' and add desired fixtures.`);
  }
}

function cleanupJobBranches(remoteUrl: string): void {
  // For real remote repos, we don't clean up branches here
  // They'll be cleaned up via GitHub API or left for manual cleanup
  // This function is kept for backward compatibility but does nothing for remote repos
  if (!remoteUrl || remoteUrl.includes('github.com') || remoteUrl.includes('git@')) {
    return;
  }
  
  // Only cleanup local template repo branches
  try {
    const result = execSync(
      `git -C ${JSON.stringify(TEMPLATE_DIR)} for-each-ref --format='%(refname:short)' 'refs/heads/job/*'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    
    const branches = result.trim().split('\n').filter((b) => b.length > 0);

    for (const branch of branches) {
      try {
        execSync(
          `git -C ${JSON.stringify(TEMPLATE_DIR)} branch -D ${JSON.stringify(branch)}`,
          { stdio: 'ignore' }
        );
      } catch (err: any) {
        // Individual branch deletion failures are non-fatal
      }
    }
  } catch (error: any) {
    if (error.status !== 0 && error.stderr && !error.stderr.includes('no matching refs')) {
      console.warn(`Warning: Failed to cleanup job branches in template repo: ${error.message}`);
    }
  }
}

/**
 * Get the remote URL for the test repository
 * Uses TEST_GITHUB_REPO if available, otherwise falls back to template
 */
function getTestRemoteUrl(): string {
  const testRepo = process.env.TEST_GITHUB_REPO;
  if (testRepo) {
    return testRepo;
  }
  // Fallback to template (for backward compatibility)
  return TEMPLATE_DIR;
}

export function createGitFixture(): GitFixture {
  const remoteUrl = getTestRemoteUrl();
  const useRemoteRepo = remoteUrl !== TEMPLATE_DIR;
  
  if (!useRemoteRepo) {
    // Legacy path: use template repo
  assertTemplateRepo();
    cleanupJobBranches(remoteUrl);
  }
  
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const target = path.join(TMP_ROOT, `fixture-${Date.now()}-${randomUUID()}`);
  
  // Clone from remote or template
  if (useRemoteRepo) {
    // Clone from real GitHub remote
    // Use HTTPS with token if GITHUB_TOKEN is available
    const token = process.env.GITHUB_TOKEN;
    let cloneUrl = remoteUrl;
    
    // Clone with token authentication if using HTTPS
    if (token && cloneUrl.startsWith('https://')) {
      const url = new URL(cloneUrl);
      url.username = 'x-access-token';  // GitHub requires this as username
      url.password = token;              // Token goes in password field
      cloneUrl = url.toString();
    }
    
    execSync(`git clone ${JSON.stringify(cloneUrl)} ${JSON.stringify(target)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],  // Suppress output containing token
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    
    // For HTTPS URLs with token, the remote URL already has the token embedded
    // No need to update remote URL - git already stored it with the token
  } else {
    // Legacy: clone from template
    // Use --no-hardlinks to ensure a proper copy, not hardlinks to template
    execSync(`git clone --no-hardlinks ${JSON.stringify(TEMPLATE_DIR)} ${JSON.stringify(target)}`, { stdio: 'inherit' });
  }

  // Ensure the cloned repo has main branch checked out (critical for dispatch_new_job)
  console.log(`\n[git-fixture] 🔍 Debugging git fixture at: ${target}`);
  
  try {
    // Check what we have immediately after clone
    console.log('[git-fixture] Listing all branches after clone:');
    const allBranches = execSync('git branch -a', {
      cwd: target,
      encoding: 'utf8'
    });
    console.log(allBranches);
    
    console.log('[git-fixture] Current HEAD:');
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: target,
      encoding: 'utf8'
    }).trim();
    console.log(`  Current branch: ${currentBranch}`);
    
    console.log('[git-fixture] Checking if main exists locally:');
    const mainExists = execSync('git rev-parse --verify main 2>/dev/null || echo "no"', {
      cwd: target,
      encoding: 'utf8'
    }).trim();
    console.log(`  Main exists check result: "${mainExists}"`);
    
    if (mainExists === 'no') {
      console.log('[git-fixture] ⚠️  Main branch does not exist locally');
      // Main doesn't exist - create it from HEAD if HEAD exists
      try {
        const headExists = execSync('git rev-parse HEAD 2>/dev/null || echo "no"', {
          cwd: target,
          encoding: 'utf8'
        }).trim();
        console.log(`  HEAD exists check: "${headExists}"`);
        
        if (headExists !== 'no') {
          // Create main from HEAD
          console.log('[git-fixture] Creating main branch from HEAD...');
          execSync('git checkout -b main', { cwd: target, stdio: 'inherit' });
          console.log('[git-fixture] ✅ Created and checked out main branch');
        } else {
          // No commits at all - create initial commit
          console.log('[git-fixture] No commits found, creating main with initial commit...');
          execSync('git checkout -b main', { cwd: target, stdio: 'inherit' });
          execSync('git commit --allow-empty -m "Initial commit"', { cwd: target, stdio: 'inherit' });
          console.log('[git-fixture] ✅ Created main branch with initial commit');
        }
      } catch (createError) {
        console.error(`[git-fixture] ❌ Failed to create main branch in ${target}:`, createError);
      }
    } else {
      // Main exists - just check it out if not already on it
      console.log(`[git-fixture] ✅ Main branch exists (hash: ${mainExists.substring(0, 8)})`);
      
      if (currentBranch !== 'main') {
        console.log(`[git-fixture] Switching from ${currentBranch} to main...`);
        execSync('git checkout main', { cwd: target, stdio: 'inherit' });
        console.log('[git-fixture] ✅ Checked out main branch');
      } else {
        console.log('[git-fixture] ✅ Already on main branch');
      }
    }
    
    // Final verification
    console.log('[git-fixture] Final state verification:');
    const finalBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: target,
      encoding: 'utf8'
    }).trim();
    const finalHash = execSync('git rev-parse HEAD', {
      cwd: target,
      encoding: 'utf8'
    }).trim();
    console.log(`  Current branch: ${finalBranch}`);
    console.log(`  Current commit: ${finalHash.substring(0, 8)}`);
    
    const finalMainCheck = execSync('git rev-parse --verify main 2>/dev/null || echo "no"', {
      cwd: target,
      encoding: 'utf8'
    }).trim();
    console.log(`  Main branch exists: ${finalMainCheck !== 'no' ? '✅ YES' : '❌ NO'}`);
    console.log('[git-fixture] 🏁 Git fixture setup complete\n');
    
  } catch (error) {
    console.error(`[git-fixture] ❌ Error during main branch setup in ${target}:`, error);
  }

  return {
    repoPath: target,
    remoteUrl,
    cleanup: () => {
      fs.rmSync(target, { recursive: true, force: true });
    },
  };
}

export async function withGitFixture<T>(
  fn: (fixture: GitFixture) => Promise<T> | T
): Promise<T> {
  const fixture = createGitFixture();
  const prevRepoRoot = process.env.CODE_METADATA_REPO_ROOT;
  process.env.CODE_METADATA_REPO_ROOT = fixture.repoPath;
  try {
    return await fn(fixture);
  } finally {
    fixture.cleanup();
    if (typeof prevRepoRoot === 'undefined') {
      delete process.env.CODE_METADATA_REPO_ROOT;
    } else {
      process.env.CODE_METADATA_REPO_ROOT = prevRepoRoot;
    }
  }
}
