#!/usr/bin/env tsx
/**
 * Seed Hackathon Templates
 * 
 * Seeds the job_templates table with 3 example templates for the hackathon demo.
 * Run after applying migrations/create_job_templates_table.sql
 * 
 * Usage:
 *   yarn tsx scripts/templates/seed-hackathon-templates.ts
 *   yarn tsx scripts/templates/seed-hackathon-templates.ts --dry-run
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Load blueprint files
function loadBlueprint(name: string): any {
  const path = join(process.cwd(), 'blueprints', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// Define hackathon templates
const templates = [
  {
    id: 'ethereum-daily-research',
    name: 'Ethereum Daily Research',
    description: 'Generates a comprehensive daily brief on Ethereum on-chain activity including market metrics, protocol deep dives, and narrative synthesis.',
    tags: ['ethereum', 'research', 'defi', 'daily'],
    enabled_tools_policy: [
      'web_search',
      'web_fetch',
      'create_artifact',
      'search_artifacts',
      'dispatch_new_job',
      'get_details',
    ],
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Target date for research in ISO 8601 format (YYYY-MM-DD)',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        protocols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of protocols to focus on (default: Uniswap, Aave, Lido)',
        },
      },
      required: ['date'],
    },
    output_spec: {
      schema: {
        type: 'object',
        properties: {
          reportMarkdown: { type: 'string', description: 'Full markdown report' },
          executiveSummary: { type: 'string', description: 'TL;DR summary' },
          marketMetrics: {
            type: 'object',
            properties: {
              ethPriceChange: { type: 'string' },
              totalTvl: { type: 'string' },
              avgGas: { type: 'string' },
            },
          },
          protocolsCovered: { type: 'array', items: { type: 'string' } },
        },
        required: ['reportMarkdown', 'executiveSummary'],
      },
      mapping: {
        reportMarkdown: '$.output',
        executiveSummary: '$.structuredSummary',
        artifacts: '$.artifacts',
      },
    },
    x402_price: '1000000000000000', // 0.001 ETH in wei
    safety_tier: 'public',
    status: 'visible',
    blueprint: loadBlueprint('ethereum-protocol-research'),
  },
  {
    id: 'x402-ecosystem-research',
    name: 'x402 Ecosystem Research',
    description: 'Researches and catalogs the x402 agent ecosystem including services, agents, and integrations.',
    tags: ['x402', 'research', 'ecosystem', 'agents'],
    enabled_tools_policy: [
      'web_search',
      'web_fetch',
      'create_artifact',
      'search_artifacts',
      'get_details',
    ],
    input_schema: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          enum: ['services', 'agents', 'integrations', 'all'],
          description: 'Area of ecosystem to focus on',
          default: 'all',
        },
        depth: {
          type: 'string',
          enum: ['overview', 'detailed'],
          description: 'Research depth level',
          default: 'overview',
        },
      },
    },
    output_spec: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          servicesFound: { type: 'number' },
          agentsFound: { type: 'number' },
          catalog: { type: 'array', items: { type: 'object' } },
        },
        required: ['summary'],
      },
      mapping: {
        summary: '$.structuredSummary',
        raw: '$.output',
        artifacts: '$.artifacts',
      },
    },
    x402_price: '500000000000000', // 0.0005 ETH in wei
    safety_tier: 'public',
    status: 'visible',
    blueprint: loadBlueprint('x402-data-service'),
  },
  {
    id: 'prediction-market-analysis',
    name: 'Prediction Market Analysis',
    description: 'Analyzes prediction market opportunities with EV calculations, risk assessment, and trade recommendations.',
    tags: ['prediction-markets', 'trading', 'analysis', 'polymarket'],
    enabled_tools_policy: [
      'web_search',
      'web_fetch',
      'create_artifact',
      'search_artifacts',
      'get_details',
    ],
    input_schema: {
      type: 'object',
      properties: {
        marketCategory: {
          type: 'string',
          description: 'Category of markets to analyze (e.g., "crypto", "politics", "sports")',
        },
        maxPositionSize: {
          type: 'number',
          description: 'Maximum position size as percentage of NAV (default: 10)',
          default: 10,
        },
        minEv: {
          type: 'number',
          description: 'Minimum expected value threshold for recommendations (default: 0.05)',
          default: 0.05,
        },
      },
    },
    output_spec: {
      schema: {
        type: 'object',
        properties: {
          recommendations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                market: { type: 'string' },
                position: { type: 'string' },
                ev: { type: 'number' },
                conviction: { type: 'string' },
                reasoning: { type: 'string' },
              },
            },
          },
          marketOverview: { type: 'string' },
          riskAssessment: { type: 'string' },
        },
        required: ['recommendations', 'marketOverview'],
      },
      mapping: {
        recommendations: '$.output.recommendations',
        marketOverview: '$.structuredSummary',
        artifacts: '$.artifacts',
      },
    },
    x402_price: '2000000000000000', // 0.002 ETH in wei
    safety_tier: 'public',
    status: 'visible',
    blueprint: loadBlueprint('prediction-market-fund'),
  },
  {
    id: 'code-health-venture',
    name: 'Code Health Venture',
    description: 'Continuous code review, dependency management, and security monitoring for any GitHub repository.',
    tags: ['code-review', 'security', 'dependencies', 'github', 'automation'],
    enabled_tools_policy: [
      'get_file_contents',
      'search_code',
      'list_commits',
      'web_fetch',
      'web_search',
      'create_artifact',
      'search_artifacts',
      'get_details',
      'dispatch_new_job',
    ],
    input_schema: {
      type: 'object',
      properties: {
        repoUrl: {
          type: 'string',
          description: 'GitHub repository URL (e.g., https://github.com/owner/repo)',
          pattern: '^https://github\\.com/[\\w-]+/[\\w-]+$',
        },
        branch: {
          type: 'string',
          description: 'Primary branch to monitor (default: main)',
          default: 'main',
        },
        reviewScope: {
          type: 'string',
          enum: ['prs-only', 'dependencies-only', 'full'],
          description: 'What to review: just PRs, just dependencies, or everything',
          default: 'full',
        },
        updateAggressiveness: {
          type: 'string',
          enum: ['conservative', 'moderate', 'aggressive'],
          description: 'How aggressively to propose dependency updates',
          default: 'moderate',
        },
        securityThreshold: {
          type: 'string',
          enum: ['critical-only', 'high', 'medium', 'all'],
          description: 'Minimum severity level to flag (CVSS-based)',
          default: 'high',
        },
      },
      required: ['repoUrl'],
    },
    output_spec: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Executive summary of code health status' },
          healthScore: { type: 'number', description: 'Overall code health score (0-100)' },
          vulnerabilities: { type: 'array', items: { type: 'object' } },
          proposedUpdates: { type: 'array', items: { type: 'object' } },
          prReviews: { type: 'array', items: { type: 'object' } },
        },
        required: ['summary', 'healthScore'],
      },
      mapping: {
        summary: '$.result.summary',
        healthScore: '$.result.healthScore',
        vulnerabilities: '$.result.vulnerabilities',
        proposedUpdates: '$.result.proposedUpdates',
        prReviews: '$.result.prReviews',
        artifacts: '$.artifacts',
      },
    },
    x402_price: '5000000000000000', // 0.005 ETH in wei
    safety_tier: 'public',
    status: 'visible',
    blueprint: loadBlueprint('code-health-venture'),
  },
];

async function seedTemplates(dryRun: boolean) {
  console.log(`Seeding ${templates.length} hackathon templates...`);
  if (dryRun) {
    console.log('[DRY RUN] No changes will be made\n');
  }

  for (const template of templates) {
    const { blueprint, ...templateData } = template;

    console.log(`\n📋 Template: ${template.id}`);
    console.log(`   Name: ${template.name}`);
    console.log(`   Tags: ${template.tags.join(', ')}`);
    console.log(`   Price: ${BigInt(template.x402_price) / BigInt(1e15)} finney`);
    console.log(`   Safety: ${template.safety_tier}`);
    console.log(`   Tools: ${template.enabled_tools_policy.length} allowed`);

    if (dryRun) {
      console.log('   [SKIP] Dry run mode');
      continue;
    }

    // Upsert template
    const { data, error } = await supabase
      .from('job_templates')
      .upsert(templateData, { onConflict: 'id' })
      .select()
      .single();

    if (error) {
      console.error(`   ❌ Error: ${error.message}`);
    } else {
      console.log(`   ✅ Seeded successfully`);
    }
  }

  console.log('\n✨ Done!');
}

// Main
const dryRun = process.argv.includes('--dry-run');
seedTemplates(dryRun).catch(console.error);

