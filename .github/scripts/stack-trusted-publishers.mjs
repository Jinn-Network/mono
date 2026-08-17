#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadPlatformCatalog, loadPublishableCatalogPackages, stackPublishedReleaseGroupIds } from './platform-catalog.mjs';

export const PUBLISHER_WORKFLOW = 'stack-npm-publish.yml';

export function buildRegistrationList(repoRoot) {
  const catalog = loadPlatformCatalog(repoRoot);
  const groups = stackPublishedReleaseGroupIds(catalog);
  if (groups.length === 0) {
    throw new Error('no stack-published release group is eligible for canary publication');
  }
  const packages = groups.flatMap((releaseGroup) => loadPublishableCatalogPackages(repoRoot, {
    releaseGroup,
    lane: 'canary',
  }));
  const names = packages.map((pkg) => pkg.name).sort();
  if (new Set(names).size !== names.length) {
    throw new Error('stack-published groups contain duplicate package names');
  }
  return names.map((name) => ({
    package: name,
    provider: 'GitHub Actions',
    organization: 'Jinn-Network',
    repository: 'mono',
    workflow: PUBLISHER_WORKFLOW,
    environment: 'npm-publish',
    allowedActions: ['npm publish'],
  }));
}

export function renderRegistrationMarkdown(registrations) {
  const rows = registrations.map((r) => `| \`${r.package}\` | \`${r.workflow}\` |`).join('\n');
  return [
    '# npm trusted-publisher registrations for the platform package set',
    '',
    `Generated from the repository. ${registrations.length} packages, one registration each.`,
    '',
    'For every row, in the npmjs package settings, add a trusted publisher with:',
    '',
    '| npmjs field | Value |',
    '| --- | --- |',
    '| Provider | GitHub Actions |',
    '| Organization or user | `Jinn-Network` |',
    '| Repository | `mono` |',
    `| Workflow filename | \`${PUBLISHER_WORKFLOW}\` |`,
    '| Allowed action | `npm publish` |',
    '| Environment | `npm-publish` |',
    '',
    'The npmjs **Environment field MUST equal `npm-publish`** and the **Allowed action MUST be exactly `npm publish`**.',
    'Receipt-gated canary publication is enabled for every stack-published group.',
    '**Stable publication is gated on `stable-publish-gate`, which requires live',
    '`spec.jinn.network` host verification of the same run; no stable job invokes npm.**',
    '',
    '| Package | Workflow filename |',
    '| --- | --- |',
    rows,
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const out = args[args.indexOf('--out') + 1];
    const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    if (!args.includes('--out') || !out) throw new Error('--out <directory> is required');
    mkdirSync(out, { recursive: true });
    const registrations = buildRegistrationList(root);
    writeFileSync(join(out, 'trusted-publishers.json'), `${JSON.stringify(registrations, null, 2)}\n`, 'utf8');
    writeFileSync(join(out, 'trusted-publishers.md'), renderRegistrationMarkdown(registrations), 'utf8');
    console.log(`wrote ${registrations.length} trusted-publisher registrations to ${out}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
