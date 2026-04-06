/**
 * Repository setup utilities: .gitignore initialization
 * 
 * Ensures repositories have common exclusions to prevent
 * large files (like node_modules) from being committed.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerLogger } from '../../logging/index.js';
import { config } from '../../config/index.js';

/**
 * Default .gitignore content for common exclusions
 */
const DEFAULT_GITIGNORE_ENTRIES = [
    '# Dependencies',
    'node_modules/',
    'vendor/',
    '.venv/',
    'venv/',
    '',
    '# Build outputs',
    'dist/',
    'build/',
    '*.pyc',
    '__pycache__/',
    '',
    '# OS files',
    '.DS_Store',
    'Thumbs.db',
    '',
    '# IDE',
    '.idea/',
    '.vscode/',
    '*.swp',
    '*.swo',
    '',
    '# Logs',
    '*.log',
    'npm-debug.log*',
    '',
    '# Environment',
    '.env',
    '.env.local',
    '.env.*.local',
    '',
    '# Test coverage',
    'coverage/',
    '.nyc_output/',
    '',
    '# Beads - local-only files (SQLite cache, daemon, locks)',
    '.beads/beads.db',
    '.beads/beads.db-*',
    '.beads/bd.sock',
    '.beads/bd.pipe',
    '.beads/.exclusive-lock',
    '.beads/daemon.log',
];

/**
 * Get the default gitignore entries
 */
export function getDefaultGitignoreEntries(): string[] {
    return [...DEFAULT_GITIGNORE_ENTRIES];
}

/**
 * Ensure .gitignore exists with common exclusions.
 * 
 * If no .gitignore exists, creates one with defaults.
 * If one exists, appends missing critical entries (like node_modules).
 * 
 * @param repoPath - Path to the repository root
 * @returns true if .gitignore was created or modified
 */
export function ensureGitignore(repoPath: string): boolean {
    const gitignorePath = join(repoPath, '.gitignore');

    // Critical entries that should always be present
    const criticalEntries = ['node_modules/', '.DS_Store', '.env', '.beads/beads.db'];

    if (!existsSync(gitignorePath)) {
        // Create new .gitignore with defaults
        const content = DEFAULT_GITIGNORE_ENTRIES.join('\n') + '\n';
        try {
            writeFileSync(gitignorePath, content, 'utf-8');
            workerLogger.info(
                { repoPath, gitignorePath },
                'Created .gitignore with default exclusions'
            );
            return true;
        } catch (error) {
            workerLogger.warn(
                { repoPath, error: String(error) },
                'Failed to create .gitignore'
            );
            return false;
        }
    }

    // .gitignore exists - check for critical entries
    let existingContent: string;
    try {
        existingContent = readFileSync(gitignorePath, 'utf-8');
    } catch (error) {
        workerLogger.warn(
            { repoPath, error: String(error) },
            'Failed to read existing .gitignore'
        );
        return false;
    }

    // Find missing critical entries
    const missingEntries = criticalEntries.filter(
        entry => !existingContent.includes(entry)
    );

    if (missingEntries.length === 0) {
        workerLogger.debug(
            { repoPath },
            '.gitignore already has critical exclusions'
        );
        return false;
    }

    // Append missing entries
    const additions = [
        '',
        '# Added by Jinn worker',
        ...missingEntries,
        '',
    ].join('\n');

    try {
        appendFileSync(gitignorePath, additions, 'utf-8');
        workerLogger.info(
            { repoPath, addedEntries: missingEntries },
            'Added missing entries to .gitignore'
        );
        return true;
    } catch (error) {
        workerLogger.warn(
            { repoPath, error: String(error) },
            'Failed to update .gitignore'
        );
        return false;
    }
}

/**
 * Ensure beads is initialized in the repository for issue tracking.
 * 
 * Runs 'bd init' if .beads directory doesn't exist.
 * Beads provides dependency-aware issue tracking for agent workflows.
 * 
 * @param repoPath - Path to the repository root
 * @returns true if beads was initialized, false if already exists or failed
 */
export async function ensureBeadsInit(repoPath: string): Promise<boolean> {
    const beadsDir = join(repoPath, '.beads');

    if (existsSync(beadsDir)) {
        workerLogger.debug(
            { repoPath },
            'Beads already initialized in repository'
        );
        return false;
    }

    try {
        const { execSync } = await import('node:child_process');
        execSync('bd init', {
            cwd: repoPath,
            stdio: 'ignore',
            timeout: 10000 // 10 second timeout
        });
        workerLogger.info(
            { repoPath, beadsDir },
            'Initialized beads in repository'
        );
        return true;
    } catch (error) {
        // bd might not be installed - this is fine, just log and continue
        workerLogger.debug(
            { repoPath, error: String(error) },
            'Failed to initialize beads (bd CLI may not be installed)'
        );
        return false;
    }
}

/**
 * Commit repo setup files (.gitignore, .beads/issues.jsonl) if they have changes.
 * 
 * This MUST be called after ensureGitignore() and ensureBeadsInit() and AFTER
 * the job branch checkout. This ensures:
 * 1. .gitignore is committed to the job branch so Git respects the exclusions
 * 2. .beads/issues.jsonl (the tracked sync file) is committed
 * 3. .beads/beads.db and other local-only files remain untracked
 * 
 * Without this commit, when the agent runs and auto-commits, it may accidentally
 * stage .beads/* files because .gitignore wasn't committed yet.
 * 
 * @param repoPath - Path to the repository root
 * @returns true if a commit was made, false if no changes or error
 */
export async function commitRepoSetup(repoPath: string): Promise<boolean> {
    try {
        const { execSync } = await import('node:child_process');

        // Check if there are staged or unstaged changes to .gitignore or .beads/issues.jsonl
        const gitignorePath = join(repoPath, '.gitignore');
        const beadsJsonlPath = join(repoPath, '.beads', 'issues.jsonl');

        // Stage .gitignore if it exists and has changes
        if (existsSync(gitignorePath)) {
            try {
                execSync('git add .gitignore', { cwd: repoPath, stdio: 'pipe', encoding: 'utf8' });
            } catch {
                // Ignore - file may not have changes
            }
        }

        // Stage .beads/issues.jsonl if beads is enabled and files exist
        if (config.blueprint.enableBeads && existsSync(beadsJsonlPath)) {
            try {
                execSync('git add .beads/issues.jsonl .beads/metadata.json .beads/.local_version', {
                    cwd: repoPath,
                    stdio: 'pipe',
                    encoding: 'utf8'
                });
            } catch {
                // Ignore - files may not exist or have changes
            }
        }

        // Check if there's anything staged
        const status = execSync('git diff --cached --name-only', {
            cwd: repoPath,
            stdio: 'pipe',
            encoding: 'utf8'
        }).trim();

        if (!status) {
            workerLogger.debug({ repoPath }, 'No repo setup changes to commit');
            return false;
        }

        // Commit the setup files to the current (job) branch
        execSync('git commit -m "chore: repo setup (.gitignore, beads)"', {
            cwd: repoPath,
            stdio: 'pipe',
            encoding: 'utf8',
        });

        workerLogger.info(
            { repoPath, files: status.split('\n') },
            'Committed repo setup files (.gitignore, beads config)'
        );

        return true;
    } catch (error) {
        workerLogger.warn(
            { repoPath, error: String(error) },
            'Failed to commit repo setup files (non-fatal)'
        );
        return false;
    }
}

