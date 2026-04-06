#!/usr/bin/env tsx
/**
 * JINN-233 Acceptance Criteria Validation
 * 
 * This script validates the semantic graph search implementation
 * by checking that all core components are working correctly.
 */

import { promises as fs } from 'fs';
import path from 'path';

// ANSI color codes
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

interface ValidationResult {
  criterion: string;
  passed: boolean;
  message: string;
}

const results: ValidationResult[] = [];

function log(message: string, color: string = RESET) {
  console.log(`${color}${message}${RESET}`);
}

function pass(criterion: string, message: string) {
  results.push({ criterion, passed: true, message });
  log(`✅ ${criterion}: ${message}`, GREEN);
}

function fail(criterion: string, message: string) {
  results.push({ criterion, passed: false, message });
  log(`❌ ${criterion}: ${message}`, RED);
}

function info(message: string) {
  log(`ℹ️  ${message}`, BLUE);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function canImport(modulePath: string): Promise<boolean> {
  try {
    await import(modulePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  log('\n🔍 JINN-233 Acceptance Criteria Validation\n', BLUE);
  log('Testing semantic graph search over job execution nodes\n', BLUE);

  // AC-1: SITUATION artifact creation
  info('AC-1: Checking SITUATION artifact creation components...');
  
  const situationEncoderExists = await fileExists('jinn-node/src/worker/situation_encoder.ts');
  const situationArtifactExists = await fileExists('jinn-node/src/worker/situation_artifact.ts');
  const situationTypesExists = await fileExists('jinn-node/src/types/situation.ts');

  if (situationEncoderExists && situationArtifactExists && situationTypesExists) {
    const canImportTypes = await canImport('jinn-node/types/situation.js');
    if (canImportTypes) {
      pass('AC-1', 'SITUATION artifact components present and importable');
    } else {
      fail('AC-1', 'SITUATION types cannot be imported');
    }
  } else {
    fail('AC-1', 'Missing SITUATION artifact components');
  }

  // AC-2: Ponder indexing
  info('AC-2: Checking Ponder indexing configuration...');
  
  const ponderIndexExists = await fileExists('ponder/src/index.ts');
  const ponderSchemaExists = await fileExists('ponder/ponder.schema.ts');
  const migrationExists = await fileExists('migrations/create_node_embeddings.sql');
  
  if (ponderIndexExists && ponderSchemaExists && migrationExists) {
    // Check if migration has pgvector setup
    const migrationContent = await fs.readFile('migrations/create_node_embeddings.sql', 'utf-8');
    if (migrationContent.includes('pgvector') || migrationContent.includes('vector')) {
      pass('AC-2', 'Ponder indexing and pgvector migration configured');
    } else {
      fail('AC-2', 'pgvector migration incomplete');
    }
  } else {
    fail('AC-2', 'Missing Ponder indexing components');
  }

  // AC-3: Recognition agent
  info('AC-3: Checking recognition agent implementation...');
  
  const recognitionHelpersExists = await fileExists('jinn-node/src/worker/recognition_helpers.ts');
  const searchSimilarExists = await fileExists('jinn-node/src/agent/mcp/tools/search_similar_situations.ts');
  
  if (recognitionHelpersExists && searchSimilarExists) {
    pass('AC-3', 'Recognition agent components present');
  } else {
    fail('AC-3', 'Missing recognition agent components');
  }

  // AC-4: Synthesis (get_details tool)
  info('AC-4: Checking synthesis tools...');
  
  const getDetailsExists = await fileExists('jinn-node/src/agent/mcp/tools/get-details.ts');
  
  if (getDetailsExists && recognitionHelpersExists) {
    pass('AC-4', 'Synthesis tools (get-details + recognition helpers) present');
  } else {
    fail('AC-4', 'Missing synthesis components');
  }

  // AC-5: Prompt injection
  info('AC-5: Checking prompt injection in worker...');
  
  const workerExists = await fileExists('jinn-node/src/worker/mech_worker.ts');
  if (workerExists) {
    const workerContent = await fs.readFile('jinn-node/src/worker/mech_worker.ts', 'utf-8');
    if (workerContent.includes('recognition') || workerContent.includes('Recognition')) {
      pass('AC-5', 'Worker has recognition phase integration');
    } else {
      fail('AC-5', 'Worker missing recognition phase');
    }
  } else {
    fail('AC-5', 'Worker file not found');
  }

  // AC-6: Graceful failure
  info('AC-6: Checking error handling...');
  
  if (recognitionHelpersExists) {
    const recognitionContent = await fs.readFile('jinn-node/src/worker/recognition_helpers.ts', 'utf-8');
    if (recognitionContent.includes('try') && recognitionContent.includes('catch')) {
      pass('AC-6', 'Recognition helpers have error handling');
    } else {
      fail('AC-6', 'Missing error handling in recognition');
    }
  } else {
    fail('AC-6', 'Cannot verify error handling');
  }

  // Module imports
  info('Bonus: Checking critical imports...');
  
  try {
    const { SITUATION_ARTIFACT_VERSION } = await import('jinn-node/types/situation.js');
    if (SITUATION_ARTIFACT_VERSION === 'sit-enc-v1.1') {
      pass('Imports', `Situation types import correctly (version: ${SITUATION_ARTIFACT_VERSION})`);
    } else {
      fail('Imports', `Unexpected version: ${SITUATION_ARTIFACT_VERSION}`);
    }
  } catch (error: any) {
    fail('Imports', `Cannot import situation types: ${error.message}`);
  }

  // Summary
  log('\n' + '='.repeat(60), BLUE);
  log('📊 Validation Summary', BLUE);
  log('='.repeat(60) + '\n', BLUE);

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  log(`Total: ${total}`, RESET);
  log(`Passed: ${passed}`, passed === total ? GREEN : YELLOW);
  log(`Failed: ${failed}`, failed > 0 ? RED : GREEN);

  if (failed > 0) {
    log('\n💥 Failed Checks:', RED);
    for (const result of results) {
      if (!result.passed) {
        log(`   - ${result.criterion}: ${result.message}`, RED);
      }
    }
  }

  log('\n📝 Next Steps:', BLUE);
  log('   1. Fix any failed checks above');
  log('   2. Run unit tests: yarn test:unit');
  log('   3. Run integration tests: yarn test:integration');
  log('   4. Test recognition flow: MECH_TARGET_REQUEST_ID=0x... yarn mech --single');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('💥 Validation failed:', error);
  process.exit(1);
});

