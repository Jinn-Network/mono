import type { ContributionLedgerEntry, ContributionPort } from '../ports/contribution-port.js';
import { ok, unavailable } from '../outcome.js';

export class InMemoryContributionPort implements ContributionPort {
  private readonly records = new Map<string, ContributionLedgerEntry>();
  private counter = 0;

  async recordMineable(episodeId: string) {
    this.counter += 1;
    const recordId = `record-${this.counter}`;
    this.records.set(recordId, { recordId, episodeId, status: 'queued' });
    return ok({ recordId });
  }

  async ledger() {
    return ok([...this.records.values()]);
  }

  async mintStatus(recordId: string) {
    const record = this.records.get(recordId);
    if (!record) return unavailable(`no such record: ${recordId}`);
    return ok({ status: record.status });
  }

  async veto(recordId: string) {
    const record = this.records.get(recordId);
    if (!record) return unavailable(`no such record: ${recordId}`);
    record.status = 'vetoed';
    return ok({ recordId, status: 'vetoed' as const });
  }
}
