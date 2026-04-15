#!/usr/bin/env npx tsx
// @ts-nocheck
/**
 * Generic Provisioning Script
 * 
 * Provisions infrastructure for any workstream:
 * 1. Creates a GitHub repository (empty or from template)
 * 2. Creates a Railway project (per-workstream isolation)
 * 3. Creates a Railway service linked to the repo
 * 4. Optionally dispatches a workstream
 * 
 * Usage:
 *   yarn provision --name="my-venture" --display-name="My Venture"
 *   yarn provision --name="my-blog" --display-name="My Blog" --template=Jinn-Network/jinn-blog
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRepository, createFromTemplate } from 'jinn-node/shared/github.js';
import { createRailwayProject, createRailwayService, setRailwayVariables } from 'jinn-node/shared/railway.js';
import { createUmamiWebsite, findUmamiWebsite } from './lib/umami.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const WORKSTREAMS_FILE = join(PROJECT_ROOT, 'data/workstreams.json');

interface WorkstreamConfig {
    name: string;
    displayName: string;
    repo: string;
    sshUrl: string;
    railwayProjectId: string;
    railwayServiceId: string;
    domain: string;
    template?: string;
    envVars?: Record<string, string>;
    createdAt: string;
}

interface WorkstreamsData {
    [slug: string]: WorkstreamConfig;
}

function loadWorkstreams(): WorkstreamsData {
    if (!existsSync(WORKSTREAMS_FILE)) {
        return {};
    }
    return JSON.parse(readFileSync(WORKSTREAMS_FILE, 'utf-8'));
}

function saveWorkstreams(data: WorkstreamsData): void {
    const dir = dirname(WORKSTREAMS_FILE);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(WORKSTREAMS_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function main() {
    const { values } = parseArgs({
        options: {
            name: { type: 'string', short: 'n' },
            'display-name': { type: 'string', short: 'd' },
            template: { type: 'string', short: 't' },
            env: { type: 'string', multiple: true, short: 'e' },
            feature: { type: 'string', multiple: true, short: 'f' },
            'dry-run': { type: 'boolean', default: false },
            'skip-railway': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h' },
        },
        strict: true,
    });

    if (values.help) {
        console.log(`
Generic Provisioning Script

Usage:
  yarn provision --name=<slug> --display-name=<name> [options]

Options:
  -n, --name           Workstream slug (lowercase, used for repo/project name) [required]
  -d, --display-name   Human-readable name [required]
  -t, --template       GitHub template (owner/repo) to use instead of empty repo
  -e, --env            Environment variables to set (KEY=VALUE, can repeat)
  -f, --feature        Enable optional features: umami
  --skip-railway       Create repo only, skip Railway provisioning
  --dry-run            Preview without creating resources
  -h, --help           Show this help message

Examples:
  # Create empty repo + Railway project
  yarn provision --name="my-venture" --display-name="My Venture"
  
  # Create from blog template
  yarn provision --name="my-blog" --display-name="My Blog" --template=Jinn-Network/jinn-blog
  
  # With environment variables
  yarn provision --name="my-app" --display-name="My App" -e API_KEY=xxx -e DEBUG=true
`);
        process.exit(0);
    }

    const slug = values.name;
    const displayName = values['display-name'];
    const template = values.template;
    const dryRun = values['dry-run'] ?? false;
    const skipRailway = values['skip-railway'] ?? false;

    if (!slug) {
        console.error('Error: --name is required');
        process.exit(1);
    }

    if (!displayName) {
        console.error('Error: --display-name is required');
        process.exit(1);
    }

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
        console.error('Error: --name must be lowercase alphanumeric with hyphens only');
        process.exit(1);
    }

    // Check if workstream already exists
    const workstreams = loadWorkstreams();
    if (workstreams[slug] && !dryRun) {
        console.error(`Error: Workstream "${slug}" already exists`);
        console.error(`  Repo: ${workstreams[slug].repo}`);
        console.error(`  Domain: ${workstreams[slug].domain}`);
        process.exit(1);
    }

    // Parse environment variables
    const envVars: Record<string, string> = {};
    for (const envArg of values.env || []) {
        const [key, ...valueParts] = envArg.split('=');
        if (key && valueParts.length > 0) {
            envVars[key] = valueParts.join('=');
        }
    }

    const stepCount = skipRailway ? 2 : 4;
    let step = 1;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Provisioning: ${displayName}`);
    console.log(`Slug: ${slug}`);
    if (template) console.log(`Template: ${template}`);
    if (dryRun) console.log('Mode: DRY RUN');
    console.log(`${'='.repeat(60)}\n`);

    // Step 1: Create GitHub repository
    console.log(`Step ${step}/${stepCount}: Creating GitHub repository...`);
    let repoResult;
    if (template) {
        const [templateOwner, templateRepo] = template.split('/');
        if (!templateOwner || !templateRepo) {
            console.error('Error: --template must be in format owner/repo');
            process.exit(1);
        }
        repoResult = await createFromTemplate(slug, templateOwner, templateRepo, { dryRun });
    } else {
        repoResult = await createRepository(slug, { dryRun, description: displayName });
    }
    console.log(`  ✓ Repository: ${repoResult.fullName}\n`);
    step++;

    let railwayProjectId = '';
    let railwayServiceId = '';
    let domain = '';
    let environmentId = '';

    if (!skipRailway) {
        // Step 2: Create Railway project
        console.log(`Step ${step}/${stepCount}: Creating Railway project...`);
        const projectName = `jinn-${slug}`;
        const projectResult = await createRailwayProject(projectName, {
            dryRun,
            workspaceId: process.env.RAILWAY_WORKSPACE_ID,
        });
        railwayProjectId = projectResult.projectId;
        console.log(`  ✓ Project ID: ${railwayProjectId}\n`);
        step++;

        // Step 3: Create Railway service
        console.log(`Step ${step}/${stepCount}: Creating Railway service...`);
        const railwayResult = await createRailwayService(
            railwayProjectId,
            slug,
            { repo: repoResult.fullName },
            { dryRun }
        );
        railwayServiceId = railwayResult.serviceId;
        environmentId = railwayResult.environmentId;
        domain = railwayResult.domain;
        console.log(`  ✓ Service ID: ${railwayServiceId}`);
        console.log(`  ✓ Domain: ${domain}\n`);
        step++;

        // Step 4: Set environment variables (if any)
        if (Object.keys(envVars).length > 0) {
            console.log(`Step ${step}/${stepCount}: Setting environment variables...`);
            await setRailwayVariables(
                railwayProjectId,
                railwayServiceId,
                railwayResult.environmentId,
                envVars,
                { dryRun }
            );
            console.log(`  ✓ Environment configured\n`);
        } else {
            console.log(`Step ${step}/${stepCount}: No environment variables to set\n`);
        }
    }

    // --- FEATURE: UMAMI ---
    const features = values.feature || [];
    let umamiWebsiteId = '';

    if (features.includes('umami') && !skipRailway) {
        console.log(`\nFeature: Umami Analytics`);
        console.log(`Setting up Umami website...`);

        let umamiResult = dryRun ? null : await findUmamiWebsite(domain);
        if (umamiResult) {
            console.log(`  (Website already exists, using existing)`);
        } else {
            umamiResult = await createUmamiWebsite(displayName, domain, { dryRun });
        }
        umamiWebsiteId = umamiResult?.websiteId || 'dry-run-id';
        console.log(`  ✓ Website ID: ${umamiWebsiteId}`);

        console.log(`Configuring Umami env vars...`);
        const umamiHost = process.env.UMAMI_HOST || 'umami-production-ae2b.up.railway.app';
        const umamiSrc = umamiHost.startsWith('http')
            ? `${umamiHost}/script.js`
            : `https://${umamiHost}/script.js`;

        await setRailwayVariables(
            railwayProjectId,
            railwayServiceId,
            environmentId,
            {
                NEXT_PUBLIC_UMAMI_ID: umamiWebsiteId,
                NEXT_PUBLIC_UMAMI_SRC: umamiSrc,
            },
            { dryRun }
        );
        console.log(`  ✓ Umami tracking configured`);
    }

    // Save workstream config
    console.log(`Saving workstream configuration...`);
    if (!dryRun) {
        workstreams[slug] = {
            name: slug,
            displayName,
            repo: repoResult.fullName,
            sshUrl: repoResult.sshUrl,
            railwayProjectId,
            railwayServiceId,
            domain,
            template,
            envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
            createdAt: new Date().toISOString(),
        };
        saveWorkstreams(workstreams);
        console.log(`  ✓ Saved to: ${WORKSTREAMS_FILE}\n`);
    } else {
        console.log(`  [DRY RUN] Would save to: ${WORKSTREAMS_FILE}\n`);
    }

    // Summary
    console.log(`${'='.repeat(60)}`);
    console.log('✅ Provisioning Complete!\n');
    console.log(`GitHub Repo:       ${repoResult.htmlUrl}`);
    if (!skipRailway) {
        console.log(`Railway Project:   ${railwayProjectId}`);
        console.log(`Railway Domain:    https://${domain}`);
    }
    console.log(`${'='.repeat(60)}\n`);

    if (dryRun) {
        console.log('This was a dry run. No resources were created.\n');
    }
}

main().catch((error) => {
    console.error('\n❌ Provisioning failed:', error.message);
    process.exit(1);
});
