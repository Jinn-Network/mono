/**
 * GitHub API helper for generic provisioning
 * Creates new repositories for workstreams
 */

import { Octokit } from '@octokit/rest';

// Default owner for provisioned repos (org if provided, otherwise authenticated user)
const DEFAULT_ORG = process.env.GITHUB_ORG || '';

export interface RepoResult {
    repoUrl: string;
    sshUrl: string;
    htmlUrl: string;
    fullName: string;
}

async function getAuthenticatedLogin(octokit: Octokit): Promise<string> {
    const response = await octokit.users.getAuthenticated();
    const login = response.data?.login;
    if (!login) {
        throw new Error('Unable to resolve authenticated GitHub user');
    }
    return login;
}

async function resolveOwner(octokit: Octokit, orgOverride?: string): Promise<{ owner: string; useOrg: boolean }> {
    const org = orgOverride || DEFAULT_ORG || '';
    const login = await getAuthenticatedLogin(octokit);
    const owner = org || login;
    const useOrg = Boolean(org && org !== login);
    return { owner, useOrg };
}

/**
 * Create a new empty repository with a README placeholder
 */
export async function createRepository(
    name: string,
    options: {
        dryRun?: boolean;
        org?: string;
        description?: string;
        private?: boolean;
    } = {}
): Promise<RepoResult> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN environment variable is required');
    }

    const octokit = new Octokit({ auth: token });
    const { owner, useOrg } = await resolveOwner(octokit, options.org);
    const fullName = `${owner}/${name}`;

    if (options.dryRun) {
        console.log(`[DRY RUN] Would create repository: ${fullName}`);
        return {
            repoUrl: `git@github.com:${fullName}.git`,
            sshUrl: `git@github.com:${fullName}.git`,
            htmlUrl: `https://github.com/${fullName}`,
            fullName,
        };
    }

    // Check if repo already exists
    try {
        const existing = await octokit.repos.get({ owner, repo: name });
        if (existing.data) {
            console.log(`[github] Repository ${fullName} already exists, using existing`);
            return {
                repoUrl: existing.data.clone_url,
                sshUrl: existing.data.ssh_url,
                htmlUrl: existing.data.html_url,
                fullName: existing.data.full_name,
            };
        }
    } catch (e: any) {
        if (e.status !== 404) throw e;
        // 404 = doesn't exist, proceed
    }

    console.log(`[github] Creating repository: ${fullName}`);

    const response = useOrg
        ? await octokit.repos.createInOrg({
            org: owner,
            name,
            description: options.description || `Jinn workstream: ${name}`,
            private: options.private ?? false,
            auto_init: true, // Creates with README
        })
        : await octokit.repos.createForAuthenticatedUser({
            name,
            description: options.description || `Jinn workstream: ${name}`,
            private: options.private ?? false,
            auto_init: true, // Creates with README
        });

    console.log(`[github] Repository created: ${response.data.html_url}`);

    return {
        repoUrl: response.data.clone_url,
        sshUrl: response.data.ssh_url,
        htmlUrl: response.data.html_url,
        fullName: response.data.full_name,
    };
}

/**
 * Create a repository from a template
 */
export async function createFromTemplate(
    name: string,
    templateOwner: string,
    templateRepo: string,
    options: {
        dryRun?: boolean;
        org?: string;
        description?: string;
        private?: boolean;
    } = {}
): Promise<RepoResult> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN environment variable is required');
    }

    const octokit = new Octokit({ auth: token });
    const { owner } = await resolveOwner(octokit, options.org);
    const fullName = `${owner}/${name}`;

    if (options.dryRun) {
        console.log(`[DRY RUN] Would create ${fullName} from template ${templateOwner}/${templateRepo}`);
        return {
            repoUrl: `git@github.com:${fullName}.git`,
            sshUrl: `git@github.com:${fullName}.git`,
            htmlUrl: `https://github.com/${fullName}`,
            fullName,
        };
    }

    // Check if repo already exists
    try {
        const existing = await octokit.repos.get({ owner, repo: name });
        if (existing.data) {
            console.log(`[github] Repository ${fullName} already exists, using existing`);
            return {
                repoUrl: existing.data.clone_url,
                sshUrl: existing.data.ssh_url,
                htmlUrl: existing.data.html_url,
                fullName: existing.data.full_name,
            };
        }
    } catch (e: any) {
        if (e.status !== 404) throw e;
    }

    console.log(`[github] Creating ${fullName} from template ${templateOwner}/${templateRepo}`);

    const response = await octokit.repos.createUsingTemplate({
        template_owner: templateOwner,
        template_repo: templateRepo,
        name,
        owner,
        description: options.description || `Jinn workstream: ${name}`,
        private: options.private ?? false,
        include_all_branches: false,
    });

    console.log(`[github] Repository created: ${response.data.html_url}`);

    return {
        repoUrl: response.data.clone_url,
        sshUrl: response.data.ssh_url,
        htmlUrl: response.data.html_url,
        fullName: response.data.full_name,
    };
}
