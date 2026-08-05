import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import type { SourceIdentity } from '@jinn-network/record-discovery-protocol';
import { documentDigest } from '@jinn-network/task-execution-protocol';

export class ConsumerStateError extends Error {
  override readonly name = 'ConsumerStateError';
  constructor(readonly reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

export interface ConsumerCheckpoint {
  readonly source: SourceIdentity;
  readonly sequence: string;
  readonly entry: `sha256:${string}`;
  readonly issuedAt: string;
  readonly refreshBy: string;
  readonly envelope: string;
}

export interface ConsumerSourceEntry {
  readonly sequence: string;
  readonly digest: `sha256:${string}`;
  readonly entryJson: string;
  readonly signatureJson: string;
  readonly active: boolean;
}

interface CheckpointRow {
  source_agent: string;
  source_name: string;
  sequence: string;
  entry_digest: `sha256:${string}`;
  issued_at: string;
  refresh_by: string;
  envelope_json: string;
}

interface EntryRow {
  sequence: string;
  entry_digest: `sha256:${string}`;
  entry_json: string;
  signature_json: string;
  active: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS consumer_sources (
  source_agent TEXT NOT NULL,
  source_name TEXT NOT NULL,
  sequence TEXT NOT NULL,
  entry_digest TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  refresh_by TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_agent, source_name)
);
CREATE TABLE IF NOT EXISTS consumer_entries (
  source_agent TEXT NOT NULL,
  source_name TEXT NOT NULL,
  sequence TEXT NOT NULL,
  entry_digest TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  signature_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (source_agent, source_name, entry_digest),
  UNIQUE (source_agent, source_name, sequence, entry_digest)
);
CREATE INDEX IF NOT EXISTS idx_consumer_entries_sequence
  ON consumer_entries (source_agent, source_name, sequence);
CREATE TABLE IF NOT EXISTS consumer_records (
  digest TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  cache_path TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  cached_at TEXT NOT NULL
);
`;

function validSource(source: SourceIdentity): void {
  if (source.agent.length === 0 || source.name.length === 0) {
    throw new ConsumerStateError('invalid-source-identity');
  }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export class ConsumerState {
  private constructor(
    readonly rootDir: string,
    private readonly db: Database.Database,
    private readonly cacheDir: string,
  ) {}

  static async open(rootDir: string): Promise<ConsumerState> {
    if (!isAbsolute(rootDir)) throw new ConsumerStateError('state-root-must-be-absolute');
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await chmod(rootDir, 0o700);
    const cacheDir = join(rootDir, 'records');
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const db = new Database(join(rootDir, 'consumer.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    return new ConsumerState(rootDir, db, cacheDir);
  }

  close(): void {
    this.db.close();
  }

  checkpoint(source: SourceIdentity): ConsumerCheckpoint | undefined {
    validSource(source);
    const row = this.db.prepare(
      `SELECT source_agent, source_name, sequence, entry_digest, issued_at, refresh_by, envelope_json
         FROM consumer_sources WHERE source_agent = ? AND source_name = ?`,
    ).get(source.agent, source.name) as CheckpointRow | undefined;
    return row === undefined ? undefined : {
      source: { agent: row.source_agent, name: row.source_name },
      sequence: row.sequence,
      entry: row.entry_digest,
      issuedAt: row.issued_at,
      refreshBy: row.refresh_by,
      envelope: row.envelope_json,
    };
  }

  entries(source: SourceIdentity): readonly ConsumerSourceEntry[] {
    validSource(source);
    const rows = this.db.prepare(
      `SELECT sequence, entry_digest, entry_json, signature_json, active
         FROM consumer_entries WHERE source_agent = ? AND source_name = ? ORDER BY sequence, entry_digest`,
    ).all(source.agent, source.name) as EntryRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      digest: row.entry_digest,
      entryJson: row.entry_json,
      signatureJson: row.signature_json,
      active: row.active === 1,
    }));
  }

  commitSource(input: {
    readonly source: SourceIdentity;
    readonly head: Omit<ConsumerCheckpoint, 'source'>;
    readonly entries: readonly Omit<ConsumerSourceEntry, 'active'>[];
    readonly commonEntry?: `sha256:${string}`;
  }): { readonly accepted: number; readonly duplicate: number } {
    validSource(input.source);
    return this.db.transaction(() => {
      if (input.commonEntry !== undefined) {
        const common = this.db.prepare(
          `SELECT sequence FROM consumer_entries
            WHERE source_agent = ? AND source_name = ? AND entry_digest = ? AND active = 1`,
        ).get(input.source.agent, input.source.name, input.commonEntry) as { sequence: string } | undefined;
        if (common === undefined) throw new ConsumerStateError('rewind-common-entry-missing');
        this.db.prepare(
          `UPDATE consumer_entries SET active = 0
            WHERE source_agent = ? AND source_name = ? AND active = 1 AND sequence > ?`,
        ).run(input.source.agent, input.source.name, common.sequence);
      }
      const insert = this.db.prepare(
        `INSERT INTO consumer_entries
          (source_agent, source_name, sequence, entry_digest, entry_json, signature_json, active, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(source_agent, source_name, entry_digest) DO UPDATE SET active = 1`,
      );
      let accepted = 0;
      let duplicate = 0;
      const acceptedAt = new Date().toISOString();
      for (const entry of input.entries) {
        const prior = this.db.prepare(
          `SELECT entry_json, signature_json FROM consumer_entries
            WHERE source_agent = ? AND source_name = ? AND entry_digest = ?`,
        ).get(input.source.agent, input.source.name, entry.digest) as
          | { entry_json: string; signature_json: string }
          | undefined;
        if (prior !== undefined
          && (prior.entry_json !== entry.entryJson || prior.signature_json !== entry.signatureJson)) {
          throw new ConsumerStateError('duplicate-entry-byte-conflict');
        }
        const result = insert.run(
          input.source.agent,
          input.source.name,
          entry.sequence,
          entry.digest,
          entry.entryJson,
          entry.signatureJson,
          acceptedAt,
        );
        if (result.changes !== 1) throw new ConsumerStateError('source-entry-write-failed');
        if (prior === undefined) accepted += 1;
        else duplicate += 1;
      }
      this.db.prepare(
        `INSERT INTO consumer_sources
          (source_agent, source_name, sequence, entry_digest, issued_at, refresh_by, envelope_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_agent, source_name) DO UPDATE SET
           sequence = excluded.sequence,
           entry_digest = excluded.entry_digest,
           issued_at = excluded.issued_at,
           refresh_by = excluded.refresh_by,
           envelope_json = excluded.envelope_json,
           updated_at = excluded.updated_at`,
      ).run(
        input.source.agent,
        input.source.name,
        input.head.sequence,
        input.head.entry,
        input.head.issuedAt,
        input.head.refreshBy,
        input.head.envelope,
        acceptedAt,
      );
      return { accepted, duplicate };
    })();
  }

  recordPath(digest: `sha256:${string}`): string {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new ConsumerStateError('invalid-record-digest');
    return join(this.cacheDir, digest.slice('sha256:'.length));
  }

  record(digest: `sha256:${string}`): Uint8Array | undefined {
    const row = this.db.prepare('SELECT cache_path FROM consumer_records WHERE digest = ?').get(digest) as
      | { cache_path: string }
      | undefined;
    if (row === undefined) return undefined;
    return new Uint8Array(readFileSync(row.cache_path));
  }

  async putRecord(input: {
    readonly digest: `sha256:${string}`;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<{ readonly stored: boolean }> {
    if (documentDigest(input.bytes) !== input.digest) throw new ConsumerStateError('record-digest-mismatch');
    const path = this.recordPath(input.digest);
    const existing = this.db.prepare(
      'SELECT media_type, cache_path, byte_length FROM consumer_records WHERE digest = ?',
    ).get(input.digest) as { media_type: string; cache_path: string; byte_length: number } | undefined;
    if (existing !== undefined) {
      const bytes = new Uint8Array(await readFile(existing.cache_path));
      if (!equal(bytes, input.bytes) || existing.media_type !== input.mediaType) {
        throw new ConsumerStateError('record-cache-conflict');
      }
      return { stored: false };
    }
    const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(input.bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      this.db.prepare(
        `INSERT INTO consumer_records (digest, media_type, cache_path, byte_length, cached_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(input.digest, input.mediaType, path, input.bytes.length, new Date().toISOString());
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return { stored: true };
  }
}
