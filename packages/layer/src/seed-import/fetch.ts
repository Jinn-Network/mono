/**
 * Seed sources (plan Task 6, spec §7).
 *
 * skills.sh (the first registry, per spec D8) exposes no stable public
 * listing API — its entries are GitHub repos. The durable listing surface is
 * therefore a **disclosed input list** of `owner/repo[#path]` entries (which
 * also matches D9's bounded-allowlist posture: nothing imports that was not
 * on a list a human read), resolved against the GitHub API for the licence
 * (`GET /repos/{owner}/{repo}` → `license.spdx_id`) and the SKILL.md
 * content.
 */

import { z } from 'zod';

export interface SeedSkill {
  /** Registry-style id, e.g. `vercel-labs/skills/find-skills`. */
  skill: string;
  /** Canonical source URL (the attribution target). */
  source: string;
  /** SPDX id, or null when the repo declares none. */
  licence: string | null;
  description?: string;
  /** The SKILL.md content (the layer-2 consumable, spec §5). */
  skillMd: string;
}

/**
 * Zod mirror of `SeedSkill` (issue #1771): the wire shape of a skill-shaped
 * seed fixture on disk (e.g. `fixtures/stage1-seeds/distractor-skill-*.json`),
 * used by the fixture-lint test to validate skill-shaped fixtures without a
 * live GitHub source. Not consumed by `createGithubSeedSource` — that source
 * still speaks `SeedSkill` directly.
 */
export const SeedSkillSchema = z.strictObject({
  skill: z.string().min(1),
  source: z.string().min(1),
  licence: z.string().min(1).nullable(),
  description: z.string().min(1).optional(),
  skillMd: z.string().min(1),
});

export interface SeedSource {
  name: string;
  list(): Promise<SeedSkill[]>;
}

/** One line of the disclosed input list: `owner/repo` or `owner/repo#sub/path`. */
export interface SeedListEntry {
  owner: string;
  repo: string;
  /** Path to the skill directory inside the repo (contains SKILL.md). */
  path?: string;
}

export function parseSeedListEntry(line: string): SeedListEntry {
  const [repoPart, path] = line.trim().split('#', 2);
  const segments = (repoPart ?? '').split('/').filter((s) => s.length > 0);
  if (segments.length !== 2) {
    throw new Error(`invalid seed list entry "${line}" — expected owner/repo or owner/repo#path`);
  }
  return {
    owner: segments[0]!,
    repo: segments[1]!,
    ...(path ? { path } : {}),
  };
}

export interface GithubSeedSourceOptions {
  /** The disclosed input list. */
  entries: SeedListEntry[];
  /** GitHub token (raises rate limits; optional for small lists). */
  token?: string;
  fetchImpl?: typeof fetch;
}

const GITHUB_API = 'https://api.github.com';

async function githubJson(
  url: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'jinn-harness-layer-seed-import',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return res.json();
}

/**
 * GitHub-backed seed source over a disclosed entry list. Licence comes from
 * the repo's declared licence; SKILL.md from `{path}/SKILL.md` (repo root
 * when no path is given).
 */
export function createGithubSeedSource(options: GithubSeedSourceOptions): SeedSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: 'github-seed-list',
    async list(): Promise<SeedSkill[]> {
      const skills: SeedSkill[] = [];
      for (const entry of options.entries) {
        const repoUrl = `${GITHUB_API}/repos/${entry.owner}/${entry.repo}`;
        const repo = (await githubJson(repoUrl, options.token, fetchImpl)) as {
          description?: string | null;
          license?: { spdx_id?: string | null } | null;
          html_url?: string;
        };
        const skillMdPath = entry.path ? `${entry.path}/SKILL.md` : 'SKILL.md';
        const content = (await githubJson(
          `${repoUrl}/contents/${skillMdPath}`,
          options.token,
          fetchImpl,
        )) as { content?: string; encoding?: string };
        if (!content.content || content.encoding !== 'base64') {
          throw new Error(`no SKILL.md at ${entry.owner}/${entry.repo}/${skillMdPath}`);
        }
        skills.push({
          skill: [entry.owner, entry.repo, ...(entry.path ? [entry.path] : [])].join('/'),
          source: repo.html_url ?? `https://github.com/${entry.owner}/${entry.repo}`,
          licence: repo.license?.spdx_id ?? null,
          ...(repo.description ? { description: repo.description } : {}),
          skillMd: Buffer.from(content.content, 'base64').toString('utf-8'),
        });
      }
      return skills;
    },
  };
}
