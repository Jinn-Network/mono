/**
 * Native discovery consumption is deliberately a durable queue, not an archive scan.
 *
 * A source's signed head is verified before any announcement becomes locally actionable. The
 * accepted entry cards and the exact signed high-water advance in one SQLite transaction, so a
 * process death can leave either the prior checkpoint or a replayable local queue — never a
 * checkpoint that skipped unrecorded work. Legacy archive adaptation remains outside this module.
 */
import type {
  AnnouncementEntry,
  AvailableAnnouncement,
  SourceHead,
  SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import { compareCodeUnitStrings, sealJson } from '@jinn-network/record-discovery-protocol';
import {
  coldSync,
  fetchHead,
  returningSync,
  subscribe,
  type SourceEndpoint,
  type StreamSubscription,
  type StreamTransport,
  type SyncedEntry,
  type SyncedHead,
  type Transport,
} from '@jinn-network/record-discovery-client';
import type { AnnouncedSubmissionCard } from '@jinn-network/marketplace-pipeline';
import type { Store } from '../store/store.js';

const BIGINT_TAG = '$bigint';

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? { [BIGINT_TAG]: item.toString() } : item,
  );
}

function deserialize<T>(json: string): T {
  return JSON.parse(json, (_key, item: unknown) => {
    if (
      typeof item === 'object'
      && item !== null
      && !Array.isArray(item)
      && Object.keys(item).length === 1
      && typeof (item as Record<string, unknown>)[BIGINT_TAG] === 'string'
    ) return BigInt((item as Record<string, string>)[BIGINT_TAG]!);
    return item;
  }) as T;
}

export const NATIVE_DISCOVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS native_discovery_source_checkpoints (
  source_agent       TEXT NOT NULL,
  source_name        TEXT NOT NULL,
  sequence           TEXT NOT NULL,
  entry_digest       TEXT NOT NULL,
  issued_at          TEXT NOT NULL,
  refresh_by         TEXT NOT NULL,
  signed_head_json   TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (source_agent, source_name)
);

CREATE TABLE IF NOT EXISTS native_discovery_cards (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_agent       TEXT NOT NULL,
  source_name        TEXT NOT NULL,
  sequence           TEXT NOT NULL,
  entry_digest       TEXT NOT NULL,
  announcement_id    TEXT NOT NULL,
  card_json          TEXT NOT NULL,
  accepted_at        TEXT NOT NULL,
  acknowledged_at    TEXT,
  UNIQUE (source_agent, source_name, entry_digest, announcement_id)
);
CREATE INDEX IF NOT EXISTS idx_native_discovery_cards_pending
  ON native_discovery_cards (acknowledged_at, id);
`;

export interface SignedSourceHighWater {
  readonly sequence: string;
  readonly entry: `sha256:${string}`;
  readonly issuedAt: string;
  readonly refreshBy: string;
  /** The exact wire DSSE envelope that was accepted for this high-water. */
  readonly signature: NonNullable<SyncedHead['signature']>;
}

export interface NativeDiscoveryCheckpoint {
  readonly source: SourceIdentity;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  readonly signedHighWater: SignedSourceHighWater;
}

export interface NativeDiscoveryProvenance {
  readonly source: SourceIdentity;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  readonly signedHighWater: SignedSourceHighWater;
}

export interface NativeDiscoveryQueuedCard {
  readonly id: number;
  readonly announcementId: string;
  readonly card: AnnouncedSubmissionCard;
}

export interface NativeDiscoveryVerificationInput {
  readonly source: SourceIdentity;
  readonly head: SourceHead;
  readonly headSignature: NonNullable<SyncedHead['signature']>;
  readonly entries: AsyncIterable<{ readonly entry: AnnouncementEntry; readonly signature: NonNullable<SyncedEntry['signature']> }>;
  readonly firstAdoption: boolean;
}

export interface NativeDiscoverySource {
  readonly endpoint: SourceEndpoint;
  /**
   * Host-wired to the discovery client's trust-aware verifier. A non-`ok` result is a hard
   * gate: no checkpoint/card write and no native work for that poll.
   */
  readonly verify: (input: NativeDiscoveryVerificationInput) => Promise<{ readonly status: string }>;
  /**
   * Revalidates a signed head that still names the persisted chain position. This closes the
   * otherwise-dangerous same-head shortcut: freshness, key rotation and revocation remain a
   * gate even when no entry was appended. The host normally delegates this to its discovery
   * trust driver.
   */
  readonly verifyHead: (input: {
    readonly source: SourceIdentity;
    readonly head: SourceHead;
    readonly signature: NonNullable<SyncedHead['signature']>;
  }) => Promise<{ readonly status: string }>;
  /** Optional SSE endpoint. Its `cursor` query parameter is the prior accepted entry digest. */
  readonly sseUrl?: string;
}

export interface NativeDiscoveryDecodeInput {
  readonly source: SourceIdentity;
  readonly entry: AnnouncementEntry;
  readonly entryDigest: `sha256:${string}`;
  readonly announcement: AvailableAnnouncement;
  readonly signedHighWater: SignedSourceHighWater;
}

export interface NativeDiscoveryConsumer {
  /** Pulls/validates every configured source to a signed head and durably queues new cards. */
  sync(): Promise<{ readonly accepted: number; readonly verifiedSources: number }>;
  /** Durable, unacknowledged cards in source sequence/insertion order. */
  takePending(): readonly NativeDiscoveryQueuedCard[];
  /** Marks one locally queued card consumed only after its work-loop pass completed. */
  acknowledge(card: NativeDiscoveryQueuedCard): void;
  /** The exact source checkpoint retained across process restarts. */
  checkpoint(source: SourceIdentity): NativeDiscoveryCheckpoint | undefined;
  /** Opens the optional SSE hints with durable per-source resume cursors. */
  resumeSse(): StreamSubscription;
}

export class NativeDiscoverySyncError extends Error {
  constructor(
    readonly source: SourceIdentity,
    readonly reason: string,
  ) {
    super(`native discovery source ${source.agent}/${source.name} refused: ${reason}`);
    this.name = 'NativeDiscoverySyncError';
  }
}

interface RawCheckpoint {
  source_agent: string;
  source_name: string;
  sequence: string;
  entry_digest: `sha256:${string}`;
  issued_at: string;
  refresh_by: string;
  signed_head_json: string;
}

interface RawQueuedCard {
  id: number;
  announcement_id: string;
  card_json: string;
}

function sourceKey(source: SourceIdentity): string {
  return `${source.agent}/${source.name}`;
}

function sourceOf(endpoint: SourceEndpoint): SourceIdentity {
  return { agent: endpoint.agent, name: endpoint.name };
}

function asCheckpoint(row: RawCheckpoint): NativeDiscoveryCheckpoint {
  const signature = JSON.parse(row.signed_head_json) as NonNullable<SyncedHead['signature']>;
  return {
    source: { agent: row.source_agent, name: row.source_name },
    sequence: row.sequence,
    entryDigest: row.entry_digest,
    signedHighWater: {
      sequence: row.sequence,
      entry: row.entry_digest,
      issuedAt: row.issued_at,
      refreshBy: row.refresh_by,
      signature,
    },
  };
}

function sameHead(checkpoint: NativeDiscoveryCheckpoint, head: SyncedHead): boolean {
  return checkpoint.signedHighWater.sequence === head.head.sequence
    && checkpoint.signedHighWater.entry === head.head.entry
    && checkpoint.signedHighWater.issuedAt === head.head.issuedAt
    && checkpoint.signedHighWater.refreshBy === head.head.refreshBy
    && JSON.stringify(checkpoint.signedHighWater.signature) === JSON.stringify(head.signature);
}

function deduplicateEntries(entries: readonly SyncedEntry[]): SyncedEntry[] {
  const seen = new Set<string>();
  const result: SyncedEntry[] = [];
  for (const entry of entries) {
    const digest = sealJson(entry.entry).digest;
    if (seen.has(digest)) continue;
    seen.add(digest);
    result.push(entry);
  }
  return result;
}

async function collect(entries: AsyncIterable<SyncedEntry>): Promise<SyncedEntry[]> {
  const result: SyncedEntry[] = [];
  for await (const item of entries) result.push(item);
  return deduplicateEntries(result);
}

async function* signedEntries(entries: readonly SyncedEntry[]): AsyncIterable<{
  readonly entry: AnnouncementEntry;
  readonly signature: NonNullable<SyncedEntry['signature']>;
}> {
  for (const item of entries) {
    if (item.signature === undefined) throw new NativeDiscoverySyncError(item.entry.source, 'unsigned-entry');
    yield { entry: item.entry, signature: item.signature };
  }
}

function appendCursor(url: string, entry: `sha256:${string}`): string {
  const parsed = new URL(url);
  parsed.searchParams.set('cursor', entry);
  return parsed.toString();
}

export function createNativeDiscoveryConsumer(input: {
  readonly store: Store;
  readonly sources: readonly NativeDiscoverySource[];
  readonly transport: Transport;
  readonly decode: (input: NativeDiscoveryDecodeInput) => Promise<AnnouncedSubmissionCard | undefined>;
  readonly streamTransport?: StreamTransport;
  readonly onSseError?: (error: unknown) => void;
  readonly now?: () => Date;
}): NativeDiscoveryConsumer {
  const sources = [...input.sources];
  const keys = new Set<string>();
  for (const source of sources) {
    const key = sourceKey(sourceOf(source.endpoint));
    if (keys.has(key)) throw new Error(`duplicate native discovery source ${key}`);
    keys.add(key);
  }

  function checkpoint(source: SourceIdentity): NativeDiscoveryCheckpoint | undefined {
    const row = input.store.db.prepare(
      `SELECT source_agent, source_name, sequence, entry_digest, issued_at, refresh_by, signed_head_json
         FROM native_discovery_source_checkpoints
        WHERE source_agent = ? AND source_name = ?`,
    ).get(source.agent, source.name) as RawCheckpoint | undefined;
    return row === undefined ? undefined : asCheckpoint(row);
  }

  function queue(source: SourceIdentity, highWater: SignedSourceHighWater, cards: readonly {
    readonly sequence: string;
    readonly entryDigest: `sha256:${string}`;
    readonly announcementId: string;
    readonly card: AnnouncedSubmissionCard;
  }[]): void {
    input.store.db.transaction(() => {
      input.store.db.prepare(
        `INSERT INTO native_discovery_source_checkpoints
           (source_agent, source_name, sequence, entry_digest, issued_at, refresh_by, signed_head_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_agent, source_name) DO UPDATE SET
           sequence = excluded.sequence,
           entry_digest = excluded.entry_digest,
           issued_at = excluded.issued_at,
           refresh_by = excluded.refresh_by,
           signed_head_json = excluded.signed_head_json,
           updated_at = excluded.updated_at`,
      ).run(
        source.agent,
        source.name,
        highWater.sequence,
        highWater.entry,
        highWater.issuedAt,
        highWater.refreshBy,
        JSON.stringify(highWater.signature),
        new Date().toISOString(),
      );
      const insert = input.store.db.prepare(
        `INSERT INTO native_discovery_cards
           (source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_agent, source_name, entry_digest, announcement_id) DO NOTHING`,
      );
      const acceptedAt = new Date().toISOString();
      for (const item of cards) {
        insert.run(
          source.agent,
          source.name,
          item.sequence,
          item.entryDigest,
          item.announcementId,
          serialize(item.card),
          acceptedAt,
        );
      }
    })();
  }

  return {
    async sync() {
      let accepted = 0;
      let verifiedSources = 0;
      for (const configured of sources) {
        const source = sourceOf(configured.endpoint);
        const prior = checkpoint(source);
        const syncedHead = await fetchHead(configured.endpoint, input.transport);
        if (syncedHead.signature === undefined) {
          throw new NativeDiscoverySyncError(source, 'unsigned-head');
        }

        // A byte-identical signed head is a no-card-work cycle only after it is revalidated.
        // A key can have been revoked or the source head can have crossed refreshBy since the
        // last poll; cached acceptance is never enough to begin work.
        if (prior !== undefined && sameHead(prior, syncedHead)) {
          const revalidated = await configured.verifyHead({
            source,
            head: syncedHead.head,
            signature: syncedHead.signature,
          });
          if (revalidated.status !== 'ok') throw new NativeDiscoverySyncError(source, revalidated.status);
          if (new Date(syncedHead.head.refreshBy).getTime() <= (input.now ?? (() => new Date()))().getTime()) {
            throw new NativeDiscoverySyncError(source, 'stale');
          }
          verifiedSources += 1;
          continue;
        }
        if (prior !== undefined && compareCodeUnitStrings(syncedHead.head.sequence, prior.sequence) <= 0) {
          throw new NativeDiscoverySyncError(source, 'rewound-or-tampered-head');
        }

        const fetched = await collect(
          prior === undefined
            ? coldSync(configured.endpoint, { transport: input.transport })
            : returningSync(configured.endpoint, {
                sequence: prior.sequence,
                entry: prior.entryDigest,
              }, { transport: input.transport }),
        );
        // The client sync contract is ordered. Do not merely find a matching item: a verifier
        // that chooses not to consume its iterator must not let a trailing, mismatched page item
        // advance the durable high-water.
        const terminal = fetched.at(-1);
        if (terminal === undefined || sealJson(terminal.entry).digest !== syncedHead.head.entry) {
          throw new NativeDiscoverySyncError(source, 'advertised-head-entry-mismatch');
        }
        const outcome = await configured.verify({
          source,
          head: syncedHead.head,
          headSignature: syncedHead.signature,
          entries: signedEntries(fetched),
          firstAdoption: prior === undefined,
        });
        if (outcome.status !== 'ok') throw new NativeDiscoverySyncError(source, outcome.status);

        const highWater: SignedSourceHighWater = {
          sequence: syncedHead.head.sequence,
          entry: syncedHead.head.entry,
          issuedAt: syncedHead.head.issuedAt,
          refreshBy: syncedHead.head.refreshBy,
          signature: syncedHead.signature,
        };
        const cards: Array<{
          sequence: string;
          entryDigest: `sha256:${string}`;
          announcementId: string;
          card: AnnouncedSubmissionCard;
        }> = [];
        for (const item of fetched) {
          const entryDigest = sealJson(item.entry).digest;
          for (const announcement of item.entry.announcements) {
            if (announcement.action !== 'available') continue;
            const decoded = await input.decode({
              source,
              entry: item.entry,
              entryDigest,
              announcement,
              signedHighWater: highWater,
            });
            if (decoded === undefined) continue;
            cards.push({
              sequence: item.entry.sequence,
              entryDigest,
              announcementId: announcement.announcementId,
              card: {
                ...decoded,
                discovery: {
                  source,
                  sequence: item.entry.sequence,
                  entryDigest,
                  signedHighWater: highWater,
                },
              },
            });
          }
        }
        queue(source, highWater, cards);
        accepted += cards.length;
        verifiedSources += 1;
      }
      return { accepted, verifiedSources };
    },

    takePending() {
      const rows = input.store.db.prepare(
        `SELECT id, announcement_id, card_json FROM native_discovery_cards
          WHERE acknowledged_at IS NULL ORDER BY id ASC`,
      ).all() as RawQueuedCard[];
      return rows.map((row) => ({
        id: row.id,
        announcementId: row.announcement_id,
        card: deserialize<AnnouncedSubmissionCard>(row.card_json),
      }));
    },

    acknowledge(card) {
      input.store.db.prepare(
        `UPDATE native_discovery_cards
            SET acknowledged_at = ?
          WHERE id = ? AND acknowledged_at IS NULL`,
      ).run(new Date().toISOString(), card.id);
    },

    checkpoint,

    resumeSse() {
      if (input.streamTransport === undefined) return { close: () => undefined };
      const subscriptions: StreamSubscription[] = [];
      for (const configured of sources) {
        if (configured.sseUrl === undefined) continue;
        const source = sourceOf(configured.endpoint);
        const prior = checkpoint(source);
        const url = prior === undefined
          ? configured.sseUrl
          : appendCursor(configured.sseUrl, prior.entryDigest);
        subscriptions.push(subscribe({
          streamTransport: input.streamTransport,
          url,
          // SSE only hints that a subsequent verified pull may have work. It is deliberately
          // never admitted directly into the durable queue.
          onAnnouncement: () => undefined,
          onObservation: () => undefined,
          ...(input.onSseError === undefined ? {} : { onError: input.onSseError }),
        }));
      }
      return { close: () => subscriptions.forEach((subscription) => subscription.close()) };
    },
  };
}
