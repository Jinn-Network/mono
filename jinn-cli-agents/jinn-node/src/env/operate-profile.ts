/**
 * Unified utility for reading OLAS Operate service profile configuration
 * 
 * This module provides a single source of truth for reading service configuration
 * from the .operate directory, including mech address, safe address, and private keys.
 * 
 * It's used across:
 * - Ponder configuration (for indexing the correct mech)
 * - Worker process (for claiming work)
 * - MCP tools (for dispatching jobs)
 * - Scripts (for various operations)
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname, parse, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { configLogger } from '../logging/index.js';
import { decryptKeystoreV3 } from './keystore-decrypt.js';
import { secrets } from '../config/index.js';
import {
  getActiveMechAddress,
  getActiveSafeAddress,
  getActivePrivateKey,
  getActiveChainConfig,
} from '../worker/rotation/ActiveServiceContext.js';
import { getCachedServiceConfig } from '../worker/onchain/serviceResolver.js';

// Resolve repo root so this works from both src/ and dist/ builds
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache for decrypted private key to avoid repeated scrypt operations (intentionally slow)
let _cachedDecryptedPrivateKey: string | null = null;
let _cachedKeystoreSourceHash: string | null = null;

/**
 * Check if all critical service config env vars are set
 * When true, we don't need .operate directory and should suppress warnings
 */
function hasAllServiceEnvVars(): boolean {
  const mechAddr = process.env.JINN_SERVICE_MECH_ADDRESS;
  const safeAddr = process.env.JINN_SERVICE_SAFE_ADDRESS;

  // Both must be valid for us to skip .operate
  return Boolean(
    mechAddr && /^0x[a-fA-F0-9]{40}$/i.test(mechAddr) &&
    safeAddr && /^0x[a-fA-F0-9]{40}$/i.test(safeAddr)
  );
}

function findRepoRoot(startDir: string): string | null {
  let current = startDir;
  const { root } = parse(current);

  while (true) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }
    if (current === root) {
      break;
    }
    current = dirname(current);
  }
  return null;
}

function resolveOperateHome(): string | null {
  const repoRoot = findRepoRoot(__dirname);
  const override =
    process.env.OPERATE_PROFILE_DIR ||
    process.env.OPERATE_DIR ||
    process.env.OPERATE_HOME;

  if (override) {
    const normalized = override.trim();
    const absolute = isAbsolute(normalized)
      ? normalized
      : resolve(repoRoot || process.cwd(), normalized);

    if (!existsSync(absolute)) {
      configLogger.warn({ operateDir: absolute }, 'Configured OPERATE_PROFILE_DIR not found');
      return null;
    }

    return absolute;
  }

  if (!repoRoot) {
    // Only warn if env vars don't provide the needed config
    if (!hasAllServiceEnvVars()) {
      configLogger.warn('Unable to locate repository root for operate profile discovery');
    }
    return null;
  }

  // Check standalone/Poetry mode first (<repoRoot>/.operate)
  const standaloneCandidate = join(repoRoot, '.operate');
  if (existsSync(standaloneCandidate)) {
    return standaloneCandidate;
  }

  // .operate directory not found at repo root
  if (!hasAllServiceEnvVars()) {
    configLogger.warn(
      { standaloneCandidate },
      '.operate directory not found at repo root'
    );
  }
  return null;
}

interface ServiceConfig {
  env_variables?: {
    MECH_TO_CONFIG?: {
      value: string;
    };
  };
  safe_address?: string;
  chain_configs?: {
    [chainName: string]: {
      chain_data?: {
        multisig?: string;
        instances?: string[];
      };
    };
  };
}

/**
 * Get the path to the .operate directory
 * Calls resolveOperateHome() lazily to respect runtime environment variable changes
 */
function getOperateDir(): string | null {
  const operateHome = resolveOperateHome();
  if (operateHome && existsSync(operateHome)) {
    return operateHome;
  }

  // Only warn if env vars don't provide the needed config
  if (!hasAllServiceEnvVars()) {
    configLogger.warn({ operateHome }, '.operate directory not found at expected location');
  }
  return null;
}

/**
 * Read service configuration from .operate/services
 * Preference order:
 * 1) Configs with MECH_TO_CONFIG populated
 * 2) Configs with multisig + agent instance present
 * 3) Most recently modified config.json
 */
function readServiceConfig(): ServiceConfig | null {
  try {
    const operateDir = getOperateDir();
    if (!operateDir) {
      // Warning already handled in getOperateDir() if needed
      return null;
    }

    const servicesDir = join(operateDir, 'services');
    if (!existsSync(servicesDir)) {
      // Only warn if env vars don't provide the needed config
      if (!hasAllServiceEnvVars()) {
        configLogger.warn({ operateDir }, 'No services directory found');
      }
      return null;
    }

    // Collect service configs
    const serviceDirs = readdirSync(servicesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    const candidates: Array<{
      dir: string;
      path: string;
      config: ServiceConfig;
      score: number;
      mtimeMs: number;
    }> = [];

    for (const serviceDir of serviceDirs) {
      const candidatePath = join(servicesDir, serviceDir, 'config.json');
      if (!existsSync(candidatePath)) continue;

      try {
        const raw = readFileSync(candidatePath, 'utf-8');
        const config: ServiceConfig = JSON.parse(raw);

        const mechToConfig = config.env_variables?.MECH_TO_CONFIG?.value;
        const hasMechConfig = Boolean(mechToConfig && mechToConfig.trim() !== '');

        let hasMultisig = false;
        let hasInstance = false;
        if (config.chain_configs) {
          for (const chainConfig of Object.values(config.chain_configs)) {
            if (chainConfig.chain_data?.multisig) {
              hasMultisig = true;
            }
            if (chainConfig.chain_data?.instances && chainConfig.chain_data.instances.length > 0) {
              hasInstance = true;
            }
          }
        }

        let score = 0;
        if (hasMechConfig) score += 4;
        if (hasMultisig) score += 2;
        if (hasInstance) score += 1;

        const mtimeMs = statSync(candidatePath).mtimeMs;

        candidates.push({
          dir: serviceDir,
          path: candidatePath,
          config,
          score,
          mtimeMs,
        });
      } catch {
        continue;
      }
    }

    if (candidates.length === 0) {
      // Only warn if env vars don't provide the needed config
      if (!hasAllServiceEnvVars()) {
        configLogger.warn({ servicesDir }, 'No service directories with config.json found');
      }
      return null;
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.mtimeMs - a.mtimeMs;
    });

    const chosen = candidates[0];
    if (candidates.length > 1) {
      configLogger.info(
        { serviceConfigDir: chosen.dir, score: chosen.score, totalCandidates: candidates.length },
        'Selected service config from .operate/services'
      );
    }

    return chosen.config;
  } catch (error) {
    configLogger.warn({ err: error }, 'Error reading service config');
    return null;
  }
}

/**
 * Get the service's target mech contract address
 *
 * Priority:
 * 1. ActiveServiceContext (multi-service rotation)
 * 2. JINN_SERVICE_MECH_ADDRESS environment variable (single-service deployment)
 * 3. .operate service config MECH_TO_CONFIG
 *
 * @returns Mech contract address or null if not found
 */
export function getMechAddress(): string | null {
  // Check ActiveServiceContext first (multi-service rotation overrides static env vars)
  const activeMech = getActiveMechAddress();
  if (activeMech) {
    return activeMech;
  }

  // Fall back to environment variable (single-service Railway deployment)
  const envMech = process.env.JINN_SERVICE_MECH_ADDRESS;
  if (envMech && /^0x[a-fA-F0-9]{40}$/i.test(envMech)) {
    configLogger.info(` Using mech address from JINN_SERVICE_MECH_ADDRESS: ${envMech}`);
    return envMech;
  }

  // Fall back to service config
  const config = readServiceConfig();
  if (!config) {
    return null;
  }

  // Extract mech address from MECH_TO_CONFIG
  const mechToConfig = config.env_variables?.MECH_TO_CONFIG?.value;
  if (!mechToConfig) {
    configLogger.warn('MECH_TO_CONFIG not found in service config');
    return null;
  }

  try {
    // Parse MECH_TO_CONFIG JSON
    const mechConfig = JSON.parse(mechToConfig);
    const mechAddresses = Object.keys(mechConfig);

    if (mechAddresses.length === 0) {
      configLogger.warn('No mech addresses found in MECH_TO_CONFIG');
      return null;
    }

    const mechAddress = mechAddresses[0];
    configLogger.info(` Found service target mech: ${mechAddress}`);
    return mechAddress;
  } catch (error) {
    configLogger.warn({ err: error }, 'Error parsing MECH_TO_CONFIG');
    return null;
  }
}

/**
 * Get the Gnosis Safe multisig address for this service
 *
 * Priority:
 * 1. ActiveServiceContext (multi-service rotation)
 * 2. JINN_SERVICE_SAFE_ADDRESS environment variable (single-service deployment)
 * 3. chain_configs.<chain>.chain_data.multisig (primary location)
 * 4. safe_address at root (backwards compatibility)
 *
 * @returns Safe address or null if not found
 */
export function getServiceSafeAddress(): string | null {
  // Check ActiveServiceContext first (multi-service rotation overrides static env vars)
  const activeSafe = getActiveSafeAddress();
  if (activeSafe) {
    return activeSafe;
  }

  // Fall back to environment variable (single-service Railway deployment)
  const envSafe = process.env.JINN_SERVICE_SAFE_ADDRESS;
  if (envSafe && /^0x[a-fA-F0-9]{40}$/i.test(envSafe)) {
    configLogger.info(` Using safe address from JINN_SERVICE_SAFE_ADDRESS: ${envSafe}`);
    return envSafe;
  }

  // Fall back to service config
  const config = readServiceConfig();
  if (!config) {
    return null;
  }

  // Try to find the Safe address from chain_configs (primary location)
  if (config.chain_configs) {
    // Look for the first chain config with a multisig address
    for (const [chainName, chainConfig] of Object.entries(config.chain_configs)) {
      const multisig = chainConfig.chain_data?.multisig;
      if (multisig) {
        configLogger.info(` Found safe address from chain_configs.${chainName}: ${multisig}`);
        return multisig.trim();
      }
    }
  }

  // Fall back to safe_address at root (backwards compatibility)
  const safeAddress = config.safe_address;
  if (safeAddress) {
    configLogger.info(` Found safe address: ${safeAddress}`);
    return safeAddress;
  }

  // Final fallback: on-chain resolved multisig (from serviceResolver cache)
  const resolved = getCachedServiceConfig();
  if (resolved?.multisig) {
    configLogger.info(` Using safe address from on-chain resolver: ${resolved.multisig}`);
    return resolved.multisig;
  }

  configLogger.warn('safe_address not found in service config');
  return null;
}

/**
 * Get the service's agent EOA private key
 *
 * Priority:
 * 1. ActiveServiceContext (multi-service rotation)
 * 2. Read from .operate/keys/[agent_address]:
 *    - If private_key is 0x-prefixed hex: return directly (old format)
 *    - If private_key is JSON object: decrypt using OPERATE_PASSWORD (new format)
 *
 * @returns Private key (0x-prefixed 64-char hex) or null if not found
 * @throws Error if encrypted but OPERATE_PASSWORD not set
 * @throws Error if decryption fails (wrong password)
 */
export function getServicePrivateKey(): string | null {
  // Check ActiveServiceContext (multi-service rotation)
  const activeKey = getActivePrivateKey();
  if (activeKey) {
    return activeKey;
  }

  // Check explicit env var (Railway deployments without .operate directory)
  const envKey = process.env.JINN_SERVICE_PRIVATE_KEY;
  if (envKey) {
    return envKey;
  }

  // Fall back to service config to get agent address
  const config = readServiceConfig();
  if (!config) {
    return null;
  }

  // Find the first agent instance address from chain_configs
  let agentAddress: string | null = null;
  if (config.chain_configs) {
    for (const chainConfig of Object.values(config.chain_configs)) {
      const instances = chainConfig.chain_data?.instances;
      if (instances && instances.length > 0) {
        agentAddress = instances[0];
        break;
      }
    }
  }

  if (!agentAddress) {
    configLogger.warn('No agent instance found in chain_configs');
    return null;
  }

  // Try to read from keys directory using agent address
  try {
    const operateDir = getOperateDir();
    if (!operateDir) {
      return null;
    }

    const keysPath = join(operateDir, 'keys', agentAddress);

    if (!existsSync(keysPath)) {
      configLogger.warn({ keysPath }, 'Key file not found');
      return null;
    }

    const keyData = readFileSync(keysPath, 'utf-8').trim();

    // Compute hash for cache invalidation
    const sourceHash = createHash('sha256').update(keyData).digest('hex');

    // Check cache - return cached key if file hasn't changed
    if (_cachedDecryptedPrivateKey && _cachedKeystoreSourceHash === sourceHash) {
      return _cachedDecryptedPrivateKey;
    }

    const keyJson = JSON.parse(keyData);
    const privateKeyField = keyJson.private_key;

    if (!privateKeyField) {
      configLogger.warn({ keysPath }, 'private_key field missing in key file');
      return null;
    }

    // Detect format: old (raw hex) vs new (encrypted JSON string)
    if (typeof privateKeyField === 'string' && privateKeyField.startsWith('0x')) {
      // Old format: raw hex key - validate and return
      if (/^0x[a-fA-F0-9]{64}$/i.test(privateKeyField)) {
        configLogger.info(` Found private key for agent ${agentAddress} (raw format)`);
        _cachedDecryptedPrivateKey = privateKeyField;
        _cachedKeystoreSourceHash = sourceHash;
        return privateKeyField;
      }
      configLogger.warn({ keysPath }, 'Invalid hex private key format');
      return null;
    }

    if (typeof privateKeyField === 'string' && privateKeyField.startsWith('{')) {
      // New format: encrypted keystore JSON string - decrypt it
      const password = secrets.operatePassword;
      if (!password) {
        throw new Error(
          'Encrypted keystore detected but OPERATE_PASSWORD not set. ' +
          'Set OPERATE_PASSWORD environment variable to decrypt the agent key.'
        );
      }

      configLogger.info(` Decrypting keystore for agent ${agentAddress}...`);
      const decryptedKey = decryptKeystoreV3(privateKeyField, password);

      // Validate decrypted key format
      if (!/^0x[a-fA-F0-9]{64}$/i.test(decryptedKey)) {
        throw new Error('Decrypted key is not a valid 64-character hex string');
      }

      configLogger.info(` Successfully decrypted private key for agent ${agentAddress}`);
      _cachedDecryptedPrivateKey = decryptedKey;
      _cachedKeystoreSourceHash = sourceHash;
      return decryptedKey;
    }

    configLogger.warn({ keysPath }, 'Unrecognized private_key format');
    return null;
  } catch (error) {
    // Re-throw password-related and decryption errors with clear messages
    if (error instanceof Error) {
      if (error.message.includes('OPERATE_PASSWORD')) {
        throw error;
      }
      if (error.message.includes('MAC mismatch')) {
        throw new Error(
          'Failed to decrypt agent keystore: wrong password. ' +
          'Check OPERATE_PASSWORD environment variable.'
        );
      }
    }
    configLogger.warn({ err: error }, 'Error reading/decrypting private key from .operate');
    return null;
  }
}

/**
 * Reset cached decrypted private key (for testing only)
 * @internal
 */
export function resetPrivateKeyCache(): void {
  _cachedDecryptedPrivateKey = null;
  _cachedKeystoreSourceHash = null;
}

/**
 * Get the chain configuration name from service config
 * 
 * Reads from .operate service config chain_configs keys.
 * Defaults to 'base' if no chain configs found.
 * 
 * No environment variable fallbacks - this is service configuration.
 * 
 * @returns Chain config name (e.g., 'base', 'gnosis', 'ethereum')
 */
export function getMechChainConfig(): string {
  // Check ActiveServiceContext (multi-service rotation)
  const activeChain = getActiveChainConfig();
  if (activeChain) {
    return activeChain;
  }

  const config = readServiceConfig();
  if (!config || !config.chain_configs) {
    return 'base';
  }

  // Return the first chain config name found
  const chainNames = Object.keys(config.chain_configs);
  if (chainNames.length === 0) {
    return 'base';
  }

  return chainNames[0];
}

/**
 * Get all service configuration in one call
 * Useful when you need multiple pieces of information
 */
export function getServiceProfile() {
  return {
    mechAddress: getMechAddress(),
    safeAddress: getServiceSafeAddress(),
    privateKey: getServicePrivateKey(),
    chainConfig: getMechChainConfig(),
  };
}

/**
 * Get the master wallet configuration (EOA and Safe addresses)
 * 
 * Reads from .operate/wallets/ethereum.json
 * 
 * @returns Master wallet info or null if not found
 */
export function getMasterWallet(): { eoa: string; safes: Record<string, string> } | null {
  try {
    const operateDir = getOperateDir();
    if (!operateDir) {
      return null;
    }

    const walletPath = join(operateDir, 'wallets', 'ethereum.json');
    if (!existsSync(walletPath)) {
      configLogger.warn({ walletPath }, 'Master wallet config not found');
      return null;
    }

    const walletData = readFileSync(walletPath, 'utf-8');
    const wallet = JSON.parse(walletData);

    return {
      eoa: wallet.address,
      safes: wallet.safes || {},
    };
  } catch (error) {
    configLogger.warn({ err: error }, 'Error reading master wallet config');
    return null;
  }
}

/**
 * Get the middleware root path (parent of .operate directory)
 * Used by ServiceConfigReader and ServiceRotator for multi-service enumeration.
 */
export function getMiddlewarePath(): string | null {
  const operateDir = getOperateDir();
  if (operateDir) return dirname(operateDir);

  // Fall back to explicit env vars (used in Docker where .operate isn't at repo root)
  const envPath = process.env.OLAS_MIDDLEWARE_PATH || process.env.MIDDLEWARE_PATH;
  if (envPath) return envPath;

  return null;
}

/**
 * Get the master EOA address (Ethereum mainnet)
 */
export function getMasterEOA(): string | null {
  const wallet = getMasterWallet();
  return wallet?.eoa || null;
}

/**
 * Get the master Safe address for a specific chain
 * @param chain Chain name (default: 'base')
 */
export function getMasterSafe(chain: string = 'base'): string | null {
  const wallet = getMasterWallet();
  return wallet?.safes?.[chain] || null;
}

/**
 * Decrypt and return the master EOA private key.
 *
 * The master wallet keystore is at .operate/wallets/ethereum.txt (V3 JSON).
 * Requires OPERATE_PASSWORD env var for decryption.
 * Uses Python eth_account since the middleware is Python-based and
 * the JS web3-eth-accounts scrypt implementation has compatibility issues.
 *
 * @returns Private key hex string (0x-prefixed) or null
 */
export function getMasterPrivateKey(): string | null {
  const operateDir = getOperateDir();
  if (operateDir === null) {
    return null;
  }

  const keystorePath = join(operateDir, 'wallets', 'ethereum.txt');
  if (!existsSync(keystorePath)) {
    configLogger.warn({ keystorePath }, 'Master wallet keystore not found');
    return null;
  }

  const password = secrets.operatePassword;
  if (password === undefined || password === '') {
    configLogger.warn('OPERATE_PASSWORD env var required to decrypt master wallet');
    return null;
  }

  try {
    const keystoreJson = readFileSync(keystorePath, 'utf-8');
    const result = decryptKeystoreV3(keystoreJson, password);

    if (/^0x[a-fA-F0-9]{64}$/.test(result)) {
      configLogger.info('Decrypted master EOA private key');
      return result;
    }

    configLogger.warn('Unexpected output from keystore decryption');
    return null;
  } catch (error) {
    configLogger.warn({ err: error }, 'Failed to decrypt master wallet keystore');
    return null;
  }
}
