import type { PortResult } from '../outcome.js';

export interface ContributionLedgerEntry {
  recordId: string;
  episodeId: string;
  status: 'queued' | 'minted' | 'published' | 'vetoed';
}

export interface ContributionPort {
  recordMineable(episodeId: string): Promise<PortResult<{ recordId: string }>>;
  ledger(): Promise<PortResult<ContributionLedgerEntry[]>>;
  mintStatus(recordId: string): Promise<PortResult<{ status: ContributionLedgerEntry['status'] }>>;
  veto(recordId: string): Promise<PortResult<{ recordId: string; status: 'vetoed' }>>;
}
