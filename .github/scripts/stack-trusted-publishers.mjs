#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';

export const PUBLISHER_WORKFLOW = 'stack-npm-publish.yml';

export function buildRegistrationList(repoRoot) {
  return discoverStackPackages(repoRoot).map((pkg) => ({
    package: pkg.name,
    provider: 'GitHub Actions',
    organization: 'Jinn-Network',
    repository: 'mono',
    workflow: PUBLISHER_WORKFLOW,
    environment: '',
  })).sort((left, right) => (left.package < right.package ? -1 : left.package > right.package ? 1 : 0));
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
    '| Optional Environment | **Leave blank** |',
    '',
    'The optional npmjs **Environment field MUST be blank**. npm permits one trusted',
    'publisher configuration per package. Receipt-gated canaries from `npm-publish` are',
    'the only active publication lane. Stable publication remains disabled pending',
    'live `jinn.network` hosting verification; the stable blocker never invokes npm.',
    'Leaving the npmjs field blank matches the active canary lane without pre-binding',
    'a future stable environment or weakening the current hold.',
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
