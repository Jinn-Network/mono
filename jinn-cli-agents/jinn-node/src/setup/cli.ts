#!/usr/bin/env node
/**
 * Non-Interactive Service Setup CLI - JINN-202 Simplified Version
 *
 * User-friendly command-line wizard for setting up an OLAS service.
 * Uses middleware daemon + HTTP API (no interactive CLI prompts).
 *
 * Usage:
 *   npx jinn-setup                         # Mainnet deployment (uses .env)
 *   npx jinn-setup --testnet               # Testnet deployment (uses .env.test)
 *   npx jinn-setup --chain=base            # Specify chain
 *   npx jinn-setup --no-mech               # Deploy without mech contract
 *   npx jinn-setup --isolated              # Run in isolated temp directory
 */

import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { SimplifiedServiceBootstrap, type SimplifiedBootstrapConfig } from '../worker/SimplifiedServiceBootstrap.js';
import { stolasBootstrap, stolasPreflightCheck } from '../worker/stolas/StolasServiceBootstrap.js';
import { logger } from '../logging/index.js';
import { getMechChainConfig } from '../env/operate-profile.js';
import { createIsolatedMiddlewareEnvironment, type IsolatedEnvironment } from './test-isolation.js';
import { runPreflight } from './preflight.js';
import { printHeader, printStep, printSuccess, printError, printStolasIntro, printStolasSuccess } from './display.js';
import { syncCredentials } from '../auth/index.js';
import { hasAuthManagerCredentials, syncAndWriteGeminiCredentials } from '../worker/llm/authIntegration.js';
import { DEFAULT_MECH_DELIVERY_RATE } from '../worker/config/MechConfig.js';
import { SERVICE_CONSTANTS } from '../worker/config/ServiceConfig.js';
import { config, secrets } from '../config/index.js';

const setupLogger = logger.child({ component: "SETUP-CLI" });

type LlmAuthStatus = {
  hasGeminiOauthEnv: boolean;
  hasGeminiCli: boolean;
  hasAuthStore: boolean;
  hasGeminiApiKey: boolean;
  hasOpenAiKey: boolean;
};

function getLlmAuthStatus(): LlmAuthStatus {
  const hasGeminiOauthEnv = Boolean(process.env.GEMINI_OAUTH_CREDENTIALS);
  const hasGeminiCli = existsSync(join(homedir(), '.gemini', 'oauth_creds.json'));
  const hasAuthStore = hasAuthManagerCredentials();
  const hasGeminiApiKey = Boolean(secrets.geminiApiKey);
  const hasOpenAiKey = Boolean(secrets.openaiApiKey);

  return {
    hasGeminiOauthEnv,
    hasGeminiCli,
    hasAuthStore,
    hasGeminiApiKey,
    hasOpenAiKey,
  };
}

function logLlmAuthStatus(status: LlmAuthStatus): void {
  if (status.hasGeminiOauthEnv) {
    console.log('  ✓ Found Gemini OAuth credentials in env');
  }
  if (status.hasGeminiCli) {
    console.log('  ✓ Found Gemini CLI credentials in ~/.gemini');
  }
  if (status.hasAuthStore) {
    console.log('  ✓ Found Gemini credentials in AuthManager store');
  }
  if (status.hasGeminiApiKey) {
    console.log('  ✓ Found GEMINI_API_KEY');
  }
  if (status.hasOpenAiKey) {
    console.log('  ✓ Found OPENAI_API_KEY');
  }
}

async function ensureLlmAuth(): Promise<void> {
  try {
    const syncResult = syncCredentials();
    if (syncResult.sources.length > 0) {
      setupLogger.info({ sources: syncResult.sources }, 'Synced auth sources');
    }
    if (syncResult.errors?.length) {
      setupLogger.debug({ errors: syncResult.errors }, 'Auth sync errors');
    }
  } catch (error) {
    setupLogger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Auth sync failed'
    );
  }

  let status = getLlmAuthStatus();
  const hasGeminiAuth =
    status.hasGeminiOauthEnv || status.hasGeminiCli || status.hasAuthStore;
  const hasGeminiApiKey = status.hasGeminiApiKey;

  if (status.hasAuthStore && !status.hasGeminiCli) {
    const wroteCreds = syncAndWriteGeminiCredentials();
    if (wroteCreds) {
      status = getLlmAuthStatus();
    }
  }

  if (!hasGeminiAuth && !hasGeminiApiKey) {
    console.log('\n  LLM authentication required');
    console.log('  No Gemini credentials were found.');
    console.log(`  Checked: ${join(homedir(), '.gemini', 'oauth_creds.json')}`);
    console.log('  Options:');
    console.log('   1) Run: npx @google/gemini-cli auth login');
    console.log('   2) Provide GEMINI_OAUTH_CREDENTIALS JSON (array)');
    console.log('   3) Provide GEMINI_API_KEY (API-key auth)');
    printError('Missing required LLM authentication. Set it in .env before rerunning.');
    process.exit(1);
  }

  status = getLlmAuthStatus();
  const hasGeminiAuthAfter =
    status.hasGeminiOauthEnv || status.hasGeminiCli || status.hasAuthStore;
  const hasGeminiApiKeyAfter = status.hasGeminiApiKey;
  if (!hasGeminiAuthAfter && !hasGeminiApiKeyAfter) {
    printError('Gemini credentials not configured. Authentication is required to run the worker.');
    console.error('  Fix: run `npx @google/gemini-cli auth login`, set GEMINI_OAUTH_CREDENTIALS, or set GEMINI_API_KEY.');
    process.exit(1);
  }

  logLlmAuthStatus(status);
  if (!hasGeminiAuthAfter && hasGeminiApiKeyAfter) {
    console.log('  Note: Using GEMINI_API_KEY (supported). OAuth is recommended for best compatibility.');
  }
}

/**
 * Ensure .env file exists and has required values
 * Returns true if we should reload env vars
 */
async function ensureEnvFile(isTestnet: boolean): Promise<boolean> {
  const envFile = isTestnet ? '.env.test' : '.env';
  const envExample = isTestnet ? '.env.test.example' : '.env.example';
  const envPath = resolve(process.cwd(), envFile);
  const examplePath = resolve(process.cwd(), envExample);

  let needsReload = false;

  // Copy from example if .env doesn't exist
  if (!existsSync(envPath) && existsSync(examplePath)) {
    console.log(`  Creating ${envFile} from template...`);
    copyFileSync(examplePath, envPath);
    needsReload = true;
  }

  // Reload env vars
  if (needsReload) {
    dotenvConfig({ path: envPath, override: true });
  }
  await ensureLlmAuth();

  return needsReload;
}

// Parse args early to determine environment
const earlyArgs = process.argv.slice(2);
const isTestnet = earlyArgs.includes('--testnet');

// Load appropriate env file based on --testnet flag
if (isTestnet) {
  const testEnvPath = resolve(process.cwd(), '.env.test');
  if (existsSync(testEnvPath)) {
    dotenvConfig({ path: testEnvPath, override: true });
    setupLogger.info('Loaded .env.test for testnet deployment');
  } else {
    console.error('\n Error: .env.test not found');
    console.error('Create .env.test with testnet/Tenderly VNet configuration\n');
    process.exit(1);
  }
}
// Otherwise, .env is already loaded by 'dotenv/config' at line 14

interface CLIArgs {
  chain?: 'base' | 'gnosis' | 'mode' | 'optimism';
  testnet?: boolean;
  noMech?: boolean;
  noStaking?: boolean;
  stolas?: boolean;
  stakingContract?: string;
  help?: boolean;
  unattended?: boolean;
  isolated?: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {};

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--chain=')) {
      args.chain = arg.split('=')[1] as any;
    } else if (arg === '--testnet') {
      args.testnet = true;
    } else if (arg === '--no-mech') {
      args.noMech = true;
    } else if (arg === '--no-staking') {
      args.noStaking = true;
    } else if (arg === '--stolas') {
      args.stolas = true;
    } else if (arg.startsWith('--staking-contract=')) {
      args.stakingContract = arg.split('=')[1];
    } else if (arg === '--unattended') {
      args.unattended = true;
    } else if (arg === '--isolated') {
      args.isolated = true;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
+-----------------------------------------------------------------------------+
|             OLAS Service Setup Wizard (jinn-node)                           |
+-----------------------------------------------------------------------------+

This wizard uses the middleware daemon + HTTP API to guide you through
setting up an OLAS service with non-interactive funding checks.

USAGE:
  npx jinn-setup [OPTIONS]

OPTIONS:
  --testnet           Use .env.test for testnet/Tenderly VNet deployment
                      Default: use .env for mainnet deployment

  --chain=NETWORK     Network to deploy on (base, gnosis, mode, optimism)
                      Default: base

  --no-mech           Disable mech deployment (mech enabled by default)
  --no-staking        Disable staking (staking enabled by default)
  --stolas            Use stOLAS (ExternalStakingDistributor) — no OLAS needed
                      Funded by LemonTree depositors. Requires only ETH for gas.
  --staking-contract  Custom staking contract address (default: Jinn Staking on Base)
  --unattended        Run middleware in unattended mode (default)
  --isolated          Run in isolated temp directory (fresh .operate, no production state)
  --help, -h          Show this help message

NOTES:
  Set ATTENDED=true to wait for funding in-process (blocks until funded).
  Set STAKING_CONTRACT to override the default staking contract.

ENVIRONMENT FILES:
  .env                Production/mainnet configuration (default)
  .env.test           Testnet/Tenderly VNet configuration (use with --testnet)

REQUIRED ENVIRONMENT VARIABLES:
  OPERATE_PASSWORD    Password for wallet encryption
  RPC_URL             RPC URL for the target network

EXAMPLES:
  # Deploy on mainnet using .env (unattended default)
  npx jinn-setup --chain=base

  # Deploy on testnet using .env.test (Tenderly VNet)
  npx jinn-setup --testnet --chain=base

  # Deploy in isolated mode (fresh .operate in temp dir)
  npx jinn-setup --testnet --isolated

  # Deploy via stOLAS (no OLAS required, funded by LemonTree)
  npx jinn-setup --stolas

  # Deploy without mech
  npx jinn-setup --chain=base --no-mech

  # Deploy on Gnosis network
  npx jinn-setup --chain=gnosis

WHAT HAPPENS:
  The middleware will:
  1. Detect or create Master EOA (wallet)
  2. Detect or create Master Safe
  3. Create Agent Key(s)
  4. Show funding requirements (Master EOA / Master Safe)
  5. Wait for funding (attended mode) and deploy/stake
  6. Deploy mech contract (by default)

FUNDING REQUIREMENTS:
  - The CLI prints exact addresses and amounts needed
  - It polls the daemon until funding is detected
  - Total time: 5-10 minutes depending on transfer confirmation speed

INTERRUPTION:
  - You can Ctrl+C at any time
  - Partial state is automatically cleaned on next run
  - Safe to retry from the beginning

`);
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Print setup header
  printHeader('JINN Node Setup');

  // Step 1: Run preflight checks (Poetry, middleware, dependencies)
  printStep('active', 'Checking prerequisites...');
  const preflightResult = await runPreflight({
    autoInstall: true,
  });

  if (!preflightResult.success) {
    printStep('error', 'Prerequisites check failed');
    for (const error of preflightResult.errors) {
      console.error(`\n  ✗ ${error}\n`);
    }
    process.exit(1);
  }
  printStep('done', 'Prerequisites checked');

  // Step 2: Ensure .env exists and has required values
  printStep('active', 'Checking configuration...');
  await ensureEnvFile(isTestnet);

  // Validate environment after potential prompts
  const operatePassword = secrets.operatePassword;
  if (!operatePassword) {
    printStep('error', 'OPERATE_PASSWORD is required');
    printError('OPERATE_PASSWORD not set. Add it to .env or export it.');
    process.exit(1);
  }

  // Determine chain and RPC URL
  const chain = args.chain || getMechChainConfig() || 'base';
  const rpcUrl = secrets.rpcUrl;

  if (!rpcUrl) {
    printStep('error', 'RPC_URL is required');
    printError('RPC_URL not set. Add it to .env or export it.');
    process.exit(1);
  }
  printStep('done', 'Configuration validated');

  // Mech marketplace addresses (Base mainnet is the primary target)
  const mechMarketplaceAddresses: Record<string, string> = {
    base: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
    gnosis: '0x0000000000000000000000000000000000000000', // TODO: Add when available
    mode: '0x0000000000000000000000000000000000000000',   // TODO: Add when available
    optimism: '0x0000000000000000000000000000000000000000', // TODO: Add when available
  };

  // Support staking configuration (enabled by default)
  const disableStaking = args.noStaking === true;
  const stakingContract = (args.stakingContract as string | undefined)
    || process.env.STAKING_CONTRACT;
  const envAttended = typeof process.env.ATTENDED === 'string'
    ? process.env.ATTENDED.toLowerCase() === 'true'
    : undefined;
  const attendedMode = args.unattended ? false : envAttended ?? false;

  // Keep setup defaults aligned with service:add and ecosystem mech delivery expectations.
  const mechRequestPrice = DEFAULT_MECH_DELIVERY_RATE;

  // Create isolated environment if requested
  let isolatedEnv: IsolatedEnvironment | undefined;
  if (args.isolated) {
    console.log('\n Creating isolated environment (fresh .operate in temp dir)...');
    isolatedEnv = await createIsolatedMiddlewareEnvironment();
    console.log(`   Temp dir: ${isolatedEnv.tempDir}\n`);
  }

  const bootstrapConfig: SimplifiedBootstrapConfig = {
    chain: chain as any,
    operatePassword,
    rpcUrl,
    attended: attendedMode,
    // Mech deployment enabled by default for full integration (use --no-mech to disable)
    deployMech: !args.noMech,
    mechMarketplaceAddress: mechMarketplaceAddresses[chain],
    mechRequestPrice: mechRequestPrice,
    // Staking enabled by default (use --no-staking to disable)
    stakingProgram: disableStaking ? 'no_staking' : 'custom_staking',
    customStakingAddress: stakingContract || SERVICE_CONSTANTS.DEFAULT_STAKING_PROGRAM_ID,
    // Isolated environment paths (if --isolated flag used)
    middlewarePath: isolatedEnv?.middlewareDir,
    workingDirectory: isolatedEnv?.tempDir,
  };

  // Show mode banner
  if (args.testnet) {
    console.log('\n+============================================================+');
    console.log('|              TESTNET DEPLOYMENT MODE                       |');
    console.log('+============================================================+');
    console.log('');
    console.log('Using Tenderly Virtual TestNet');
    console.log('Simulated funds (no real funds needed)');
    console.log('Instant transactions');
    console.log('Full visibility in Tenderly Dashboard');
    console.log('');
    console.log(`Attended mode: ${attendedMode ? 'ENABLED (interactive prompts)' : 'DISABLED (env-driven)'}`);
    if (args.isolated) {
      console.log(`Isolated mode: ENABLED (temp dir: ${isolatedEnv?.tempDir})`);
    }
  } else {
    console.log('\n+============================================================+');
    console.log('|              MAINNET DEPLOYMENT MODE                       |');
    console.log('+============================================================+');
    console.log('');
    console.log(`Network: ${chain.toUpperCase()}`);
    console.log(`Real funds will be used`);
    console.log(`Staking: ${disableStaking ? 'DISABLED' : 'ENABLED (Jinn Staking)'}`);
    if (!disableStaking) {
      console.log(`   Contract: ${stakingContract || SERVICE_CONSTANTS.DEFAULT_STAKING_PROGRAM_ID}`);
      console.log(`   Required: ~10,000 OLAS (5,000 OLAS bond + 5,000 OLAS stake)`);
    }
    console.log(`Mech deployment: ${bootstrapConfig.deployMech ? 'ENABLED' : 'DISABLED'}`);
    if (bootstrapConfig.deployMech) {
      console.log(`   Request Price: ${mechRequestPrice} wei`);
      console.log(`   Marketplace: ${bootstrapConfig.mechMarketplaceAddress}`);
    }
    console.log('');
    console.log(`Attended mode: ${attendedMode ? 'ENABLED (interactive prompts)' : 'DISABLED (env-driven)'}`);
    if (args.isolated) {
      console.log(`Isolated mode: ENABLED (temp dir: ${isolatedEnv?.tempDir})`);
    }
  }

  // ── stOLAS flow ──────────────────────────────────────────────────────────
  if (args.stolas) {
    setupLogger.info({
      chain,
      mode: args.testnet ? 'testnet' : 'mainnet',
      isolated: args.isolated || false,
      rpcUrl: rpcUrl.substring(0, 30) + '...',
    }, 'Starting stOLAS bootstrap');

    printStolasIntro();

    // Preflight check
    printStep('active', 'Checking stOLAS prerequisites...');
    const preflight = await stolasPreflightCheck(rpcUrl);
    if (!preflight.ok) {
      printStep('error', 'stOLAS preflight failed');
      printError(preflight.error || 'Unknown preflight error');
      process.exit(1);
    }
    printStep('done', 'stOLAS preflight passed', `${preflight.slotsRemaining} slots remaining`);

    const basePath = isolatedEnv?.tempDir || process.cwd();

    // ── Ensure wallet + Safe exist (idempotent) ─────────────────────────
    // Always run the standard bootstrap — it skips wallet/Safe if they
    // already exist, creates them if missing, and exits at the walletOnly
    // checkpoint after Safe creation. This fixes the rerun bug where wallet
    // files existed but the Safe hadn't been created yet.
    printStep('active', 'Ensuring Master EOA + Safe exist...');
    const walletBootstrapConfig: SimplifiedBootstrapConfig = {
      chain: chain as any,
      operatePassword,
      rpcUrl,
      attended: attendedMode,
      deployMech: false,
      stakingProgram: 'no_staking',
      walletOnly: true,
      middlewarePath: isolatedEnv?.middlewareDir,
      workingDirectory: isolatedEnv?.tempDir,
    };

    const walletBootstrap = new SimplifiedServiceBootstrap(walletBootstrapConfig);
    const walletResult = await walletBootstrap.bootstrap();
    if (!walletResult.success) {
      printError(walletResult.error || 'Wallet/Safe creation failed');
      process.exit(1);
    }
    printStep('done', 'Master EOA + Safe ready');

    // Clean up ghost service config created by walletOnly bootstrap.
    // The middleware persists a service config as a side effect of wallet/Safe creation,
    // but it has no real on-chain service (ID = -1, staking = "no_staking").
    // If left in .operate/services/, the worker will try to load it and crash.
    if (walletResult.serviceConfigId) {
      const ghostConfigDir = join(basePath, '.operate', 'services', walletResult.serviceConfigId);
      if (existsSync(ghostConfigDir)) {
        const { rm } = await import('fs/promises');
        await rm(ghostConfigDir, { recursive: true });
        setupLogger.info({ serviceConfigId: walletResult.serviceConfigId }, 'Removed ghost service config from walletOnly bootstrap');
      }
    }

    printStep('active', 'Loading Master Safe + generating agent key...');
    printStep('active', 'Routing stake() through Master Safe...');
    const result = await stolasBootstrap({
      rpcUrl,
      chain,
      operateBasePath: basePath,
      operatePassword,
    });

    if (result.success) {
      if (result.mechAddress) {
        printStep('done', 'Mech deployed', result.mechAddress);
      } else if (result.mechDeployError) {
        printStep('error', 'Mech deployment deferred — fund Master Safe and run deploy-mech');
      }

      const resultPath = `/tmp/jinn-stolas-setup-${Date.now()}.json`;
      const fs = await import('fs/promises');
      await fs.writeFile(resultPath, JSON.stringify(result, null, 2));

      printStolasSuccess({
        serviceId: result.serviceId!,
        serviceConfigId: result.serviceConfigId!,
        multisig: result.multisig!,
        operatorAddress: result.agentInstanceAddress!,
        masterEoaAddress: result.masterEoaAddress,
        masterSafeAddress: result.masterSafeAddress,
        mechAddress: result.mechAddress,
        mechDeployError: result.mechDeployError,
      });
      console.log(`  Setup details saved to: ${resultPath}\n`);

      if (isolatedEnv) {
        console.log(' Cleaning up isolated environment...');
        await isolatedEnv.cleanup();
      }
      process.exit(0);
    } else {
      printError(result.error || 'Unknown error');
      if (isolatedEnv) {
        await isolatedEnv.cleanup();
      }
      process.exit(1);
    }
  }

  // ── Standard flow ─────────────────────────────────────────────────────────
  setupLogger.info({
    chain,
    withMech: bootstrapConfig.deployMech,
    mode: args.testnet ? 'testnet' : 'mainnet',
    attended: attendedMode,
    isolated: args.isolated || false,
    rpcUrl: rpcUrl.substring(0, 30) + '...',
  }, 'Starting simplified interactive service setup');

  const bootstrap = new SimplifiedServiceBootstrap(bootstrapConfig);

  let exitCode = 1;

  try {
    const result = await bootstrap.bootstrap();

    if (result.success) {
      // Save result to file for reference
      const resultPath = `/tmp/jinn-service-setup-${Date.now()}.json`;
      const fs = await import('fs/promises');
      await fs.writeFile(resultPath, JSON.stringify(result, null, 2));

      printSuccess({
        serviceConfigId: result.serviceConfigId,
        serviceSafeAddress: result.serviceSafeAddress,
      });
      console.log(`  Setup details saved to: ${resultPath}\n`);

      exitCode = 0;
    } else {
      printError(result.error || 'Unknown error');
      exitCode = 1;
    }
  } finally {
    // Cleanup daemon - MUST happen before process.exit()
    console.log('\n Stopping middleware daemon...');
    await bootstrap.cleanup();

    // Cleanup isolated environment if used
    if (isolatedEnv) {
      console.log(' Cleaning up isolated environment...');
      await isolatedEnv.cleanup();
    }
    console.log(' Cleanup complete\n');
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`\n Fatal error:`, error);
  setupLogger.error({ error }, 'Fatal error in setup CLI');
  process.exit(1);
});
