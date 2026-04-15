/**
 * Service Configuration Constants and Utilities
 * 
 * Centralizes service configuration logic and constants to reduce duplication
 * across the OLAS service management system.
 * 
 * JINN-194: Fixed critical configuration issues:
 * - Real IPFS hash (not fake)
 * - Supported chain (gnosis, not base)
 * - Integer fund requirements (not strings)
 */

// Supported chains (must match middleware CHAIN_TO_METADATA)
export const SUPPORTED_CHAINS = [
  'gnosis',
  'base',
  'mode',
  'optimism',
  'ethereum',
  'polygon',
  'arbitrum'
] as const;

export type SupportedChain = typeof SUPPORTED_CHAINS[number];

// Service configuration constants
export const SERVICE_CONSTANTS = {
  // Bond amount (wei as string for contract calls)
  DEFAULT_SERVICE_BOND_WEI: "5000000000000000000000", // 5,000 OLAS bond (Jinn staking)

  // Fund requirements (wei as integers for middleware)
  DEFAULT_AGENT_FUNDING_WEI: 2000000000000000, // 0.002 ETH for gas
  DEFAULT_SAFE_FUNDING_WEI: 2000000000000000, // 0.002 ETH for gas

  // OLAS token requirements (Base mainnet: 0x54330d28ca3357F294334BDC454a032e7f353416)
  DEFAULT_AGENT_OLAS_WEI: "50000000000000000000", // 50 OLAS (unused by default)
  DEFAULT_SAFE_OLAS_WEI: "50000000000000000000",   // 50 OLAS (unused by default)
  DEFAULT_OLAS_TOKEN_ADDRESS: "0x54330d28ca3357F294334BDC454a032e7f353416",

  // jinn_node service package (uploaded during agent 103 registration, updated tx 0x15ae9547)
  DEFAULT_SERVICE_HASH: "QmY3cVULHaiBavCWZEEgoVWmFJpo4gKWK42YFmyVESpp1r",
  DEFAULT_SERVICE_NFT: "bafybeiaakdeconw7j5z76fgghfdjmsr6tzejotxcwnvmp3nroaw3glgyve",

  // On-chain configHash for service metadata (sha256 digest, stored as bytes32 on ServiceRegistry).
  // This MUST be the hash of a JSON metadata file pinned on IPFS (resolvable at
  // gateway.autonolas.tech/ipfs/f01701220{hash}). The middleware fetches this during
  // service lifecycle operations.
  // Derived from service #379 (middleware-created) which uses the same memeooorr package.
  DEFAULT_CONFIG_HASH: "0xf13de04f843a1b740834efaf195ca7e997d2f12e1080e69a8abb07e8d51245af",

  // Staking configuration
  DEFAULT_STAKING_PROGRAM_ID: "0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488", // Jinn v2 staking (agent 103, DeliveryActivityChecker)

  // Supported chain with working configuration
  DEFAULT_HOME_CHAIN: "base" as SupportedChain,

  // RPC URLs for supported chains
  DEFAULT_RPC_URLS: {
    gnosis: "https://gnosis-rpc.publicnode.com",
    base: "https://mainnet.base.org",
    mode: "https://mainnet.mode.network",
    optimism: "https://mainnet.optimism.io",
    ethereum: "https://eth.llamarpc.com",
    polygon: "https://polygon-rpc.com",
    arbitrum: "https://arb1.arbitrum.io/rpc",
  } as Record<SupportedChain, string>,

  // jinn_node agent (registered on Ethereum mainnet, tx 0x4a3d8d35..., name fix tx 0x15ae9547...)
  DEFAULT_AGENT_ID: 103,

  // Default agent release metadata for the service package
  DEFAULT_AGENT_RELEASE: {
    is_aea: false,
    repository: {
      owner: "Jinn-Network",
      name: "jinn_node",
      version: "v1.0.0",
    },
  },

  // Mech info directory
  MECH_INFO_DIR: ".mech-info"
} as const;

// Default service configuration template
export interface ServiceConfigTemplate {
  name: string;
  hash: string;
  description: string;
  image: string;
  service_version: string;
  agent_release: {
    is_aea: boolean;
    repository: {
      owner: string;
      name: string;
      version: string;
    };
  };
  home_chain: SupportedChain;
  configurations: {
    [chain: string]: {
      staking_program_id: string;
      nft: string;
      rpc: string;
      threshold: number;
      agent_id: number;
      use_staking: boolean;
      use_mech_marketplace: boolean;
      cost_of_bond: string;
      fund_requirements: {
        [address: string]: {
          agent: number; // JINN-194: Must be integer, not string
          safe: number;  // JINN-194: Must be integer, not string
        };
      };
    };
  };
  env_variables: Record<string, any>;
}

/**
 * Creates a default service configuration
 * JINN-194: Uses Pearl Agents.Fun defaults with integer fund requirements
 */
export function createDefaultServiceConfig(overrides: Partial<ServiceConfigTemplate> = {}): ServiceConfigTemplate {
  const homeChain = overrides.home_chain || SERVICE_CONSTANTS.DEFAULT_HOME_CHAIN;

  // Generate unique service name with timestamp to avoid conflicts
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const serviceName = `jinn-service-${timestamp}`;

  return {
    name: overrides.name || serviceName,
    hash: SERVICE_CONSTANTS.DEFAULT_SERVICE_HASH,
    description: "[Pearl service] Agents.Fun @twitter_handle",
    image: "https://gateway.autonolas.tech/ipfs/QmQYDGMg8m91QQkTWSSmANs5tZwKrmvUCawXZfXVVWQPcu",
    service_version: "v2.0.2",
    agent_release: SERVICE_CONSTANTS.DEFAULT_AGENT_RELEASE,
    home_chain: homeChain,
    configurations: {
      [homeChain]: {
        staking_program_id: SERVICE_CONSTANTS.DEFAULT_STAKING_PROGRAM_ID,
        nft: SERVICE_CONSTANTS.DEFAULT_SERVICE_NFT,
        rpc: SERVICE_CONSTANTS.DEFAULT_RPC_URLS[homeChain],
        threshold: 1,
        agent_id: SERVICE_CONSTANTS.DEFAULT_AGENT_ID, // Real agent ID
        use_staking: true,
        use_mech_marketplace: false, // Will be enabled when deployMech is called
        cost_of_bond: SERVICE_CONSTANTS.DEFAULT_SERVICE_BOND_WEI,
        fund_requirements: {
          "0x0000000000000000000000000000000000000000": {
            agent: SERVICE_CONSTANTS.DEFAULT_AGENT_FUNDING_WEI,
            safe: SERVICE_CONSTANTS.DEFAULT_SAFE_FUNDING_WEI
          }
        }
      }
    },
    env_variables: {},
    ...overrides
  };
}

/**
 * Validate that chain is supported by middleware
 * JINN-194: Added chain support validation
 */
export function validateChainSupport(chain: string): {
  isSupported: boolean;
  error?: string;
} {
  if (!SUPPORTED_CHAINS.includes(chain as SupportedChain)) {
    return {
      isSupported: false,
      error: `Chain "${chain}" not supported. Supported chains: ${SUPPORTED_CHAINS.join(', ')}`
    };
  }

  return { isSupported: true };
}

/**
 * Validates a service configuration
 * JINN-194: Enhanced with comprehensive validation
 */
export function validateServiceConfig(config: any): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Basic structure checks
  if (!config.name) errors.push('Missing service name');
  if (!config.home_chain) errors.push('Missing home_chain');
  if (!config.hash) errors.push('Missing service hash');

  // Chain support check
  if (config.home_chain) {
    const chainValidation = validateChainSupport(config.home_chain);
    if (!chainValidation.isSupported) {
      errors.push(chainValidation.error!);
    }
  }

  // Configuration exists for home chain
  if (config.home_chain && !config.configurations?.[config.home_chain]) {
    errors.push(`Missing configuration for home_chain "${config.home_chain}"`);
  }

  // IPFS hash format check (CIDv0 = "Qm" prefix, CIDv1 = "bafybei" prefix)
  if (config.hash && !config.hash.startsWith('bafybei') && !config.hash.startsWith('Qm')) {
    errors.push('Invalid IPFS hash format (must start with "bafybei" or "Qm")');
  }

  // Agent ID type check
  const chainConfig = config.configurations?.[config.home_chain];
  if (chainConfig && typeof chainConfig.agent_id !== 'number') {
    errors.push('agent_id must be a number');
  }

  // Fund requirements type check
  if (chainConfig?.fund_requirements) {
    for (const [token, amounts] of Object.entries<any>(chainConfig.fund_requirements)) {
      if (typeof amounts?.agent === 'string' || typeof amounts?.safe === 'string') {
        errors.push(`Fund requirements must be integers, not strings (found in ${token})`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validate service config and throw detailed error if invalid
 * JINN-194: Helper for throwing validation errors
 */
export function validateServiceConfigOrThrow(config: any): void {
  const validation = validateServiceConfig(config);

  if (!validation.isValid) {
    const errorMessage = [
      'Service configuration validation failed:',
      ...validation.errors.map((err, i) => `  ${i + 1}. ${err}`)
    ].join('\n');

    throw new Error(errorMessage);
  }
}

/**
 * Validate service config file before loading
 * JINN-194: Validate config files before use
 */
export async function validateServiceConfigFile(
  configPath: string
): Promise<{ isValid: boolean; errors: string[]; config?: any }> {
  try {
    const fs = await import('fs/promises');
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    const validation = validateServiceConfig(config);

    return {
      ...validation,
      config: validation.isValid ? config : undefined
    };
  } catch (error) {
    return {
      isValid: false,
      errors: [`Failed to load config file: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

/**
 * Extracts service name from config path or config object
 */
export function extractServiceName(configPathOrConfig: string | any): string {
  if (typeof configPathOrConfig === 'string') {
    try {
      const parts = configPathOrConfig.split('/');
      const fileName = parts[parts.length - 1];
      return fileName.replace('-quickstart-config.json', '').replace('.json', '');
    } catch {
      return 'unknown-service';
    }
  }

  return configPathOrConfig?.name || 'unknown-service';
}
