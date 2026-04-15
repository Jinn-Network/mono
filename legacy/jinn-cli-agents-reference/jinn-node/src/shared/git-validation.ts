/**
 * Git input validation utilities.
 *
 * Prevents shell injection through branch names and other git arguments.
 * All git commands should use execFileSync (array form) AND validate inputs.
 */

/**
 * Regex for safe git branch/ref names.
 * Allows: alphanumeric, dots, hyphens, underscores, forward slashes.
 * Must start with an alphanumeric character.
 */
const SAFE_BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/;

/**
 * Validate a git branch name against git ref naming rules.
 * Returns true only if the name is safe for use in git commands.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (!SAFE_BRANCH_REGEX.test(name)) return false;
  if (name.endsWith('.lock')) return false;
  if (name.includes('..')) return false;
  if (name.includes('~')) return false;
  if (name.includes('^')) return false;
  if (name.includes(':')) return false;
  if (name.includes('\\')) return false;
  if (name.includes(' ')) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('//')) return false;
  if (name.endsWith('.')) return false;
  if (name.includes('@{')) return false;
  return true;
}

/**
 * Validate and throw if branch name is unsafe.
 * Use at the entry point of any function that receives an external branch name.
 */
export function assertValidBranchName(name: string): void {
  if (!isValidBranchName(name)) {
    throw new Error(
      `Invalid branch name: '${name.slice(0, 80)}'. ` +
      'Branch names must start with alphanumeric and contain only [a-zA-Z0-9._/-].'
    );
  }
}
