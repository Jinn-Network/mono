/**
 * GitHub API helper for blog provisioning
 * Creates new repos from the jinn-blog template
 */

import { Octokit } from '@octokit/rest';

const TEMPLATE_OWNER = 'Jinn-Network';
const TEMPLATE_REPO = 'jinn-blog';

export interface RepoResult {
    repoUrl: string;
    sshUrl: string;
    htmlUrl: string;
    fullName: string;
}

// Keep old interface name for backward compatibility
export type ForkResult = RepoResult;

/**
 * Create a new repo from the blog template for a new customer
 */
export async function createBlogFromTemplate(
    customerSlug: string,
    options: { dryRun?: boolean } = {}
): Promise<RepoResult> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN environment variable is required');
    }

    const newRepoName = `blog-${customerSlug}`;
    const fullName = `${TEMPLATE_OWNER}/${newRepoName}`;

    if (options.dryRun) {
        console.log(`[DRY RUN] Would create ${fullName} from template ${TEMPLATE_OWNER}/${TEMPLATE_REPO}`);
        return {
            repoUrl: `git@github.com:${fullName}.git`,
            sshUrl: `git@github.com:${fullName}.git`,
            htmlUrl: `https://github.com/${fullName}`,
            fullName,
        };
    }

    const octokit = new Octokit({ auth: token });

    // Check if repo already exists
    try {
        const existing = await octokit.repos.get({
            owner: TEMPLATE_OWNER,
            repo: newRepoName,
        });
        if (existing.data) {
            console.log(`Repository ${fullName} already exists, using existing repo`);
            return {
                repoUrl: existing.data.clone_url,
                sshUrl: existing.data.ssh_url,
                htmlUrl: existing.data.html_url,
                fullName: existing.data.full_name,
            };
        }
    } catch (e: any) {
        if (e.status !== 404) {
            throw e;
        }
        // 404 means repo doesn't exist, proceed with creation
    }

    // Create repo from template
    console.log(`Creating ${fullName} from template ${TEMPLATE_OWNER}/${TEMPLATE_REPO}...`);

    const response = await octokit.repos.createUsingTemplate({
        template_owner: TEMPLATE_OWNER,
        template_repo: TEMPLATE_REPO,
        name: newRepoName,
        owner: TEMPLATE_OWNER,
        description: `Blog for ${customerSlug}`,
        private: false,
        include_all_branches: false,
    });

    console.log(`Repository created: ${response.data.html_url}`);

    return {
        repoUrl: response.data.clone_url,
        sshUrl: response.data.ssh_url,
        htmlUrl: response.data.html_url,
        fullName: response.data.full_name,
    };
}

// Keep old name as alias for backward compatibility
export const forkBlogTemplate = createBlogFromTemplate;
