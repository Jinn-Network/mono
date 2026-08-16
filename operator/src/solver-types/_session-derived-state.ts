export interface SessionDerivedStateSnapshot {
  processedCaptureCids: string[];
  rejected: Array<{ captureCid: string; reason: string; at: string }>;
}

export class SessionDerivedState {
  private readonly processed = new Set<string>();
  private readonly rejectedRows: Array<{ captureCid: string; reason: string; at: string }> = [];

  constructor(snapshot: Partial<SessionDerivedStateSnapshot> = {}) {
    for (const cid of snapshot.processedCaptureCids ?? []) this.processed.add(cid);
    this.rejectedRows.push(...(snapshot.rejected ?? []));
  }

  hasProcessed(captureCid: string): boolean {
    return this.processed.has(captureCid);
  }

  markProcessed(captureCid: string): void {
    this.processed.add(captureCid);
  }

  markRejected(captureCid: string, reason: string, at = new Date().toISOString()): void {
    this.rejectedRows.push({ captureCid, reason, at });
  }

  snapshot(): SessionDerivedStateSnapshot {
    return {
      processedCaptureCids: Array.from(this.processed).sort(),
      rejected: [...this.rejectedRows],
    };
  }
}
