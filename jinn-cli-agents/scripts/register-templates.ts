#!/usr/bin/env tsx
/**
 * Register blueprint JSON files as templates in Supabase.
 *
 * Usage:
 *   tsx scripts/register-templates.ts blueprints/crypto-token-research.json [...]
 *   tsx scripts/register-templates.ts --all    # Register all 5 x402 templates
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { createTemplate, getTemplateBySlug } from './templates/crud.js';

const X402_TEMPLATES = [
  'blueprints/crypto-token-research.json',
  'blueprints/governance-digest.json',
  'blueprints/competitive-landscape.json',
  'blueprints/code-repo-audit.json',
  'blueprints/content-campaign.json',
];

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function registerBlueprint(filePath: string): Promise<void> {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  const slug = generateSlug(raw.name);

  // Check if already exists
  const existing = await getTemplateBySlug(slug);
  if (existing) {
    console.log(`  SKIP: ${slug} already exists (id: ${existing.id})`);
    return;
  }

  // Extract blueprint (invariants + context)
  const blueprint: Record<string, any> = { invariants: raw.invariants };
  if (raw.context) blueprint.context = raw.context;

  const template = await createTemplate({
    name: raw.name,
    slug,
    description: raw.description || null,
    version: raw.version || '1.0.0',
    blueprint,
    inputSchema: raw.inputSchema || {},
    outputSpec: raw.outputSpec || {},
    enabledTools: raw.enabledTools || [],
    tags: raw.tags || [],
    priceWei: raw.priceWei || null,
    priceUsd: raw.priceUsd || null,
    safetyTier: 'public',
    defaultCyclic: false,
    status: 'published',
  });

  console.log(`  OK: ${slug} → ${template.id}`);
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.includes('--all') ? X402_TEMPLATES : args;

  if (files.length === 0) {
    console.error('Usage: tsx scripts/register-templates.ts --all | <file1.json> [file2.json ...]');
    process.exit(1);
  }

  console.log(`Registering ${files.length} templates...\n`);

  for (const file of files) {
    try {
      await registerBlueprint(file);
    } catch (err: any) {
      console.error(`  FAIL: ${file}: ${err.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
