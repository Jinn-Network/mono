import type Database from 'better-sqlite3';

/** Key-value operator state in the `config` table. */
export class OperatorConfigStore {
  constructor(private readonly db: Database.Database) {}

  getConfigValue(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfigValue(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  }

  setShutdownState(state: 'clean' | 'running'): void {
    this.setConfigValue('shutdown_state', state);
  }

  getShutdownState(): string | null {
    return this.getConfigValue('shutdown_state');
  }

  setDaemonStartedAt(value: string): void {
    this.setConfigValue('daemon_started_at', value);
  }

  getDaemonStartedAt(): string | null {
    return this.getConfigValue('daemon_started_at');
  }

  getLastProcessedBlock(): bigint | null {
    const raw = this.getConfigValue('last_processed_block');
    return raw ? BigInt(raw) : null;
  }

  setLastProcessedBlock(block: bigint): void {
    this.setConfigValue('last_processed_block', block.toString());
  }
}
