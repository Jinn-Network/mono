#!/usr/bin/env tsx
/**
 * Seed templates table from existing blueprint files
 * Usage: yarn tsx scripts/templates/seed-from-blueprints.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createTemplate, getTemplateBySlug } from './crud.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const blueprintsDir = path.resolve(__dirname, '../../blueprints');

// Get all blueprint files, excluding obvious test files
const allFiles = fs.readdirSync(blueprintsDir).filter(f => f.endsWith('.json'));

// Exclude test/experimental files
const excludePatterns = [
  'browser-automation-test',
  'fireflies-test',
  'measurement-enforcement-test',
  'nano-banana-test',
  'simple-paid-test',
  'single-question-test',
  'vsr-crud-test',
];

const blueprintsToImport = allFiles.filter(f =>
  !excludePatterns.some(pattern => f.includes(pattern))
);

interface BlueprintFile {
  name: string;
  description?: string;
  version?: string;
  defaultCyclic?: boolean;
  priceUsd?: string;
  priceWei?: string;
  tags?: string[];
  inputSchema?: object;
  outputSpec?: object;
  enabledTools?: string[];
  safetyTier?: 'public' | 'private' | 'restricted';
  invariants: Array<{
    id: string;
    type?: string;
    form?: string;
    condition?: string;
    description?: string;
    assessment?: string;
    examples?: {
      do?: string[];
      dont?: string[];
    };
  }>;
}

async function seedTemplates() {
  console.log('\n🌱 Seeding templates from blueprints\n');

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const filename of blueprintsToImport) {
    const filepath = path.join(blueprintsDir, filename);

    if (!fs.existsSync(filepath)) {
      console.log(`⚠️  Skipping ${filename} (not found)`);
      skipped++;
      continue;
    }

    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      const rawBlueprint = JSON.parse(content);

      // Generate slug from filename
      const slug = path.basename(filename, '.json');

      // Check if template already exists
      const existing = await getTemplateBySlug(slug);
      if (existing) {
        console.log(`⏭️  Skipping ${slug} (already exists)`);
        skipped++;
        continue;
      }

      // Handle two formats:
      // 1. Top-level with name, description, invariants
      // 2. templateMeta wrapper with invariants at root
      let name: string;
      let description: string | null;
      let version: string;
      let inputSchema: object;
      let outputSpec: object;
      let enabledTools: string[];
      let tags: string[];
      let priceWei: string | null;
      let priceUsd: string | null;
      let safetyTier: 'public' | 'private' | 'restricted';
      let defaultCyclic: boolean;
      let invariants: any[];

      if (rawBlueprint.templateMeta) {
        // Format 2: templateMeta wrapper
        const meta = rawBlueprint.templateMeta;
        name = meta.name || slug;
        description = meta.description || null;
        version = meta.version || '0.1.0';
        inputSchema = meta.inputSchema || {};
        outputSpec = rawBlueprint.outputSpec || {};
        enabledTools = rawBlueprint.enabledTools || [];
        tags = meta.tags || [];
        priceWei = meta.priceWei || null;
        priceUsd = meta.priceUsd || null;
        safetyTier = meta.safetyTier || 'public';
        defaultCyclic = meta.defaultCyclic || false;
        invariants = rawBlueprint.invariants || [];
      } else if (rawBlueprint.name) {
        // Format 1: Top-level blueprint
        name = rawBlueprint.name;
        description = rawBlueprint.description || null;
        version = rawBlueprint.version || '0.1.0';
        inputSchema = rawBlueprint.inputSchema || {};
        outputSpec = rawBlueprint.outputSpec || {};
        enabledTools = rawBlueprint.enabledTools || [];
        tags = rawBlueprint.tags || [];
        priceWei = rawBlueprint.priceWei || null;
        priceUsd = rawBlueprint.priceUsd || null;
        safetyTier = rawBlueprint.safetyTier || 'public';
        defaultCyclic = rawBlueprint.defaultCyclic || false;
        invariants = rawBlueprint.invariants || [];
      } else {
        // Format 3: Just invariants (derive name from slug)
        name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        description = null;
        version = '0.1.0';
        inputSchema = {};
        outputSpec = {};
        enabledTools = [];
        tags = [];
        priceWei = null;
        priceUsd = null;
        safetyTier = 'public';
        defaultCyclic = false;
        invariants = rawBlueprint.invariants || [];
      }

      // Create template
      const template = await createTemplate({
        name,
        slug,
        description,
        version,
        blueprint: JSON.stringify({ invariants }),
        inputSchema,
        outputSpec,
        enabledTools,
        tags,
        priceWei,
        priceUsd,
        safetyTier,
        defaultCyclic,
        status: 'published',
      });

      console.log(`✅ Created template: ${template.name} (${template.slug})`);
      created++;
    } catch (error: any) {
      console.error(`❌ Error importing ${filename}: ${error.message}`);
      errors++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Created: ${created}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors: ${errors}`);
  console.log(`   Total: ${created + skipped + errors}\n`);
}

seedTemplates();
