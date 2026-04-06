import { z } from 'zod';

/**
 * GitHub Tools for Metacog MCP Server
 * Direct integration with GitHub API for repository access
 *
 * GitHub is an operator-level credential: operators provide GITHUB_TOKEN in their .env.
 * Unlike venture credentials (telegram, openai, etc.), GitHub tokens are NOT fetched
 * from the credential bridge.
 */

// Schemas
export const getFileContentsParams = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  path: z.string().describe('File or directory path'),
  ref: z.string().optional().describe('Branch, tag, or commit SHA (default: main)'),
});

export const getFileContentsSchema = {
  description: 'Get contents of a file or directory from GitHub repository. Required parameters: owner (repo owner), repo (repo name), path (file/dir path). Optional: ref (branch/tag/commit, defaults to main)',
  inputSchema: getFileContentsParams.shape,
};

export const searchCodeParams = z.object({
  query: z.string().describe('Search query'),
  owner: z.string().optional().describe('Repository owner to limit search'),
  repo: z.string().optional().describe('Repository name to limit search'),
});

export const searchCodeSchema = {
  description: 'Search code in GitHub repositories',
  inputSchema: searchCodeParams.shape,
};

export const listCommitsParams = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  sha: z.string().optional().describe('SHA or branch to start listing from'),
  since: z.string().optional().describe('ISO 8601 date - only commits after this date (e.g., 2024-01-15T00:00:00Z)'),
  until: z.string().optional().describe('ISO 8601 date - only commits before this date (e.g., 2024-01-22T00:00:00Z)'),
  per_page: z.number().optional().describe('Results per page (max 100)'),
});

export const listCommitsSchema = {
  description: 'List commits in a GitHub repository. Use since/until to filter by date range.',
  inputSchema: listCommitsParams.shape,
};

// Helper to call GitHub API
async function githubApiCall(endpoint: string, token?: string): Promise<any> {
  const authToken = token || process.env.GITHUB_TOKEN;
  if (!authToken) {
    throw new Error('GITHUB_TOKEN not set — add it to your .env');
  }

  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jinn-cli-agents',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json();
}

// Tool implementations
export async function getFileContents(args: unknown) {
  const parsed = getFileContentsParams.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'Invalid parameters', details: parsed.error }),
      }],
    };
  }

  try {
    const { owner, repo, path, ref = 'main' } = parsed.data;
    const endpoint = `/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`;
    const data = await githubApiCall(endpoint);

    // Handle directory response
    if (Array.isArray(data)) {
      const files = data.map((item: any) => ({
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
        sha: item.sha,
      }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ type: 'directory', files, count: files.length }),
        }],
      };
    }

    // Handle file response
    if (data.type === 'file') {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            type: 'file',
            path: data.path,
            content,
            size: data.size,
            sha: data.sha,
          }),
        }],
      };
    }

    throw new Error(`Unexpected response type: ${data.type}`);
  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ 
          error: error instanceof Error ? error.message : String(error) 
        }),
      }],
    };
  }
}

export async function searchCode(args: unknown) {
  const parsed = searchCodeParams.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'Invalid parameters', details: parsed.error }),
      }],
    };
  }

  try {
    const { query, owner, repo } = parsed.data;
    let searchQuery = query;
    if (owner && repo) {
      searchQuery = `${query} repo:${owner}/${repo}`;
    } else if (owner) {
      searchQuery = `${query} user:${owner}`;
    }
    
    const endpoint = `/search/code?q=${encodeURIComponent(searchQuery)}&per_page=10`;
    const data = await githubApiCall(endpoint);

    const results = data.items.map((item: any) => ({
      name: item.name,
      path: item.path,
      repository: item.repository.full_name,
      html_url: item.html_url,
      score: item.score,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          results,
          total_count: data.total_count,
          count: results.length,
        }),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ 
          error: error instanceof Error ? error.message : String(error) 
        }),
      }],
    };
  }
}

export async function listCommits(args: unknown) {
  const parsed = listCommitsParams.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'Invalid parameters', details: parsed.error }),
      }],
    };
  }

  try {
    const { owner, repo, sha, since, until, per_page = 30 } = parsed.data;
    const params = new URLSearchParams();
    if (sha) params.set('sha', sha);
    if (since) params.set('since', since);
    if (until) params.set('until', until);
    params.set('per_page', per_page.toString());

    const endpoint = `/repos/${owner}/${repo}/commits?${params.toString()}`;
    const data = await githubApiCall(endpoint);

    const commits = data.map((commit: any) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.commit.author.name,
      date: commit.commit.author.date,
      html_url: commit.html_url,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          commits,
          count: commits.length,
        }),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ 
          error: error instanceof Error ? error.message : String(error) 
        }),
      }],
    };
  }
}

