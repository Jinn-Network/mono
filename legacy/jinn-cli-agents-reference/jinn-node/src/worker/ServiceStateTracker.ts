/**
 * Service State Tracker
 * 
 * Persistent state tracking for OLAS services, Safes, and balances.
 * This prevents accidental fund loss by maintaining a clear record of:
 * - Which services exist
 * - Which Safes are associated with which services
 * - Which wallets control which Safes
 * - Balance history for each Safe
 * 
 * CRITICAL: This is a safety layer to prevent the fund loss incident from recurring.
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { logger } from '../logging/index.js';

const stateLogger = logger.child({ component: "SERVICE-STATE-TRACKER" });

export interface ServiceState {
  serviceConfigId: string;
  serviceName: string;
  chain: string;
  safeAddress: string;
  agentAddress: string;
  masterWalletAddress: string;
  tokenId?: number;
  createdAt: string;
  status: 'created' | 'deployed' | 'staked' | 'stopped' | 'terminated';
  balances: {
    timestamp: string;
    eth: string;
    tokens: Record<string, string>; // tokenAddress -> balance
  }[];
}

export interface StateSnapshot {
  version: '1.0';
  updatedAt: string;
  services: ServiceState[];
}

export class ServiceStateTracker {
  private stateFile: string;
  private state: StateSnapshot | null = null;

  constructor(stateDir: string = './.olas-service-state') {
    this.stateFile = path.join(stateDir, 'state.json');
  }

  /**
   * Load state from disk
   */
  async load(): Promise<void> {
    try {
      if (existsSync(this.stateFile)) {
        const data = await readFile(this.stateFile, 'utf-8');
        this.state = JSON.parse(data);
        stateLogger.info({ serviceCount: this.state?.services.length || 0 }, "Loaded service state");
      } else {
        this.state = {
          version: '1.0',
          updatedAt: new Date().toISOString(),
          services: []
        };
        stateLogger.info("Initialized new service state");
      }
    } catch (error) {
      stateLogger.error({ error }, "Failed to load state, initializing empty");
      this.state = {
        version: '1.0',
        updatedAt: new Date().toISOString(),
        services: []
      };
    }
  }

  /**
   * Save state to disk
   */
  async save(): Promise<void> {
    try {
      if (!this.state) {
        throw new Error('State not loaded');
      }

      this.state.updatedAt = new Date().toISOString();
      
      // Ensure directory exists
      const dir = path.dirname(this.stateFile);
      await mkdir(dir, { recursive: true });
      
      // Write with pretty printing for human readability
      await writeFile(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
      
      stateLogger.debug({ stateFile: this.stateFile }, "Saved service state");
    } catch (error) {
      stateLogger.error({ error }, "Failed to save state");
      throw error;
    }
  }

  /**
   * Register a new service
   */
  async registerService(service: Omit<ServiceState, 'createdAt' | 'status' | 'balances'>): Promise<void> {
    if (!this.state) {
      await this.load();
    }

    const existingIndex = this.state!.services.findIndex(
      s => s.serviceConfigId === service.serviceConfigId
    );

    const newService: ServiceState = {
      ...service,
      createdAt: new Date().toISOString(),
      status: 'created',
      balances: []
    };

    if (existingIndex >= 0) {
      stateLogger.warn({ serviceConfigId: service.serviceConfigId }, "Service already registered, updating");
      this.state!.services[existingIndex] = newService;
    } else {
      this.state!.services.push(newService);
      stateLogger.info({ 
        serviceConfigId: service.serviceConfigId,
        safeAddress: service.safeAddress,
        chain: service.chain
      }, "Registered new service");
    }

    await this.save();
  }

  /**
   * Update service status
   */
  async updateServiceStatus(serviceConfigId: string, status: ServiceState['status']): Promise<void> {
    if (!this.state) {
      await this.load();
    }

    const service = this.state!.services.find(s => s.serviceConfigId === serviceConfigId);
    if (!service) {
      stateLogger.warn({ serviceConfigId }, "Service not found in state");
      return;
    }

    service.status = status;
    stateLogger.info({ serviceConfigId, status }, "Updated service status");
    
    await this.save();
  }

  /**
   * Record balance snapshot for a service
   */
  async recordBalance(
    serviceConfigId: string,
    eth: string,
    tokens: Record<string, string>
  ): Promise<void> {
    if (!this.state) {
      await this.load();
    }

    const service = this.state!.services.find(s => s.serviceConfigId === serviceConfigId);
    if (!service) {
      stateLogger.warn({ serviceConfigId }, "Service not found in state");
      return;
    }

    service.balances.push({
      timestamp: new Date().toISOString(),
      eth,
      tokens
    });

    stateLogger.debug({ 
      serviceConfigId, 
      safeAddress: service.safeAddress, 
      eth 
    }, "Recorded balance snapshot");

    await this.save();
  }

  /**
   * Get all services
   */
  async getAllServices(): Promise<ServiceState[]> {
    if (!this.state) {
      await this.load();
    }
    return this.state!.services;
  }

  /**
   * Get services by Safe address
   */
  async getServicesBySafe(safeAddress: string): Promise<ServiceState[]> {
    if (!this.state) {
      await this.load();
    }
    return this.state!.services.filter(
      s => s.safeAddress.toLowerCase() === safeAddress.toLowerCase()
    );
  }

  /**
   * Get services by chain
   */
  async getServicesByChain(chain: string): Promise<ServiceState[]> {
    if (!this.state) {
      await this.load();
    }
    return this.state!.services.filter(s => s.chain === chain);
  }

  /**
   * Check if a Safe is already registered
   */
  async isSafeRegistered(safeAddress: string): Promise<boolean> {
    if (!this.state) {
      await this.load();
    }
    return this.state!.services.some(
      s => s.safeAddress.toLowerCase() === safeAddress.toLowerCase()
    );
  }

  /**
   * Get the latest balance for a service
   */
  async getLatestBalance(serviceConfigId: string): Promise<ServiceState['balances'][0] | null> {
    if (!this.state) {
      await this.load();
    }

    const service = this.state!.services.find(s => s.serviceConfigId === serviceConfigId);
    if (!service || service.balances.length === 0) {
      return null;
    }

    return service.balances[service.balances.length - 1];
  }

  /**
   * Export state for backup
   */
  async exportState(): Promise<StateSnapshot> {
    if (!this.state) {
      await this.load();
    }
    return JSON.parse(JSON.stringify(this.state)); // Deep copy
  }

  /**
   * Import state from backup
   */
  async importState(snapshot: StateSnapshot): Promise<void> {
    this.state = snapshot;
    await this.save();
    stateLogger.info({ serviceCount: snapshot.services.length }, "Imported state snapshot");
  }

  /**
   * Generate a human-readable report of all services
   */
  async generateReport(): Promise<string> {
    if (!this.state) {
      await this.load();
    }

    const lines: string[] = [];
    lines.push('=== OLAS Service State Report ===');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Total Services: ${this.state!.services.length}`);
    lines.push('');

    for (const service of this.state!.services) {
      lines.push(`Service: ${service.serviceName} (${service.serviceConfigId})`);
      lines.push(`  Chain: ${service.chain}`);
      lines.push(`  Safe: ${service.safeAddress}`);
      lines.push(`  Agent: ${service.agentAddress}`);
      lines.push(`  Master Wallet: ${service.masterWalletAddress}`);
      lines.push(`  Token ID: ${service.tokenId || 'N/A'}`);
      lines.push(`  Status: ${service.status}`);
      lines.push(`  Created: ${service.createdAt}`);
      
      if (service.balances.length > 0) {
        const latest = service.balances[service.balances.length - 1];
        lines.push(`  Latest Balance (${latest.timestamp}):`);
        lines.push(`    ETH: ${latest.eth}`);
        for (const [token, balance] of Object.entries(latest.tokens)) {
          lines.push(`    ${token}: ${balance}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
