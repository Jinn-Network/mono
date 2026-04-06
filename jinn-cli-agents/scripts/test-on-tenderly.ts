#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Automated Tenderly Testing Script (JINN-204)
 * 
 * Automates the complete Tenderly testing workflow:
 * 1. Creates Virtual TestNet
 * 2. Updates env.tenderly with VNet credentials
 * 3. Runs service deployment on Tenderly
 * 4. Verifies deployment via logs
 * 
 * Usage:
 *   yarn test:tenderly              # Full integration (staking + mech)
 *   yarn test:tenderly --no-staking # Mech only
 *   yarn test:tenderly --no-mech    # Staking only
 *   yarn test:tenderly --baseline   # Neither (baseline test)
 */

import { spawn } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from 'jinn-node/logging';
import { getOptionalTenderlyAccountSlug, getOptionalTenderlyProjectSlug } from 'jinn-node/agent/mcp/tools/shared/env.js';

const testLogger = logger.child({ component: 'TENDERLY-TEST' });

interface TestConfig {
  noStaking: boolean;
  noMech: boolean;
  baseline: boolean;
}

interface VnetInfo {
  id: string;
  rpcUrl: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): TestConfig {
  const args = process.argv.slice(2);
  return {
    noStaking: args.includes('--no-staking'),
    noMech: args.includes('--no-mech'),
    baseline: args.includes('--baseline')
  };
}

/**
 * Create Tenderly Virtual TestNet
 */
async function createVirtualTestnet(): Promise<VnetInfo> {
  testLogger.info('Creating Tenderly Virtual TestNet...');
  
  return new Promise((resolve, reject) => {
    const child = spawn('yarn', ['tsx', 'scripts/setup-tenderly-vnet.ts'], {
      stdio: ['inherit', 'pipe', 'inherit'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Load env.tenderly for credentials
        DOTENV_CONFIG_PATH: join(process.cwd(), 'env.tenderly')
      }
    });

    let output = '';
    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      process.stdout.write(chunk);
      output += chunk;
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to create VNet (exit code ${code})`));
        return;
      }

      // Parse VNet ID and RPC URL from output
      const vnetIdMatch = output.match(/ID:\s+([a-f0-9-]+)/);
      const rpcUrlMatch = output.match(/RPC:\s+(https:\/\/[^\s]+)/);

      if (!vnetIdMatch || !rpcUrlMatch) {
        reject(new Error('Failed to parse VNet info from output'));
        return;
      }

      resolve({
        id: vnetIdMatch[1],
        rpcUrl: rpcUrlMatch[1]
      });
    });
  });
}

/**
 * Update env.tenderly file with VNet details
 */
function updateEnvFile(vnetInfo: VnetInfo, config: TestConfig): void {
  testLogger.info({ vnetId: vnetInfo.id }, 'Updating env.tenderly file');

  const envPath = join(process.cwd(), 'env.tenderly');
  let envContent: string;

  try {
    envContent = readFileSync(envPath, 'utf-8');
  } catch (error) {
    // If file doesn't exist, read template
    const templatePath = join(process.cwd(), 'env.tenderly.template');
    envContent = readFileSync(templatePath, 'utf-8');
  }

  // Update or add VNet variables
  const updates: Record<string, string> = {
    TENDERLY_ENABLED: 'true',
    TENDERLY_VNET_ID: vnetInfo.id,
    TENDERLY_RPC_URL: vnetInfo.rpcUrl,
    BASE_LEDGER_RPC: vnetInfo.rpcUrl,
    ATTENDED: 'false',
    STAKING_PROGRAM: config.noStaking || config.baseline ? 'no_staking' : 'custom_staking',
    ...((!config.noStaking && !config.baseline) ? { STAKING_CONTRACT_ADDRESS: '0x2585e63df7BD9De8e058884D496658a030b5c6ce' } : {})
  };

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }

  writeFileSync(envPath, envContent);
  testLogger.info('env.tenderly updated successfully');
}

/**
 * Run service setup on Tenderly
 */
async function runServiceSetup(config: TestConfig): Promise<number> {
  testLogger.info({
    staking: !config.noStaking && !config.baseline,
    mech: !config.noMech && !config.baseline
  }, 'Running service setup on Tenderly');

  // Build command arguments
  const args = ['setup:service', '--chain=base'];
  
  if (!config.noMech && !config.baseline) {
    args.push('--with-mech');
  }
  
  if (config.noStaking || config.baseline) {
    args.push('--no-staking');
  }

  testLogger.info({ command: `yarn ${args.join(' ')}` }, 'Executing setup command');

  return new Promise((resolve, reject) => {
    // Load env.tenderly
    const envPath = join(process.cwd(), 'env.tenderly');
    const envContent = readFileSync(envPath, 'utf-8');
    const envVars: Record<string, string> = {};

    for (const line of envContent.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) {
        envVars[match[1]] = match[2];
      }
    }

    const child = spawn('yarn', args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...envVars
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Service setup failed (exit code ${code})`));
      } else {
        resolve(code);
      }
    });
  });
}


/**
 * Clean up Tenderly test services
 * 
 * Identifies Tenderly services by RPC URL (virtual.base.eu.rpc.tenderly.co)
 * and service name prefix (tenderly-test-*).
 * 
 * CRITICAL: Uses RPC URL check to prevent accidental deletion of mainnet services.
 */
function cleanupTenderlyServices(): void {
  try {
    const servicesDir = join(process.cwd(), 'olas-operate-middleware/.operate/services');
    const fs = require('fs');
    const dirs = fs.readdirSync(servicesDir);
    
    let cleaned = 0;
    for (const dir of dirs) {
      const configPath = join(servicesDir, dir, 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const serviceName = config.name || '';
        const rpcUrl = config.chain_configs?.base?.ledger_config?.rpc || '';
        
        // SAFETY: Only remove if BOTH conditions met:
        // 1. Service name starts with 'tenderly-test-' OR has Tenderly RPC URL
        // 2. RPC URL contains 'tenderly.co' (prevents mainnet deletion)
        const isTenderlyService = 
          (serviceName.startsWith('tenderly-test-') || rpcUrl.includes('tenderly.co')) &&
          rpcUrl.includes('tenderly.co');
        
        if (isTenderlyService) {
          const dirPath = join(servicesDir, dir);
          fs.rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
          testLogger.info({ 
            dir, 
            serviceName, 
            rpcUrl,
            tokenId: config.chain_configs?.base?.chain_data?.token 
          }, 'Removed Tenderly test service');
        }
      }
    }
    
    if (cleaned > 0) {
      console.log(`\n🧹 Cleaned up ${cleaned} Tenderly test service(s)`);
    }
  } catch (error) {
    testLogger.warn({ error }, 'Failed to cleanup Tenderly services');
  }
}


/**
 * Main execution
 */
async function main() {
  const config = parseArgs();
  let vnetInfo: VnetInfo | null = null;

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║         Automated Tenderly Testing (JINN-204)             ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Determine test scenario
  let scenario = 'Full Integration (Staking + Mech)';
  if (config.baseline) {
    scenario = 'Baseline (No Staking, No Mech)';
  } else if (config.noStaking && config.noMech) {
    scenario = 'Baseline (No Staking, No Mech)';
  } else if (config.noStaking) {
    scenario = 'Mech Only (No Staking)';
  } else if (config.noMech) {
    scenario = 'Staking Only (No Mech)';
  }

  console.log(`📋 Test Scenario: ${scenario}\n`);

  try {
    // Step 1: Create Virtual TestNet
    console.log('Step 1/4: Creating Tenderly Virtual TestNet...');
    vnetInfo = await createVirtualTestnet();
    console.log(`✅ VNet created: ${vnetInfo.id}\n`);

    // Step 2: Update env.tenderly
    console.log('Step 2/4: Updating env.tenderly file...');
    updateEnvFile(vnetInfo, config);
    console.log('✅ Environment file updated\n');

    // Step 3: Run service setup
    console.log('Step 3/4: Running service setup on Tenderly...');
    await runServiceSetup(config);
    console.log('✅ Service deployed successfully\n');

    // Step 4: Verification note
    if (!config.noStaking && !config.baseline) {
      console.log('Step 4/4: Verifying deployment...');
      console.log('✅ Check logs above for staking confirmation:');
      console.log('   - Look for "Staking service: <ID>"');
      console.log('   - Look for "current_staking_program=\'agents_fun_1\'"');
    }
    
    // Step 5: Cleanup Tenderly test services (local middleware state)
    console.log('\nStep 5/5: Cleaning up Tenderly test services...');
    cleanupTenderlyServices();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                  TEST COMPLETED SUCCESSFULLY               ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('🔍 View transactions in Tenderly Dashboard:');
    const accountSlug = getOptionalTenderlyAccountSlug();
    const projectSlug = getOptionalTenderlyProjectSlug();
    if (accountSlug && projectSlug) {
      console.log(`   https://dashboard.tenderly.co/${accountSlug}/${projectSlug}/virtual-testnets/${vnetInfo.id}`);
    }
    console.log('\n💡 Tip: Tenderly test services are automatically cleaned up after each run');
    console.log('   Only mainnet services are preserved in .operate/services/\n');

  } catch (error) {
    testLogger.error({ error }, 'Tenderly test failed');
    console.error('\n❌ Test failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    // CRITICAL: Always delete the VNet, even on failure
    if (vnetInfo) {
      try {
        console.log(`\n🗑️  Deleting Tenderly Virtual TestNet: ${vnetInfo.id}...`);
        
        // Reload env.tenderly to ensure Tenderly credentials are available
        const envPath = join(process.cwd(), 'env.tenderly');
        const envContent = readFileSync(envPath, 'utf-8');
        for (const line of envContent.split('\n')) {
          const match = line.match(/^([A-Z_]+)=(.*)$/);
          if (match) {
            process.env[match[1]] = match[2];
          }
        }
        
        const { createTenderlyClient } = await import('./lib/tenderly.js');
        const tenderlyClient = createTenderlyClient();
        await tenderlyClient.deleteVnet(vnetInfo.id);
        console.log('✅ VNet deleted successfully');
      } catch (error) {
        testLogger.warn({ error, vnetId: vnetInfo.id }, 'Failed to delete VNet');
        console.warn(`⚠️  Failed to delete VNet ${vnetInfo.id}:`, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

