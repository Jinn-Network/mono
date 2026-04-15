/**
 * Session management for Tenderly VNet development environments
 *
 * Responsibilities:
 * - Save VNet details to JSON file
 * - Load existing sessions for cleanup
 * - Track service PIDs and status
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { VnetResult } from './tenderly.js';

export interface ServiceStatus {
  pid: number;
  status: 'running' | 'stopped' | 'crashed';
}

export interface SessionData {
  vnetId: string;
  adminRpcUrl: string;
  publicRpcUrl?: string;
  blockExplorerUrl?: string;
  createdAt: string;
  endedAt?: string;
  fundedWallets: string[];
  services: {
    ponder?: ServiceStatus;
    controlApi?: ServiceStatus;
    worker?: ServiceStatus;
    frontend?: ServiceStatus;
  };
  quotaExhausted?: boolean;
  exitReason?: 'user_interrupt' | 'quota_exhausted' | 'service_crash' | 'error';
  notes?: string;
}

export class SessionManager {
  private sessionFile: string;
  private session: SessionData | null = null;

  constructor(sessionFile?: string) {
    // Default: .vnet-session-<timestamp>.json
    this.sessionFile = sessionFile ||
      join(process.cwd(), `.vnet-session-${Date.now()}.json`);
  }

  /**
   * Initialize new session from VNet result
   */
  async initSession(vnet: VnetResult, fundedWallets: string[]): Promise<void> {
    this.session = {
      vnetId: vnet.id,
      adminRpcUrl: vnet.adminRpcUrl,
      publicRpcUrl: vnet.publicRpcUrl,
      blockExplorerUrl: vnet.blockExplorerUrl,
      createdAt: new Date().toISOString(),
      fundedWallets,
      services: {},
    };
    await this.save();
  }

  /**
   * Update service status
   */
  async updateService(
    name: 'ponder' | 'controlApi' | 'worker' | 'frontend',
    status: ServiceStatus
  ): Promise<void> {
    if (!this.session) throw new Error('Session not initialized');
    this.session.services[name] = status;
    await this.save();
  }

  /**
   * Mark session as ended
   */
  async endSession(
    reason: SessionData['exitReason'],
    quotaExhausted = false,
    notes?: string
  ): Promise<void> {
    if (!this.session) return;
    this.session.endedAt = new Date().toISOString();
    this.session.exitReason = reason;
    this.session.quotaExhausted = quotaExhausted;
    if (notes) this.session.notes = notes;

    // Mark all services as stopped
    for (const key of Object.keys(this.session.services)) {
      const service = this.session.services[key as keyof typeof this.session.services];
      if (service) service.status = 'stopped';
    }

    await this.save();
  }

  /**
   * Save session to disk
   */
  private async save(): Promise<void> {
    if (!this.session) return;
    await fs.writeFile(
      this.sessionFile,
      JSON.stringify(this.session, null, 2),
      'utf-8'
    );
  }

  /**
   * Load session from file
   */
  static async load(sessionFile: string): Promise<SessionData> {
    const content = await fs.readFile(sessionFile, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Get current session data
   */
  getSession(): SessionData | null {
    return this.session;
  }

  /**
   * Get session file path
   */
  getSessionFile(): string {
    return this.sessionFile;
  }
}
