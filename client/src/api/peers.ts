/**
 * Peer artifact sync — fetches artifact metadata from configured peer nodes.
 *
 * On startup and periodically, queries each peer's /artifacts/search endpoint
 * and stores results as remote artifacts in the local SQLite store.
 */

import type { Store } from '../store/store.js';
import {
  signRequestWithErc8128,
  createPrivateKeyHttpSigner,
  type EthHttpSigner,
} from '../auth/erc8128.js';

export interface PeerSyncConfig {
  peers: string[];           // Peer HTTP endpoints, e.g., ['http://localhost:3001']
  store: Store;
  signer?: EthHttpSigner;    // For authenticated content fetches
  syncIntervalMs?: number;   // Default: 60000 (1 minute)
}

export class PeerSync {
  private stopped = false;
  private readonly peers: string[];
  private readonly store: Store;
  private readonly signer?: EthHttpSigner;
  private readonly syncIntervalMs: number;

  constructor(config: PeerSyncConfig) {
    this.peers = config.peers;
    this.store = config.store;
    this.signer = config.signer;
    this.syncIntervalMs = config.syncIntervalMs ?? 60000;
  }

  async syncOnce(): Promise<number> {
    let totalSynced = 0;

    for (const peer of this.peers) {
      try {
        const count = await this.syncFromPeer(peer);
        totalSynced += count;
      } catch (err) {
        console.error(`[peers] Failed to sync from ${peer}:`, err instanceof Error ? err.message : err);
      }
    }

    return totalSynced;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const count = await this.syncOnce();
      if (count > 0) {
        console.log(`[peers] Synced ${count} remote artifacts`);
      }
      await new Promise(r => setTimeout(r, this.syncIntervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async syncFromPeer(peer: string): Promise<number> {
    const url = `${peer}/artifacts/search?limit=100`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      results: Array<{
        id: string;
        title: string;
        tags: string[];
        outcome: string;
        created_at: string;
      }>;
    };

    let synced = 0;
    for (const artifact of data.results) {
      // Skip if we already have this artifact locally
      const existing = this.store.getArtifactContent(artifact.id);
      if (existing !== null) continue;

      this.store.insertRemoteArtifact({
        id: artifact.id,
        desiredStateId: '',
        requestId: '',
        title: artifact.title,
        tags: artifact.tags,
        outcome: artifact.outcome as 'SUCCESS' | 'FAILURE' | 'UNKNOWN',
        ownerAddress: '',
        endpoint: peer,
      });
      synced++;
    }

    return synced;
  }

  async acquireContent(artifactId: string): Promise<string | null> {
    const info = this.store.getRemoteArtifactInfo(artifactId);
    if (!info) return null;

    const url = `${info.endpoint}/artifacts/${artifactId}/content`;

    let request: Request;
    if (this.signer) {
      request = await signRequestWithErc8128({ signer: this.signer, input: url });
    } else {
      request = new Request(url);
    }

    const response = await fetch(request);
    if (!response.ok) {
      throw new Error(`Failed to acquire artifact ${artifactId}: ${response.status}`);
    }

    const data = await response.json() as { content: string };
    // Cache locally
    this.store.cacheRemoteContent(artifactId, data.content);
    return data.content;
  }
}
