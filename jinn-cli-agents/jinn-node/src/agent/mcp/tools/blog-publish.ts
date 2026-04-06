/**
 * Blog Publishing MCP Tools
 *
 * Provides tools for AI agents to create, list, and delete blog posts
 * using the local git workflow. Writes directly to the filesystem,
 * relying on the standard auto-commit and push workflow for git operations.
 *
 * Environment:
 * - CODE_METADATA_REPO_ROOT: Local repo path (set by worker/launcher)
 * - Falls back to JINN_WORKSPACE_DIR + repo name from GITHUB_REPOSITORY
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// Schema Definitions
// ============================================

export const blogCreatePostParams = z.object({
  title: z.string().min(1).describe('The title of the blog post'),
  tags: z.array(z.string()).describe('Array of tags for categorization'),
  summary: z.string().min(1).describe('A brief summary/description of the post'),
  content: z.string().min(1).describe('The markdown content of the post (without frontmatter)'),
  draft: z.boolean().optional().default(false).describe('Whether to mark as draft'),
  authors: z.array(z.string()).optional().default(['default']).describe('Author IDs (default: ["default"])'),
  images: z.array(z.string()).optional().describe('Array of image paths'),
  canonicalUrl: z.string().optional().describe('Canonical URL if republishing'),
  date: z.string().optional().describe('Publication date (YYYY-MM-DD), defaults to today'),
});

export const blogCreatePostSchema = {
  description: `Create and publish a new blog post to the local repository.

Writes an MDX file with proper frontmatter directly to the filesystem.
The post will be included in the next commit when the job completes.
Changes are pushed when the worker's git workflow runs (auto-commit + push).

Returns a URL in the format https://{JINN_JOB_BLOG_DOMAIN}/blog/{slug} if JINN_JOB_BLOG_DOMAIN is set.
Note: The URL will only be live after changes are deployed to production.

USAGE:
- title: Will be used to generate the URL slug
- tags: Use consistent tags like ['ai', 'agents', 'jinn', 'defi']
- content: Pure markdown (no frontmatter needed, it's generated automatically)
- draft: Set to true to publish without making visible

Returns: { success, slug, filePath, url } or { error }`,
  inputSchema: blogCreatePostParams.shape,
};

export const blogListPostsParams = z.object({
  path: z.string().optional().default('data/blog').describe('Path to blog directory'),
  limit: z.number().optional().default(50).describe('Maximum posts to return'),
});

export const blogListPostsSchema = {
  description: `List existing blog posts in the local repository.

Returns file names and basic metadata for posts in the blog directory.
Use this to check what content exists before creating new posts.

Each post includes a URL field (https://{JINN_JOB_BLOG_DOMAIN}/blog/{slug}) if JINN_JOB_BLOG_DOMAIN is set.

Returns: { posts: [{ name, slug, path, size, modified, url }], count }`,
  inputSchema: blogListPostsParams.shape,
};

export const blogDeletePostParams = z.object({
  slug: z.string().min(1).describe('The slug (filename without extension) of the post to delete'),
  path: z.string().optional().default('data/blog').describe('Path to blog directory'),
});

export const blogDeletePostSchema = {
  description: `Delete a blog post from the local repository.

Removes the MDX file from the filesystem.
The deletion will be included in the next commit when the job completes.

Returns: { success, slug } or { error }`,
  inputSchema: blogDeletePostParams.shape,
};

export const blogGetPostParams = z.object({
  slug: z.string().min(1).describe('The slug (filename without extension) of the post'),
  path: z.string().optional().default('data/blog').describe('Path to blog directory'),
});

export const blogGetPostSchema = {
  description: `Get the full content of a blog post.

Returns the raw MDX content including frontmatter.
Useful for reviewing or updating existing posts.

Returns: { slug, content, frontmatter } or { error }`,
  inputSchema: blogGetPostParams.shape,
};

// ============================================
// Helper Functions
// ============================================

/**
 * Get the local repository root path.
 * Uses CODE_METADATA_REPO_ROOT (set by worker/launcher).
 */
function getRepoRoot(): string {
  const repoRoot = process.env.CODE_METADATA_REPO_ROOT;
  
  if (!repoRoot) {
    throw new Error(
      'CODE_METADATA_REPO_ROOT not set. Blog tools require a local repository clone. ' +
      'This is typically set by launch_workstream.ts or the worker.'
    );
  }
  
  if (!fs.existsSync(repoRoot)) {
    throw new Error(`Repository root does not exist: ${repoRoot}`);
  }
  
  return repoRoot;
}

/**
 * Generate a URL-safe slug from a title
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Format a date as YYYY-MM-DD
 */
function formatDate(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

/**
 * Generate MDX frontmatter
 */
function generateFrontmatter(config: {
  title: string;
  date: string;
  tags: string[];
  summary: string;
  draft: boolean;
  authors: string[];
  images?: string[];
  canonicalUrl?: string;
}): string {
  const lines = [
    '---',
    `title: '${config.title.replace(/'/g, "''")}'`,
    `date: '${config.date}'`,
    `tags: [${config.tags.map((t) => `'${t}'`).join(', ')}]`,
    `draft: ${config.draft}`,
    `summary: '${config.summary.replace(/'/g, "''")}'`,
  ];

  if (config.images && config.images.length > 0) {
    lines.push(`images: [${config.images.map((i) => `'${i}'`).join(', ')}]`);
  }

  lines.push(`authors: [${config.authors.map((a) => `'${a}'`).join(', ')}]`);

  if (config.canonicalUrl) {
    lines.push(`canonicalUrl: '${config.canonicalUrl}'`);
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Parse frontmatter from MDX content
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterStr = match[1];
  const body = match[2];

  // Simple YAML-like parsing (handles our specific format)
  const frontmatter: Record<string, any> = {};
  const lines = frontmatterStr.split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Handle quoted strings
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
      frontmatter[key] = value;
    }
    // Handle arrays
    else if (value.startsWith('[') && value.endsWith(']')) {
      const items = value.slice(1, -1).split(',').map((s) => {
        const trimmed = s.trim();
        if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
          return trimmed.slice(1, -1);
        }
        return trimmed;
      });
      frontmatter[key] = items;
    }
    // Handle booleans
    else if (value === 'true' || value === 'false') {
      frontmatter[key] = value === 'true';
    }
    // Handle everything else
    else {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

// ============================================
// Tool Implementations
// ============================================

export async function blogCreatePost(args: unknown) {
  try {
    const parsed = blogCreatePostParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const repoRoot = getRepoRoot();
    const {
      title,
      tags,
      summary,
      content,
      draft = false,
      authors = ['default'],
      images,
      canonicalUrl,
      date = formatDate(),
    } = parsed.data;

    const slug = generateSlug(title);
    const fileName = `${slug}.mdx`;
    const relativePath = `data/blog/${fileName}`;
    const fullPath = path.join(repoRoot, relativePath);

    // Ensure blog directory exists
    const blogDir = path.dirname(fullPath);
    if (!fs.existsSync(blogDir)) {
      fs.mkdirSync(blogDir, { recursive: true });
    }

    // Check if file already exists
    if (fs.existsSync(fullPath)) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'ALREADY_EXISTS', message: `Post already exists: ${fileName}` },
          }),
        }],
      };
    }

    // Generate MDX content
    const frontmatter = generateFrontmatter({
      title,
      date,
      tags,
      summary,
      draft,
      authors,
      images,
      canonicalUrl,
    });
    const mdxContent = `${frontmatter}\n\n${content}\n`;

    // Write file to local filesystem
    fs.writeFileSync(fullPath, mdxContent, 'utf-8');

    // Get blog domain from job payload env for full URL
    const blogDomain = process.env.JINN_JOB_BLOG_DOMAIN;
    const postUrl = blogDomain ? `https://${blogDomain}/blog/${slug}` : null;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            success: true,
            slug,
            filePath: relativePath,
            fullPath,
            url: postUrl,
            note: postUrl
              ? `Post created. URL will be ${postUrl} once changes are deployed.`
              : 'File written to local repo. Will be committed and pushed by the worker git workflow.',
          },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message },
        }),
      }],
    };
  }
}

export async function blogListPosts(args: unknown) {
  try {
    const parsed = blogListPostsParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const repoRoot = getRepoRoot();
    const { path: blogPath, limit } = parsed.data;
    const fullPath = path.join(repoRoot, blogPath);

    if (!fs.existsSync(fullPath)) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: { posts: [], count: 0, note: `Blog directory does not exist: ${blogPath}` },
            meta: { ok: true },
          }),
        }],
      };
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });

    // Get blog domain from job payload env for full URLs
    const blogDomain = process.env.JINN_JOB_BLOG_DOMAIN;

    const posts = entries
      .filter((entry) => entry.isFile() && (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')))
      .slice(0, limit)
      .map((entry) => {
        const filePath = path.join(fullPath, entry.name);
        const stats = fs.statSync(filePath);
        const postSlug = entry.name.replace(/\.(mdx|md)$/, '');
        return {
          name: entry.name,
          slug: postSlug,
          path: `${blogPath}/${entry.name}`,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          url: blogDomain ? `https://${blogDomain}/blog/${postSlug}` : null,
        };
      });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: { posts, count: posts.length },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message },
        }),
      }],
    };
  }
}

export async function blogDeletePost(args: unknown) {
  try {
    const parsed = blogDeletePostParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const repoRoot = getRepoRoot();
    const { slug, path: blogPath } = parsed.data;
    const relativePath = `${blogPath}/${slug}.mdx`;
    const fullPath = path.join(repoRoot, relativePath);

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'NOT_FOUND', message: `Post not found: ${slug}` },
          }),
        }],
      };
    }

    // Delete file
    fs.unlinkSync(fullPath);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            success: true,
            slug,
            filePath: relativePath,
            note: 'File deleted from local repo. Deletion will be committed and pushed by the worker git workflow.',
          },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message },
        }),
      }],
    };
  }
}

export async function blogGetPost(args: unknown) {
  try {
    const parsed = blogGetPostParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const repoRoot = getRepoRoot();
    const { slug, path: blogPath } = parsed.data;
    const relativePath = `${blogPath}/${slug}.mdx`;
    const fullPath = path.join(repoRoot, relativePath);

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'NOT_FOUND', message: `Post not found: ${slug}` },
          }),
        }],
      };
    }

    // Read file
    const content = fs.readFileSync(fullPath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    const stats = fs.statSync(fullPath);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            slug,
            path: relativePath,
            frontmatter,
            body: body.trim(),
            rawContent: content,
            size: stats.size,
            modified: stats.mtime.toISOString(),
          },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message },
        }),
      }],
    };
  }
}
