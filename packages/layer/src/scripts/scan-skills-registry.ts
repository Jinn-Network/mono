/**
 * Full skills.sh registry scan (issue #1313 follow-up).
 *
 * The registry publishes its complete catalogue via sitemaps
 * (sitemap-skills-*.xml — ~20k skill pages across ~2.5k source repos).
 * This script enumerates it, licence-checks every SOURCE repo against the
 * seed importer's disclosed allowlist, resolves each skill's SKILL.md path
 * from the repo's git tree, and emits:
 *
 *   - candidates.txt   — seed-list lines (owner/repo#path) for every skill
 *                        whose repo licence passes the import gate
 *   - scan-report.json — full per-repo results (licence, verdict, skills)
 *   - a terminal summary (counts by licence / verdict)
 *
 * Read-only against GitHub (REST, token from GITHUB_TOKEN or `gh auth
 * token`). Checkpointed: repo results append to the report file as they
 * land, and a rerun skips repos already scanned — safe to interrupt.
 * Publishes nothing; the output is INPUT to `seed plan`, and the human
 * approval gate on `seed execute` is unchanged.
 *
 * Run: cd packages/layer && yarn build && GITHUB_TOKEN=$(gh auth token) \
 *   node dist/scripts/scan-skills-registry.js [--out <dir>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkLicence } from '../seed-import/licence.js';

const SITEMAP_INDEX = 'https://www.skills.sh/sitemap.xml';
const GITHUB_API = 'https://api.github.com';
const CONCURRENCY = 8;

interface RepoScan {
  repo: string; // owner/name
  licence: string | null;
  verdict: 'import' | 'skip';
  reason: string;
  /** skill name (registry slug) → repo path of the dir containing SKILL.md */
  resolved: Record<string, string>;
  /** registry slugs with no SKILL.md match in the repo tree */
  unresolved: string[];
  error?: string;
}

function token(): string {
  const env = (process.env['GITHUB_TOKEN'] || '').trim();
  if (env) return env;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('set GITHUB_TOKEN or log in with gh');
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

async function github(path: string, tok: string): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'jinn-harness-layer-registry-scan',
      authorization: `Bearer ${tok}`,
    },
  });
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
    const waitMs = Math.max(5_000, reset - Date.now() + 1_000);
    console.warn(`[scan] rate limited — waiting ${Math.ceil(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, waitMs));
    return github(path, tok);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

async function enumerateRegistry(): Promise<Map<string, Set<string>>> {
  const index = await fetchText(SITEMAP_INDEX);
  const sitemaps = [...index.matchAll(/<loc>([^<]+sitemap-skills-[^<]+)<\/loc>/g)].map((m) => m[1]!);
  const byRepo = new Map<string, Set<string>>();
  for (const sm of sitemaps) {
    const body = await fetchText(sm);
    for (const m of body.matchAll(/<loc>https?:\/\/(?:www\.)?skills\.sh\/([^/<]+)\/([^/<]+)\/([^/<]+)<\/loc>/g)) {
      const [, owner, repo, skill] = m;
      // Registry lists some non-GitHub sources (e.g. open.feishu.cn slugs) —
      // owner/repo that are not valid GitHub names get filtered by the 404 path.
      const key = `${owner}/${repo}`;
      (byRepo.get(key) ?? byRepo.set(key, new Set()).get(key)!).add(decodeURIComponent(skill!));
    }
  }
  return byRepo;
}

async function scanRepo(repo: string, skills: Set<string>, tok: string): Promise<RepoScan> {
  const meta = (await github(`/repos/${repo}`, tok)) as
    | { license?: { spdx_id?: string | null } | null; default_branch?: string }
    | null;
  if (meta === null) {
    return { repo, licence: null, verdict: 'skip', reason: 'not found on GitHub', resolved: {}, unresolved: [...skills] };
  }
  const spdx = meta.license?.spdx_id && meta.license.spdx_id !== 'NOASSERTION' ? meta.license.spdx_id : null;
  const { verdict, reason } = checkLicence(spdx);
  const scan: RepoScan = { repo, licence: spdx, verdict, reason, resolved: {}, unresolved: [] };
  if (verdict !== 'import') {
    scan.unresolved = [...skills];
    return scan;
  }

  // One tree call resolves every skill's SKILL.md directory.
  const tree = (await github(
    `/repos/${repo}/git/trees/${meta.default_branch ?? 'HEAD'}?recursive=1`,
    tok,
  )) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean } | null;
  const dirs = new Map<string, string>(); // dir basename → dir path (first wins, shallowest first)
  const entries = (tree?.tree ?? [])
    .filter((e) => e.type === 'blob' && e.path.endsWith('/SKILL.md'))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const e of entries) {
    const dir = e.path.slice(0, -'/SKILL.md'.length);
    const base = dir.split('/').pop()!;
    if (!dirs.has(base)) dirs.set(base, dir);
  }
  // Root SKILL.md: usable when the registry slug equals the repo name.
  const hasRootSkillMd = (tree?.tree ?? []).some((e) => e.type === 'blob' && e.path === 'SKILL.md');
  for (const skill of skills) {
    const dir = dirs.get(skill);
    if (dir !== undefined) scan.resolved[skill] = dir;
    else if (hasRootSkillMd && skill === repo.split('/')[1]) scan.resolved[skill] = '';
    else scan.unresolved.push(skill);
  }
  if (tree?.truncated) scan.error = 'git tree truncated — unresolved list may overcount';
  return scan;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: 'string', default: 'registry-scan' } },
  });
  const outDir = values.out as string;
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, 'scan-report.json');
  const candidatesPath = join(outDir, 'candidates.txt');

  const tok = token();
  console.log('[scan] enumerating registry sitemaps…');
  const byRepo = await enumerateRegistry();
  const totalSkills = [...byRepo.values()].reduce((n, s) => n + s.size, 0);
  console.log(`[scan] ${totalSkills} skills across ${byRepo.size} repos`);

  // Resume support: skip repos already in the report.
  const done = new Map<string, RepoScan>();
  if (existsSync(reportPath)) {
    for (const row of JSON.parse(readFileSync(reportPath, 'utf-8')) as RepoScan[]) done.set(row.repo, row);
    console.log(`[scan] resuming — ${done.size} repos already scanned`);
  }

  const queue = [...byRepo.entries()].filter(([repo]) => !done.has(repo));
  const results: RepoScan[] = [...done.values()];
  let inFlight = 0;
  let cursor = 0;
  let scanned = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      if (cursor >= queue.length && inFlight === 0) return resolve();
      while (inFlight < CONCURRENCY && cursor < queue.length) {
        const [repo, skills] = queue[cursor]!;
        cursor += 1;
        inFlight += 1;
        scanRepo(repo, skills, tok)
          .catch((err): RepoScan => ({
            repo,
            licence: null,
            verdict: 'skip',
            reason: `scan error: ${err instanceof Error ? err.message : String(err)}`,
            resolved: {},
            unresolved: [...skills],
            error: String(err),
          }))
          .then((scan) => {
            results.push(scan);
            scanned += 1;
            if (scanned % 100 === 0) {
              console.log(`[scan] ${scanned}/${queue.length} repos`);
              writeFileSync(reportPath, JSON.stringify(results, null, 1));
            }
            inFlight -= 1;
            pump();
          });
      }
    };
    pump();
  });

  writeFileSync(reportPath, JSON.stringify(results, null, 1));

  const lines: string[] = [];
  for (const scan of results.sort((a, b) => a.repo.localeCompare(b.repo))) {
    for (const [skill, dir] of Object.entries(scan.resolved).sort()) {
      lines.push(dir === '' ? scan.repo : `${scan.repo}#${dir}`);
      void skill;
    }
  }
  writeFileSync(candidatesPath, [...new Set(lines)].join('\n') + '\n');

  const importRepos = results.filter((r) => r.verdict === 'import');
  const licences: Record<string, number> = {};
  for (const r of importRepos) licences[r.licence ?? '?'] = (licences[r.licence ?? '?'] ?? 0) + 1;
  const resolvedCount = importRepos.reduce((n, r) => n + Object.keys(r.resolved).length, 0);
  const unresolvedLicensed = importRepos.reduce((n, r) => n + r.unresolved.length, 0);
  console.log('[scan] done');
  console.log(`  repos: ${results.length} scanned · ${importRepos.length} licence-pass`);
  console.log(`  licences (passing): ${JSON.stringify(licences)}`);
  console.log(`  skills: ${resolvedCount} resolved SKILL.md paths → ${candidatesPath}`);
  console.log(`  ${unresolvedLicensed} skills in licensed repos had no resolvable SKILL.md path`);
  console.log(`  full report: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
