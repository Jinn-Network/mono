import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { scriptLogger } from '../logging/index.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Isolated environment for middleware testing
 */
export interface IsolatedEnvironment {
  tempDir: string;
  middlewareDir: string;
  cleanup(): Promise<void>;
}

/**
 * Resolve the middleware path - checks env var, Poetry, then fallback
 *
 * For Poetry git dependencies, the middleware is installed in site-packages.
 * We use Python to find the actual package location for copying.
 */
async function resolveMiddlewarePath(): Promise<string> {
  // 1. Explicit env override
  if (process.env.OLAS_MIDDLEWARE_PATH) {
    return process.env.OLAS_MIDDLEWARE_PATH;
  }

  const jinnNodeRoot = path.resolve(__dirname, '..', '..');

  // 2. Find Poetry-installed package location using Python
  try {
    // Use Python to find where the operate package is installed
    const operatePath = execSync(
      'poetry run python -c "import operate; import os; print(os.path.dirname(operate.__file__))"',
      {
        cwd: jinnNodeRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }
    ).trim();

    if (operatePath) {
      // The operate module is in site-packages/operate
      // We need the parent directory for the full middleware
      const middlewarePath = path.dirname(operatePath);
      scriptLogger.info({ operatePath, middlewarePath }, 'Found middleware via Poetry Python');
      return middlewarePath;
    }
  } catch (error) {
    // Poetry not available or package not installed
    scriptLogger.debug({ error }, 'Poetry middleware lookup failed');
  }

  // 3. Fallback to jinn-node root (middleware installed via Poetry)
  const fallbackPath = path.resolve(__dirname, '..', '..');
  scriptLogger.info({ fallbackPath }, 'Using jinn-node root as fallback middleware path');
  return fallbackPath;
}

/**
 * Create an isolated middleware environment for testing
 *
 * STRATEGY:
 * - Create a complete copy of the middleware in /tmp (including Poetry .venv symlink)
 * - Python runs from the copy directory (has imports and venv)
 * - .operate is created in the copy directory (Python's Path.cwd())
 * - After test, delete entire copy
 *
 * This achieves TRUE isolation:
 * 1. Production middleware: NEVER touched
 * 2. Production .operate: NEVER touched
 * 3. Tests can run in parallel: Each gets own copy
 * 4. Safe for CI/CD: No production state pollution
 */
export async function createIsolatedMiddlewareEnvironment(): Promise<IsolatedEnvironment> {
  const sourceMiddleware = await resolveMiddlewarePath();
  const tempMiddleware = path.join('/tmp', `jinn-e2e-middleware-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);

  scriptLogger.info({ sourceMiddleware, tempMiddleware }, 'Creating isolated middleware copy for E2E test');

  // Copy entire middleware (source files + Poetry .venv symlink)
  await copyDirectory(sourceMiddleware, tempMiddleware);

  scriptLogger.info('Middleware copied (including Poetry venv)');
  scriptLogger.info('Tests will create .operate in isolated copy');

  return {
    tempDir: tempMiddleware,
    middlewareDir: tempMiddleware, // Use the copy for everything
    async cleanup() {
      scriptLogger.info('Cleaning up isolated middleware copy');
      try {
        await fs.rm(tempMiddleware, { recursive: true, force: true });
        scriptLogger.info('Cleaned up isolated copy');
      } catch (error) {
        scriptLogger.warn({ error }, 'Failed to cleanup isolated middleware');
      }
    }
  };
}

/**
 * Copy a directory recursively
 *
 * For E2E tests, we need to copy the entire middleware including Poetry venv.
 * The venv is typically a symlink to the actual environment in Poetry's cache.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  const SKIP_DIRS = new Set([
    '.git',
    '.operate',  // Don't copy production .operate
    '__pycache__',
    '.pytest_cache',
    'node_modules',
    // NOTE: We DON'T skip .venv or venv - we need the Poetry environment
  ]);

  await fs.mkdir(dest, { recursive: true });

  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      // Copy symlinks as-is (important for Poetry .venv)
      const linkTarget = await fs.readlink(srcPath);
      await fs.symlink(linkTarget, destPath);
    } else if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
