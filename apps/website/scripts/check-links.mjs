#!/usr/bin/env node
// Zero-dependency internal link checker for apps/website.
//
// Run from apps/website: `node scripts/check-links.mjs` (wired as
// `yarn check:links`). Fails the build on a broken internal link or on a
// reference to one of the old document-root paths that moved to a separate
// origin per DR-2026-08-04 (spec.jinn.network).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXTRA_VALID_ROUTES = new Set(['/', '/docs', '/llms.txt', '/llms-full.txt']);

// Old document-root paths, superseded by spec.jinn.network (DR-2026-08-04).
const FORBIDDEN_HOST_STRINGS = [
  'jinn.network/profiles',
  'jinn.network/records',
  'jinn.network/schemas',
  'jinn.network/prompts',
  'jinn.network/task-profiles',
];
const FORBIDDEN_INTERNAL_PREFIXES = ['/profiles', '/records', '/schemas', '/prompts', '/manifest.json'];
const FORBIDDEN_SCAN_DIRS = ['content', 'app', 'components'];

function walk(dir, out = []) {
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function mdxFiles(dir) {
  return walk(dir).filter((f) => f.endsWith('.mdx'));
}

function tsxFiles(dir) {
  return walk(dir).filter((f) => f.endsWith('.tsx'));
}

/** content/docs/**\/*.mdx -> valid docs URL, per the strip/prefix rule. */
function docsUrlFor(mdxPath) {
  const docsRoot = resolve(root, 'content/docs');
  let rel = mdxPath.slice(docsRoot.length); // leading slash, e.g. /build/index.mdx
  rel = rel.replace(/\.mdx$/, '');
  rel = rel.replace(/\/index$/, '');
  if (rel === '') return '/docs';
  return `/docs${rel}`;
}

function stripForCompare(target) {
  let t = target.split('#')[0];
  if (t.length > 1 && t.endsWith('/')) t = t.slice(0, -1);
  return t;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const HREF_RE = /href=(?:"([^"]*)"|\{'([^']*)'\}|\{"([^"]*)"\})/g;

function extractTargets(text) {
  const targets = [];
  for (const re of [MARKDOWN_LINK_RE, HREF_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      const target = match[1] ?? match[2] ?? match[3];
      if (target === undefined) continue;
      targets.push({ target, index: match.index });
    }
  }
  return targets;
}

function isInternal(target) {
  if (!target.startsWith('/')) return false;
  return true;
}

function isIgnored(target) {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:') ||
    target.startsWith('#')
  );
}

function relPath(absPath) {
  return absPath.slice(root.length + 1);
}

function main() {
  const docsRoot = resolve(root, 'content/docs');
  const appRoot = resolve(root, 'app');

  const docFiles = mdxFiles(docsRoot);
  const validDocsUrls = new Set(docFiles.map(docsUrlFor));
  const validRoutes = new Set([...validDocsUrls, ...EXTRA_VALID_ROUTES]);

  const componentFiles = tsxFiles(appRoot);

  const violations = [];
  let linksChecked = 0;

  for (const file of [...docFiles, ...componentFiles]) {
    const text = readFileSync(file, 'utf8');
    for (const { target, index } of extractTargets(text)) {
      if (isIgnored(target)) continue;
      if (!isInternal(target)) continue; // relative targets are ignored per spec
      linksChecked += 1;
      const compareTarget = stripForCompare(target);
      if (!validRoutes.has(compareTarget)) {
        violations.push(
          `${relPath(file)}:${lineOf(text, index)}: broken internal link -> ${target}`,
        );
      }
    }
  }

  // Forbidden-path check: old document-root paths (DR-2026-08-04).
  const forbiddenScanFiles = FORBIDDEN_SCAN_DIRS.flatMap((d) => walk(resolve(root, d)));
  for (const file of forbiddenScanFiles) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // binary or unreadable file — not a link/text source
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const bad of FORBIDDEN_HOST_STRINGS) {
        if (line.includes(bad)) {
          violations.push(`${relPath(file)}:${i + 1}: forbidden old document-root reference -> ${bad}`);
        }
      }
      for (const target of extractTargets(line).map((t) => t.target)) {
        for (const prefix of FORBIDDEN_INTERNAL_PREFIXES) {
          if (target.startsWith(prefix)) {
            violations.push(
              `${relPath(file)}:${i + 1}: forbidden old document-root internal link -> ${target}`,
            );
          }
        }
      }
    });
  }

  if (violations.length > 0) {
    console.error(`check-links: ${violations.length} violation(s):\n`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }

  console.log(
    `check-links: ok — ${docFiles.length} docs pages, ${linksChecked} internal links checked`,
  );
}

main();
