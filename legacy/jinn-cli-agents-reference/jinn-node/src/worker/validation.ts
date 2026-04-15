/**
 * Transaction Validation Module
 * 
 * This module provides security validation for transaction requests across all
 * execution strategies. It implements allowlist-based validation for contracts,
 * function selectors, and execution strategy constraints.
 * 
 * @version 1.0.0
 * @since Phase 2 - Dual Rail Architecture
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { URL } from 'url';
import { z } from 'zod';
import { TransactionRequest, ExecutionStrategy } from './types/transaction.js';
import { logger } from '../logging/index.js';

/**
 * Validation result structure
 */
export interface ValidationResult {
  /** Whether the transaction passed validation */
  valid: boolean;
  
  /** Error code if validation failed */
  errorCode?: string;
  
  /** Human-readable error message if validation failed */
  errorMessage?: string;
}

/**
 * Allowlist configuration structure supporting both legacy and new formats
 */
interface AllowlistConfig {
  [chainId: string]: {
    name: string;
    contracts: {
      [address: string]: {
        name: string;
        allowedSelectors: Array<string | SelectorConfig>;
      };
    };
  };
}

/**
 * Enhanced selector configuration with execution strategy constraints
 */
interface SelectorConfig {
  /** Function selector (4-byte hex string) */
  selector: string;
  
  /** Execution strategies allowed for this selector */
  allowed_executors?: ExecutionStrategy[];
  
  /** Optional notes for documentation */
  notes?: string;
}

/**
 * Zod schema for validating allowlist configuration
 */
const ExecutionStrategySchema = z.enum(['EOA', 'SAFE']);

const SelectorConfigSchema = z.object({
  selector: z.string().regex(/^0x[a-fA-F0-9]{8}$/, 'Selector must be a 4-byte hex string'),
  allowed_executors: z.array(ExecutionStrategySchema).optional(),
  notes: z.string().optional()
});

const ContractConfigSchema = z.object({
  name: z.string(),
  allowedSelectors: z.array(
    z.union([
      z.string().regex(/^0x[a-fA-F0-9]{8}$/, 'Selector must be a 4-byte hex string'),
      SelectorConfigSchema
    ])
  )
});

const ChainConfigSchema = z.object({
  name: z.string(),
  contracts: z.record(z.string().regex(/^0x[a-fA-F0-9]{40}$/i, 'Address must be a valid hex address'), ContractConfigSchema)
});

const AllowlistConfigSchema = z.record(z.string(), ChainConfigSchema);

/**
 * Global allowlist configuration cache
 */
let allowlistConfig: AllowlistConfig | null = null;

/**
 * Normalize contract addresses in allowlist configuration to lowercase
 */
function normalizeAllowlistAddresses(config: any): any {
  const normalized: any = {};
  
  for (const [chainId, chainConfig] of Object.entries(config)) {
    normalized[chainId] = {
      ...chainConfig as any,
      contracts: {}
    };
    
    // Normalize all contract addresses to lowercase
    for (const [address, contractConfig] of Object.entries((chainConfig as any).contracts)) {
      normalized[chainId].contracts[address.toLowerCase()] = contractConfig;
    }
  }
  
  return normalized;
}

/**
 * Load and cache the allowlist configuration from file
 */
function loadAllowlistConfig(): AllowlistConfig {
  if (allowlistConfig !== null) {
    return allowlistConfig;
  }

  try {
    let configPath: string;
    
    // Check for environment variable first
    const envConfigPath = process.env.ALLOWLIST_CONFIG_PATH;
    if (envConfigPath && existsSync(envConfigPath)) {
      configPath = envConfigPath;
    } else {
      // Fall back to probing for config file path
      const currentDir = new URL('.', import.meta.url).pathname;
      const devPath = resolve(currentDir, './config/allowlists.json');
      const prodPath = resolve(currentDir, '../../worker/config/allowlists.json');

      if (existsSync(devPath)) {
        configPath = devPath;
      } else if (existsSync(prodPath)) {
        configPath = prodPath;
      } else {
        const err = new Error(`Allowlist configuration not found. Probed paths: ${devPath}, ${prodPath}`);
        logger.error({ devPath, prodPath }, err.message);
        throw err;
      }
    }

    const configData = readFileSync(configPath, 'utf8');
    const rawConfig = JSON.parse(configData);
    
    // Validate configuration with Zod schema
    try {
      const validatedConfig = AllowlistConfigSchema.parse(rawConfig);
      // Normalize addresses to lowercase for consistent matching
      allowlistConfig = normalizeAllowlistAddresses(validatedConfig);
    } catch (zodError) {
      if (zodError instanceof z.ZodError) {
        const errorDetails = zodError.issues.map(err => `${err.path.join('.')}: ${err.message}`).join('; ');
        throw new Error(`Invalid allowlist configuration: ${errorDetails}`);
      }
      throw zodError;
    }
    
    logger.info({ path: configPath }, '[VALIDATION] Allowlist configuration loaded and validated');
    return allowlistConfig;
  } catch (error) {
    logger.error({ error }, '[VALIDATION] Failed to load allowlist configuration');
    throw new Error(`Failed to load allowlist configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if a selector is allowed for a given execution strategy
 */
function isSelectorAllowedForStrategy(
  selectorConfig: string | SelectorConfig, 
  requestedStrategy: ExecutionStrategy
): boolean {
  // Legacy format: string selectors allow all strategies
  if (typeof selectorConfig === 'string') {
    return true;
  }
  
  // New format: check allowed_executors constraint
  if (!selectorConfig.allowed_executors || selectorConfig.allowed_executors.length === 0) {
    return true; // No constraint means all strategies allowed
  }
  
  return selectorConfig.allowed_executors.includes(requestedStrategy);
}

/**
 * Extract the function selector from transaction data
 */
function extractSelector(data: string): string | null {
  // Validate hex string format
  if (!data.startsWith('0x') || data.length < 10) {
    return null;
  }
  
  // Validate that it contains only hex characters
  const hexPattern = /^0x[a-fA-F0-9]+$/;
  if (!hexPattern.test(data)) {
    return null;
  }
  
  // Return normalized (lowercase) selector
  return data.slice(0, 10).toLowerCase();
}

/**
 * Validate transaction payload against allowlists and execution strategy constraints
 * 
 * @param request The transaction request to validate
 * @param context Context object containing workerChainId and executionStrategy
 * @returns Validation result with success status and error details
 */
export function validateTransaction(
  request: TransactionRequest,
  context: { workerChainId: number; executionStrategy: ExecutionStrategy }
): ValidationResult {
  try {
    const config = loadAllowlistConfig();
    const chainConfig = config[request.chain_id.toString()];
    
    // Check if chain is supported
    if (!chainConfig) {
      return {
        valid: false,
        errorCode: 'CHAIN_NOT_SUPPORTED',
        errorMessage: `Chain ID ${request.chain_id} not supported`
      };
    }

    // Check if worker's chain matches request
    if (request.chain_id !== context.workerChainId) {
      return {
        valid: false,
        errorCode: 'CHAIN_MISMATCH',
        errorMessage: `Worker chain ${context.workerChainId} does not match request chain ${request.chain_id}`
      };
    }

    // Check if contract address is in allowlist
    const contractConfig = chainConfig.contracts[request.payload.to.toLowerCase()];
    if (!contractConfig) {
      return {
        valid: false,
        errorCode: 'ALLOWLIST_VIOLATION',
        errorMessage: `Contract ${request.payload.to} not in allowlist for chain ${request.chain_id}`
      };
    }

    // Extract and validate function selector
    const selector = extractSelector(request.payload.data);
    if (!selector) {
      return {
        valid: false,
        errorCode: 'INVALID_PAYLOAD',
        errorMessage: 'Transaction data too short to contain function selector'
      };
    }

    // Find the selector configuration (case-insensitive comparison)
    let selectorConfig: string | SelectorConfig | undefined;
    let selectorFound = false;
    
    for (const allowedSelector of contractConfig.allowedSelectors) {
      if (typeof allowedSelector === 'string') {
        if (allowedSelector.toLowerCase() === selector) {
          selectorConfig = allowedSelector;
          selectorFound = true;
          break;
        }
      } else {
        if (allowedSelector.selector.toLowerCase() === selector) {
          selectorConfig = allowedSelector;
          selectorFound = true;
          break;
        }
      }
    }

    if (!selectorFound || !selectorConfig) {
      return {
        valid: false,
        errorCode: 'ALLOWLIST_VIOLATION',
        errorMessage: `Function selector ${selector} not allowed for contract ${request.payload.to}`
      };
    }

    // Check execution strategy consistency
    if (request.execution_strategy !== context.executionStrategy) {
      return {
        valid: false,
        errorCode: 'EXECUTION_STRATEGY_MISMATCH',
        errorMessage: `Executor strategy '${context.executionStrategy}' does not match request strategy '${request.execution_strategy}'.`
      };
    }

    // Check execution strategy constraints
    if (!isSelectorAllowedForStrategy(selectorConfig, context.executionStrategy)) {
      const allowedStrategies = typeof selectorConfig === 'string' 
        ? ['EOA', 'SAFE'] 
        : (selectorConfig.allowed_executors || ['EOA', 'SAFE']);
      
      return {
        valid: false,
        errorCode: 'EXECUTION_STRATEGY_VIOLATION',
        errorMessage: `Function selector ${selector} not allowed for execution strategy ${context.executionStrategy}. Allowed strategies: ${allowedStrategies.join(', ')}`
      };
    }

    // Check value constraints (currently only zero-value transactions supported)
    try {
      if (BigInt(request.payload.value) !== 0n) {
        return {
          valid: false,
          errorCode: 'INVALID_PAYLOAD',
          errorMessage: 'Non-zero value transactions not supported'
        };
      }
    } catch (error) {
      return {
        valid: false,
        errorCode: 'INVALID_PAYLOAD',
        errorMessage: 'Invalid transaction value format'
      };
    }

    return { valid: true };
    
  } catch (error) {
    logger.error({ error }, '[VALIDATION] Error during transaction validation');
    return {
      valid: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: `Validation failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Reset the allowlist configuration cache (useful for testing)
 */
export function resetAllowlistCache(): void {
  allowlistConfig = null;
}
