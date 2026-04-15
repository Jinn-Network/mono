/**
 * Shared constants for worker modules
 */

export const DEFAULT_BASE_BRANCH = process.env.CODE_METADATA_DEFAULT_BASE_BRANCH || 'main';
export const DEFAULT_REMOTE_NAME = process.env.CODE_METADATA_REMOTE_NAME || 'origin';
export const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';

// Git operation timeouts
export const GIT_CLONE_TIMEOUT_MS = 120000; // 2 minutes
export const GIT_FETCH_TIMEOUT_MS = 60000; // 1 minute
export const GIT_CHECKOUT_TIMEOUT_MS = 30000; // 30 seconds
export const GIT_PUSH_TIMEOUT_MS = 60000; // 1 minute
export const GIT_STATUS_TIMEOUT_MS = 10000; // 10 seconds
export const GIT_COMMIT_TIMEOUT_MS = 10000; // 10 seconds

// Commit message constraints
export const MAX_COMMIT_MESSAGE_LENGTH = 72;

// Auto-repost configuration
export const MIN_TIME_BETWEEN_REPOSTS_MS = 5 * 60 * 1000; // 5 minutes

