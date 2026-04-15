/**
 * Shared Git URL resolution utility.
 *
 * Handles:
 * - HTTPS-to-SSH conversion (https://github.com/org/repo -> git@github.com:org/repo.git)
 * - Custom SSH host substitution (git@github.com: -> git@ritsukai:)
 */

export interface ResolveGitUrlOptions {
    /** Custom SSH host to replace github.com (e.g., "ritsukai" for multi-account SSH configs) */
    sshHost?: string;
}

/**
 * Resolve a git URL to SSH format with optional host substitution.
 *
 * @param url - Git URL in any format (HTTPS or SSH)
 * @param options - Optional SSH host override
 * @returns SSH-format git URL
 */
export function resolveGitUrl(url: string, options?: ResolveGitUrlOptions): string {
    let sshUrl = url;

    // Convert HTTPS GitHub URL to SSH format
    const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) {
        sshUrl = `git@github.com:${httpsMatch[1]}.git`;
    }

    // Apply custom SSH host substitution
    if (options?.sshHost && sshUrl.includes('git@github.com:')) {
        sshUrl = sshUrl.replace('git@github.com:', `git@${options.sshHost}:`);
    }

    return sshUrl;
}
