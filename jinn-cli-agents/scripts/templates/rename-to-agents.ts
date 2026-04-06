#!/usr/bin/env tsx
/**
 * Rename templates to sound like agents and remove venture templates
 */
import { getTemplateBySlug, updateTemplate, deleteTemplate } from './crud.js';

const renameMapping: Record<string, string> = {
  'blog-growth-orchestrator': 'Blog Growth Orchestrator',
  'blog-growth-template': 'Blog Growth Agent',
  'code-health-venture': 'Code Health Analyst',
  'commit-summary-telegram': 'Commit Summary Reporter',
  'community-hub-template': 'Community Hub Manager',
  'test-deployment-pipeline': 'Deployment Pipeline Manager',
  'ethereum-protocol-research': 'Ethereum Protocol Researcher',
  'fireflies-commits-template': 'Fireflies Meeting Analyzer',
  'hello-world-deployer': 'Hello World Deployer',
  'local-arcade': 'Local Arcade Manager',
  'marketing-content-venture': 'Marketing Content Creator',
  'measurement-enforcement-partial': 'Measurement Enforcement Agent',
  'prediction-market-fund': 'Prediction Market Analyst',
  'service-replicator': 'Service Replicator',
  'workstream-analysis': 'Workstream Analyzer',
  'x402-data-service': 'X402 Data Service Manager',
  'x402-service-optimizer': 'X402 Service Optimizer',
};

const ventureTemplatesToRemove = [
  'venture-foundry',
  'growth-agency',
];

async function renameAndCleanup() {
  console.log('\n🔄 Renaming templates to agent names and removing venture templates\n');

  let renamed = 0;
  let deleted = 0;
  let errors = 0;

  // Delete venture templates
  console.log('🗑️  Removing venture templates...\n');
  for (const slug of ventureTemplatesToRemove) {
    try {
      const template = await getTemplateBySlug(slug);
      if (template) {
        await deleteTemplate(template.id);
        console.log(`   ❌ Deleted: ${template.name} (${slug})`);
        deleted++;
      } else {
        console.log(`   ⏭️  Not found: ${slug}`);
      }
    } catch (error: any) {
      console.error(`   ❌ Error deleting ${slug}: ${error.message}`);
      errors++;
    }
  }

  // Rename agent templates
  console.log('\n✏️  Renaming agent templates...\n');
  for (const [slug, newName] of Object.entries(renameMapping)) {
    try {
      const template = await getTemplateBySlug(slug);
      if (template) {
        if (template.name !== newName) {
          await updateTemplate({
            id: template.id,
            name: newName,
          });
          console.log(`   ✅ Renamed: ${template.name} → ${newName}`);
          renamed++;
        } else {
          console.log(`   ⏭️  Already correct: ${newName}`);
        }
      } else {
        console.log(`   ⚠️  Not found: ${slug}`);
      }
    } catch (error: any) {
      console.error(`   ❌ Error renaming ${slug}: ${error.message}`);
      errors++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Renamed: ${renamed}`);
  console.log(`   Deleted: ${deleted}`);
  console.log(`   Errors: ${errors}\n`);
}

renameAndCleanup();
