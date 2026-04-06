/**
 * Tenderly API client for managing Virtual TestNets (vnets) during E2E testing
 *
 * This module provides functionality to programmatically create, manage, and fund
 * Virtual TestNets using Tenderly's API for testing wallet bootstrap scenarios.
 *
 * Key features:
 * - Creates ephemeral Virtual TestNets for isolated testing
 * - Funds EOA addresses via Admin RPC
 * - Cleans up vnets after testing
 */

import { promises as fs } from 'fs';
import { resolve } from 'path';
import { scriptLogger } from '../logging/index.js';

/**
 * Tenderly API configuration
 */
interface TenderlyConfig {
  accessKey?: string;
  accountSlug?: string;
  projectSlug?: string;
}

export interface VnetResult {
  id: string;
  container_name: string;
  project_id: string;
  adminRpcUrl: string;
  publicRpcUrl?: string;
  blockExplorerUrl?: string;
}

/**
 * Virtual TestNet creation request body
 */
interface VnetCreateRequest {
  slug: string;
  display_name: string;
  fork_config: {
    network_id: number;
    block_number: string;
  };
  virtual_network_config: {
    chain_config: {
      chain_id: number;
    };
  };
  sync_state_config: {
    enabled: boolean;
    commitment_level: string;
  };
  explorer_page_config: {
    enabled: boolean;
    verification_visibility: string;
  };
}

/**
 * Virtual TestNet API response structure
 */
interface VnetCreateResponse {
  id: string;
  slug: string;
  display_name: string;
  rpcs: Array<{
    name: string;
    url: string;
  }>;
  // ... other fields we don't need for now
}

/**
 * Tenderly API client for Virtual TestNets
 */
export class TenderlyClient {
  private config: TenderlyConfig;
  private baseUrl = 'https://api.tenderly.co';

  constructor(config: TenderlyConfig = {}) {
    this.config = {
      accessKey: config.accessKey || process.env.TENDERLY_ACCESS_KEY,
      accountSlug: config.accountSlug || process.env.TENDERLY_ACCOUNT_SLUG,
      projectSlug: config.projectSlug || process.env.TENDERLY_PROJECT_SLUG,
      ...config,
    };
  }

  /**
   * Fetch with retry logic for transient network failures
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    { maxRetries = 3, baseDelayMs = 1000, operation = 'fetch' } = {}
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);
        return response;
      } catch (error: any) {
        lastError = error;
        const isRetryable = error.code === 'UND_ERR_CONNECT_TIMEOUT' ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.message?.includes('timeout') ||
          error.message?.includes('ENOTFOUND');

        if (!isRetryable || attempt === maxRetries) {
          throw error;
        }

        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        scriptLogger.warn({
          operation,
          attempt,
          maxRetries,
          delay,
          error: error.message,
          code: error.code,
        }, `Tenderly ${operation} failed, retrying...`);

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Check if Tenderly is properly configured
   */
  isConfigured(): boolean {
    return !!(
      this.config.accessKey &&
      this.config.accountSlug &&
      this.config.projectSlug
    );
  }

  /**
   * Validate required environment variables
   */
  private validateConfig(): void {
    if (!this.config.accessKey) {
      throw new Error('TENDERLY_ACCESS_KEY is required');
    }
    if (!this.config.accountSlug) {
      throw new Error('TENDERLY_ACCOUNT_SLUG is required');
    }
    if (!this.config.projectSlug) {
      throw new Error('TENDERLY_PROJECT_SLUG is required');
    }
  }

  /**
   * Create a new Virtual TestNet
   */
  async createVnet(chainId: number = 8453, blockNumber?: string): Promise<VnetResult> {
    this.validateConfig();

    // Generate a unique slug for this test run
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(7);
    const slug = `e2e-test-${timestamp}-${randomId}`;

    const requestBody: VnetCreateRequest = {
      slug,
      display_name: `E2E Test VNet ${timestamp}`,
      fork_config: {
        network_id: chainId, // Use the same chainId as the network_id to fork from the correct chain
        block_number: blockNumber || "latest"
      },
      virtual_network_config: {
        chain_config: {
          chain_id: chainId
        }
      },
      sync_state_config: {
        enabled: false,
        commitment_level: "latest"
      },
      explorer_page_config: {
        enabled: true,
        verification_visibility: "bytecode"
      }
    };

    const url = `${this.baseUrl}/api/v1/account/${this.config.accountSlug}/project/${this.config.projectSlug}/vnets`;

    scriptLogger.info({
      slug,
      chainId,
      blockNumber,
      accountSlug: this.config.accountSlug,
      projectSlug: this.config.projectSlug,
    }, 'Creating Virtual TestNet');
    
    try {
      const response = await this.fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Access-Key': this.config.accessKey!,
          },
          body: JSON.stringify(requestBody),
        },
        { operation: 'createVnet' }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText}. Response: ${errorText}`);
      }

      const vnetData: VnetCreateResponse = await response.json();
      
      // Extract Admin RPC URL from the response
      const adminRpc = vnetData.rpcs.find(rpc => rpc.name === 'Admin RPC');
      const publicRpc = vnetData.rpcs.find(rpc => rpc.name === 'Public RPC');
      
      if (!adminRpc) {
        throw new Error('Admin RPC URL not found in vnet creation response');
      }

      const result: VnetResult = {
        id: vnetData.id,
        container_name: vnetData.slug,
        project_id: vnetData.id, // Assuming project_id is the same as vnet_id for now
        adminRpcUrl: adminRpc.url,
        publicRpcUrl: publicRpc?.url,
        blockExplorerUrl: `https://dashboard.tenderly.co/explorer/vnet/${vnetData.id}`
      };

      scriptLogger.info({
        vnetId: result.id,
        adminRpcUrl: result.adminRpcUrl,
        blockExplorerUrl: result.blockExplorerUrl
      }, 'Created Virtual TestNet');

      return result;
    } catch (error: any) {
      scriptLogger.error({ error: error.message, slug }, 'Failed to create Virtual TestNet');
      throw error;
    }
  }

  /**
   * Fund an address on a Virtual TestNet using Admin RPC
   */
  async fundAddress(
    address: string,
    amountWei: string,
    adminRpcUrl: string
  ): Promise<void> {
    if (!adminRpcUrl) {
      throw new Error('Admin RPC URL is required for funding');
    }

    try {
      const response = await this.fetchWithRetry(
        adminRpcUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tenderly_setBalance',
            params: [[address], `0x${BigInt(amountWei).toString(16)}`], // Address must be in array
            id: 1,
          }),
        },
        { operation: 'fundAddress' }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText}. Response: ${errorText}`);
      }

      const result = await response.json();
      if (result.error) {
        throw new Error(`RPC Error: ${JSON.stringify(result.error)}`);
      }

      scriptLogger.info({ address, amountWei }, 'Successfully funded address on Virtual TestNet');
    } catch (error: any) {
      scriptLogger.error({ address, error: error.message }, 'Failed to fund address on Virtual TestNet');
      throw error; // Re-throw instead of failing silently for test reliability
    }
  }

  /**
   * List all Virtual TestNets in the project
   */
  async listVnets(): Promise<Array<{ id: string; slug: string; display_name: string; created_at?: string }>> {
    if (!this.isConfigured()) {
      scriptLogger.warn('Tenderly not configured, cannot list vnets');
      return [];
    }

    const url = `${this.baseUrl}/api/v1/account/${this.config.accountSlug}/project/${this.config.projectSlug}/vnets`;

    try {
      const response = await this.fetchWithRetry(
        url,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-Access-Key': this.config.accessKey!,
          },
        },
        { operation: 'listVnets' }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText}. Response: ${errorText}`);
      }

      const vnets = await response.json();
      scriptLogger.info({ count: vnets.length }, 'Listed Virtual TestNets');
      return vnets;
    } catch (error: any) {
      scriptLogger.error({ error: error.message }, 'Failed to list Virtual TestNets');
      throw error;
    }
  }

  /**
   * Cleanup old/stale Virtual TestNets (e.g., e2e-test-* vnets older than maxAgeMs)
   * Returns the number of vnets deleted
   */
  async cleanupOldVnets(options: { maxAgeMs?: number; dryRun?: boolean } = {}): Promise<number> {
    const { maxAgeMs = 60 * 60 * 1000, dryRun = false } = options; // Default 1 hour
    
    if (!this.isConfigured()) {
      scriptLogger.warn('Tenderly not configured, cannot cleanup vnets');
      return 0;
    }

    try {
      const vnets = await this.listVnets();
      const now = Date.now();
      let deletedCount = 0;

      for (const vnet of vnets) {
        // Only cleanup e2e-test-* vnets (our test vnets)
        if (!vnet.slug?.startsWith('e2e-test-')) {
          continue;
        }

        // Parse timestamp from slug: e2e-test-{timestamp}-{randomId}
        const match = vnet.slug.match(/^e2e-test-(\d+)-/);
        if (match) {
          const createdTimestamp = parseInt(match[1], 10);
          const age = now - createdTimestamp;
          
          if (age > maxAgeMs) {
            if (dryRun) {
              scriptLogger.info({ vnetId: vnet.id, slug: vnet.slug, ageMs: age }, '[DRY RUN] Would delete stale vnet');
            } else {
              scriptLogger.info({ vnetId: vnet.id, slug: vnet.slug, ageMs: age }, 'Deleting stale vnet');
              await this.deleteVnet(vnet.id);
              deletedCount++;
            }
          }
        }
      }

      scriptLogger.info({ deletedCount, dryRun }, 'Cleanup complete');
      return deletedCount;
    } catch (error: any) {
      scriptLogger.error({ error: error.message }, 'Failed to cleanup old vnets');
      return 0;
    }
  }

  /**
   * Delete a Virtual TestNet after testing
   */
  async deleteVnet(vnetId: string): Promise<void> {
    if (!this.isConfigured()) {
      scriptLogger.warn('Tenderly not configured, skipping vnet deletion');
      return;
    }

    if (!vnetId) {
      scriptLogger.warn('No vnet ID provided, skipping deletion');
      return;
    }

    const url = `${this.baseUrl}/api/v1/account/${this.config.accountSlug}/project/${this.config.projectSlug}/vnets/${vnetId}`;

    try {
      scriptLogger.info({ vnetId }, 'Deleting Virtual TestNet');

      const response = await this.fetchWithRetry(
        url,
        {
          method: 'DELETE',
          headers: {
            'X-Access-Key': this.config.accessKey!,
          },
        },
        { operation: 'deleteVnet', maxRetries: 2 }
      );

      if (!response.ok) {
        scriptLogger.warn({ vnetId, status: response.status, statusText: response.statusText }, 'Failed to delete Virtual TestNet');
      } else {
        scriptLogger.info({ vnetId }, 'Successfully deleted Virtual TestNet');
      }
    } catch (error: any) {
      scriptLogger.warn({ vnetId, error: error.message }, 'Failed to delete Virtual TestNet');
    }
  }
}

/**
 * Mock implementation for when Tenderly is not available
 */
export class MockTenderlyClient extends TenderlyClient {
  private mockedBalances = new Map<string, string>();
  private mockVnetId = 'mock-vnet-' + Math.random().toString(36).substring(7);
  private mockAdminRpcUrl = 'https://mock.tenderly.rpc/admin';

  isConfigured(): boolean {
    return true; // Mock is always "configured"
  }

  async createVnet(): Promise<VnetResult> {
    scriptLogger.info({ vnetId: this.mockVnetId }, '[MOCK] Created Tenderly Virtual TestNet');
    return {
      id: this.mockVnetId,
      container_name: this.mockVnetId,
      project_id: this.mockVnetId,
      adminRpcUrl: this.mockAdminRpcUrl,
      publicRpcUrl: 'https://mock.tenderly.rpc/public',
      blockExplorerUrl: `https://mock.tenderly.co/explorer/vnet/${this.mockVnetId}`
    };
  }

  async fundAddress(address: string, amountWei: string, adminRpcUrl: string): Promise<void> {
    this.mockedBalances.set(address.toLowerCase(), amountWei);
    scriptLogger.info({ address, amountWei, adminRpcUrl }, '[MOCK] Funded address');

    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  async deleteVnet(vnetId: string): Promise<void> {
    scriptLogger.info({ vnetId }, '[MOCK] Deleted Tenderly Virtual TestNet');
    this.mockedBalances.clear();
  }

  /**
   * Check if an address has been mocked as funded
   */
  isMockFunded(address: string): boolean {
    return this.mockedBalances.has(address.toLowerCase());
  }

  /**
   * Get mocked balance for an address
   */
  getMockBalance(address: string): string | undefined {
    return this.mockedBalances.get(address.toLowerCase());
  }
}

/**
 * Create a Tenderly client, falling back to mock if not configured
 */
export function createTenderlyClient(): TenderlyClient {
  const realClient = new TenderlyClient();

  if (realClient.isConfigured()) {
    scriptLogger.info({
      accountSlug: process.env.TENDERLY_ACCOUNT_SLUG,
      projectSlug: process.env.TENDERLY_PROJECT_SLUG,
    }, 'Using real Tenderly API client');
    return realClient;
  } else {
    scriptLogger.info('Tenderly not configured, using mock client');
    return new MockTenderlyClient();
  }
}

/**
 * Load Tenderly configuration from environment or config file
 */
export async function loadTenderlyConfig(): Promise<TenderlyConfig> {
  const config: TenderlyConfig = {};

  // Try to load from environment variables
  config.accessKey = process.env.TENDERLY_ACCESS_KEY;
  config.accountSlug = process.env.TENDERLY_ACCOUNT_SLUG;
  config.projectSlug = process.env.TENDERLY_PROJECT_SLUG;

  // Try to load from a config file
  try {
    const configPath = resolve(process.cwd(), '.tenderly.json');
    const configContent = await fs.readFile(configPath, 'utf8');
    const fileConfig = JSON.parse(configContent);

    Object.assign(config, fileConfig);
  } catch (error) {
    // Config file doesn't exist or is invalid, that's okay
  }

  return config;
}

/**
 * Utility function to convert ETH to wei
 */
export function ethToWei(ethAmount: string): string {
  const eth = parseFloat(ethAmount);
  if (isNaN(eth)) {
    throw new Error(`Invalid ETH amount: ${ethAmount}`);
  }
  
  // 1 ETH = 10^18 wei
  const wei = BigInt(Math.floor(eth * 1e18));
  return wei.toString();
}

/**
 * Utility function to convert wei to ETH
 */
export function weiToEth(weiAmount: string): string {
  const wei = BigInt(weiAmount);
  const eth = Number(wei) / 1e18;
  return eth.toFixed(6);
}