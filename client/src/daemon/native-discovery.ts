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
  WithdrawnAnnouncement,
  SourceHead,
  SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import { compareCodeUnitStrings, headPath, sealJson } from '@jinn-network/record-discovery-protocol';
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
import type { Store } from '../store/store.js';
import type { AnnouncedSubmissionCard } from './native-submission-facts.js';

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

CREATE TABLE IF NOT EXISTS native_discovery_withdrawals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_agent       TEXT NOT NULL,
  source_name        TEXT NOT NULL,
  sequence           TEXT NOT NULL,
  entry_digest       TEXT NOT NULL,
  announcement_id    TEXT NOT NULL,
  retracts           TEXT NOT NULL,
  reason             TEXT NOT NULL,
  accepted_at        TEXT NOT NULL,
  acknowledged_at    TEXT,
  UNIQUE (source_agent, source_name, entry_digest, announcement_id)
);
CREATE INDEX IF NOT EXISTS idx_native_discovery_withdrawals_pending
  ON native_discovery_withdrawals (acknowledged_at, id);
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

export interface NativeDiscoveryQueuedCard<Card = AnnouncedSubmissionCard> {
  readonly id: number;
  readonly announcementId: string;
  readonly card: Card;
}

export interface NativeDiscoveryQueuedWithdrawal {
  readonly id: number;
  readonly source: SourceIdentity;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  readonly announcementId: string;
  readonly retracts: string;
  readonly reason: WithdrawnAnnouncement['reason'];
}

export interface NativeDiscoveryVerificationInput {
  readonly source: SourceIdentity;
  readonly head: SourceHead;
  readonly headSignature: NonNullable<SyncedHead['signature']>;
  readonly entries: AsyncIterable<{ readonly entry: AnnouncementEntry; readonly signature: NonNullable<SyncedEntry['signature']> }>;
  readonly firstAdoption: boolean;
}

export interface NativeDiscoverySource {
  /**
   * Who this source is. Known from configuration — no network call, so it is available at
   * construction, which is what lets the consumer key its durable queue and refuse duplicate
   * sources without reaching the network (#2521).
   */
  readonly identity: SourceIdentity;
  /**
   * Does THIS operator serve this source from its own archive (#2547)? Set only when the source's
   * configured `baseUrl` is this operator's own `publicBaseUrl` — a source it both configures in
   * `recordSources` AND hosts itself. A self-hosted source cannot equivocate against itself, so its
   * own idle-lapsed head degrades this poll instead of refusing (see `pollSource`). Absent/`false`
   * for every peer source, which keeps a peer's stale head a fail-closed refusal exactly as before.
   */
  readonly selfServed?: boolean;
  /**
   * Resolves WHERE to reach this source's serving-plane objects, from its `.well-known`
   * introduction. Called at POLL, not at construction, and memoized on success (#2521): a fleet
   * operator's own requester source lives behind its own archive listener, which binds after
   * composition, and a peer's source lives behind a peer that may not be up yet. Resolving at
   * construction made a symmetric two-operator topology unbootable in either order. Every
   * verification this resolution performs is unchanged — only when it runs moved.
   *
   * A failure is NOT memoized: a peer that is down at one poll must be reachable at the next.
   *
   * `refresh: true` bypasses the memo and re-reads the introduction (#2531 F2). The consumer asks
   * for it on exactly one condition — see `pollSource`'s advertised-head-entry handling — because
   * a peer's `archiveRoot` rolls as it appends history and a pinned root silently stops yielding.
   */
  readonly resolveEndpoint: (options?: { readonly refresh?: boolean }) => Promise<SourceEndpoint>;
  /**
   * Host-wired to the discovery client's trust-aware verifier. A non-`ok` result is a hard
   * gate: no checkpoint/card write and no native work for that poll.
   */
  readonly verify: (input: NativeDiscoveryVerificationInput) => Promise<{
    readonly status: string;
    /**
     * `verifySourceChain`'s own `at:` discriminator (`linkage`, `sequence-contiguity`,
     * `issued-at-monotonicity`, …). Carried through to the refusal message (#2531 F6): dropping
     * it collapsed every broken-chain refusal to the bare word `broken-chain`, which is what
     * forced an out-of-process reproduction to learn that #2531 F1 was a `linkage` failure.
     */
    readonly at?: string;
  }>;
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

/**
 * Why a source contributed nothing this pass WITHOUT being distrusted (#2529).
 *
 * - `unpublished` — the source's `.well-known` introduces it, its head object is absent (404), and
 *   this consumer holds no checkpoint for it. A chain this consumer has never seen a byte of
 *   (#2523).
 * - `unreachable` — nothing answered: connection refused, DNS failure, timeout. Covers both the
 *   `.well-known` introduction and every serving-plane fetch after it.
 * - `undecodable` — the source served a signed announcement this consumer cannot turn into a card.
 * - `self-source-stale` — a source THIS operator serves from its own archive is advertising a head
 *   it has not re-signed past `refreshBy` (#2547). A self-hosted source cannot equivocate against
 *   itself, so its own idle-lapsed head degrades this poll rather than refusing — otherwise a
 *   co-located requester+evaluator that idles >24h deadlocks its own boot. A PEER's lapsed head is
 *   NEVER this: it stays the hard `stale` refusal. See `pollSource` and `buildNativeDiscoverySources`.
 */
export type NativeDiscoveryDegradedReason = 'unpublished' | 'unreachable' | 'undecodable' | 'self-source-stale';

export interface NativeDiscoveryDegradedSource {
  readonly source: SourceIdentity;
  readonly reason: NativeDiscoveryDegradedReason;
  /** The underlying failure, already carrying agent/name/baseUrl where the thrower knew them. */
  readonly detail: string;
}

export interface NativeDiscoverySyncReport {
  readonly accepted: number;
  readonly verifiedSources: number;
  /**
   * Sources skipped this pass. They advanced no checkpoint and queued no card, count toward
   * neither `accepted` nor `verifiedSources`, and are retried on the next poll.
   */
  readonly degraded: readonly NativeDiscoveryDegradedSource[];
}

export interface NativeDiscoveryConsumer<Card = AnnouncedSubmissionCard> {
  /** Pulls/validates every configured source to a signed head and durably queues new cards. */
  sync(): Promise<NativeDiscoverySyncReport>;
  /** Durable, unacknowledged cards in source sequence/insertion order. */
  takePending(): readonly NativeDiscoveryQueuedCard<Card>[];
  takePendingWithdrawals(): readonly NativeDiscoveryQueuedWithdrawal[];
  /** Marks one locally queued card consumed only after its work-loop pass completed. */
  acknowledge(card: NativeDiscoveryQueuedCard<Card>): void;
  acknowledgeWithdrawal(withdrawal: NativeDiscoveryQueuedWithdrawal): void;
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

/**
 * The source served a signed announcement this consumer could not turn into a card (#2529).
 *
 * Deliberately NOT a `NativeDiscoverySyncError`: that class means "refused", and this means "not
 * intelligible to me right now". The distinction is the whole point of the degrade-vs-refuse split
 * — see `degradedReason`.
 */
export class NativeDiscoveryUndecodableAnnouncementError extends Error {
  override readonly name = 'NativeDiscoveryUndecodableAnnouncementError';

  constructor(
    readonly source: SourceIdentity,
    readonly announcementId: string,
    options: { readonly cause: unknown },
  ) {
    super(
      `native discovery source ${source.agent}/${source.name} announcement ${announcementId} `
      + `could not be decoded: ${options.cause instanceof Error ? options.cause.message : String(options.cause)}`,
      options,
    );
  }
}

/**
 * A failure that is THIS operator's, not the source's — never degraded, always fatal.
 *
 * The decode's first act is `assertTrustFresh()`: the local trust catalog changed on disk after
 * the authority was loaded, and the process must restart before authorizing any work. That is a
 * statement about this machine, and it must not be reported as "that peer is being unintelligible"
 * — every source would degrade, once per poll, forever, and the real condition would never
 * surface. So the decode boundary re-throws it untouched.
 */
export class NativeDiscoveryLocalAuthorityError extends Error {
  override readonly name = 'NativeDiscoveryLocalAuthorityError';

  constructor(options: { readonly cause: unknown }) {
    super(
      options.cause instanceof Error ? options.cause.message : String(options.cause),
      options,
    );
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
  source_agent: string;
  source_name: string;
  announcement_id: string;
  card_json: string;
}

function sourceKey(source: SourceIdentity): string {
  return `${source.agent}/${source.name}`;
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

/**
 * Did this failure mean "the head object is not there", as opposed to "the head is bad" or "the
 * source is unreachable"?
 *
 * Duck-typed on the transport's HTTP status rather than on a concrete error class: the consumer is
 * written against the injected `Transport` port and must not learn one transport implementation's
 * types. `fetchHead` issues exactly ONE request — the head object — so a 404 raised out of it can
 * only be that object's absence. Every other failure shape (a refused connection, a `TypeError:
 * fetch failed`, a JSON/schema parse error, any non-404 status) carries no `status: 404` and is
 * rethrown untouched.
 */
function headObjectAbsent(cause: unknown): boolean {
  return typeof cause === 'object'
    && cause !== null
    && (cause as { readonly status?: unknown }).status === 404;
}

/**
 * ## The degrade-vs-refuse discriminator (#2529)
 *
 * `WorkLoop.initialize` awaits `sync()` on the daemon boot path, so until now ANY per-source
 * problem was process-fatal. Three separate instances of that were found live inside a fortnight:
 * a never-published source (#2523), an announcement this consumer's decode rejected (#2529 F1),
 * and a peer that simply was not up (#2529 F2). Fixing them one at a time was fixing instances of
 * a class; this function is the class.
 *
 * **The line is whether the source made an authenticatable STATEMENT that failed a check.**
 *
 * - It said nothing (nothing answered), or it said "that object is not here" about a chain this
 *   consumer has never seen a byte of, or it said something this consumer cannot interpret ⇒ the
 *   source is *unavailable or unintelligible to me right now*. Skip it, log it, keep polling the
 *   others, retry next poll. No checkpoint advances, no card is queued: a degraded source is
 *   indistinguishable, downstream, from a source that had nothing new.
 * - It served bytes that fail authenticity, authority, freshness or ordering ⇒ the source is *not
 *   to be trusted*. That refuses exactly as it did before this function existed, by throwing out
 *   of `sync()`.
 *
 * **It is fail-CLOSED.** Only the three explicitly-recognised shapes degrade; every other failure
 * — including every `NativeDiscoverySyncError` (`unsigned-head`, `stale`,
 * `rewound-or-tampered-head`, `advertised-head-entry-mismatch`, `unsigned-entry`, and any non-`ok`
 * status out of the injected `verify`/`verifyHead`, which is where bad signatures, wrong agents,
 * revoked keys, conflicting bindings and scope violations all land), every non-404 HTTP status,
 * every 404 on a source this consumer HAS a checkpoint for, an introduction that does not
 * uniquely name the identity, and any failure of this operator's own trust catalog — returns
 * `undefined` and is re-thrown untouched. A shape nobody anticipated refuses; it does not degrade.
 */
function degradedReason(cause: unknown): NativeDiscoveryDegradedReason | undefined {
  if (cause instanceof NativeDiscoveryUndecodableAnnouncementError) return 'undecodable';
  // Duck-typed on the shape `native-discovery-trust.ts` stamps, for the same reason
  // `headObjectAbsent` is duck-typed: this module is written against injected ports and does not
  // import the host that builds them.
  if (
    typeof cause === 'object'
    && cause !== null
    && (cause as { readonly name?: unknown }).name === 'NativeDiscoverySourceResolutionError'
    && (cause as { readonly kind?: unknown }).kind === 'unreachable'
  ) return 'unreachable';
  // A transport failure that carries no HTTP status is silence — a refused connection, a DNS
  // failure, a timeout. A failure that DOES carry one is the serving plane answering, and only the
  // narrow 404-with-no-checkpoint case (handled at the head fetch, above) tolerates an answer.
  if (
    cause instanceof Error
    && !(cause instanceof NativeDiscoverySyncError)
    && !(cause instanceof NativeDiscoveryLocalAuthorityError)
    && (cause as { readonly status?: unknown }).status === undefined
    && (cause as { readonly name?: unknown }).name !== 'NativeDiscoverySourceResolutionError'
    && isTransportSilence(cause)
  ) return 'unreachable';
  return undefined;
}

/**
 * Does this look like "the network never delivered a response", as opposed to "the bytes that
 * arrived are wrong"?
 *
 * Node's global `fetch` rejects with `TypeError: fetch failed` and a system-error `cause`
 * (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_*`); an abort/timeout rejects with a `*AbortError` or a
 * `TimeoutError`. Matching those shapes — rather than treating every status-less error as silence
 * — keeps a malformed or schema-invalid payload on the REFUSE side, where a statement belongs.
 */
function isTransportSilence(cause: Error): boolean {
  const code = (cause as { readonly code?: unknown }).code;
  if (typeof code === 'string' && /^(?:E[A-Z]+|UND_ERR_[A-Z_]+)$/u.test(code)) return true;
  if (/^(?:Abort|Timeout)Error$/u.test(cause.name)) return true;
  if (cause instanceof TypeError && /fetch failed|network|load failed/iu.test(cause.message)) return true;
  const inner: unknown = (cause as { readonly cause?: unknown }).cause;
  return inner instanceof Error && inner !== cause && isTransportSilence(inner);
}

function appendCursor(url: string, entry: `sha256:${string}`): string {
  const parsed = new URL(url);
  parsed.searchParams.set('cursor', entry);
  return parsed.toString();
}

export function createNativeDiscoveryConsumer<Card extends object = AnnouncedSubmissionCard>(input: {
  readonly store: Store;
  readonly sources: readonly NativeDiscoverySource[];
  readonly transport: Transport;
  readonly decode: (input: NativeDiscoveryDecodeInput) => Promise<Card | undefined>;
  readonly streamTransport?: StreamTransport;
  readonly onSseError?: (error: unknown) => void;
  readonly now?: () => Date;
}): NativeDiscoveryConsumer<Card> {
  const sources = [...input.sources];
  const keys = new Set<string>();
  for (const source of sources) {
    const key = sourceKey(source.identity);
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
    readonly card: Card;
  }[], withdrawals: readonly {
    readonly sequence: string;
    readonly entryDigest: `sha256:${string}`;
    readonly announcement: WithdrawnAnnouncement;
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
      const insertWithdrawal = input.store.db.prepare(
        `INSERT INTO native_discovery_withdrawals
           (source_agent, source_name, sequence, entry_digest, announcement_id, retracts, reason, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_agent, source_name, entry_digest, announcement_id) DO NOTHING`,
      );
      for (const item of withdrawals) {
        insertWithdrawal.run(
          source.agent,
          source.name,
          item.sequence,
          item.entryDigest,
          item.announcement.announcementId,
          item.announcement.retracts,
          item.announcement.reason,
          acceptedAt,
        );
      }
    })();
  }

  /**
   * Last degradation reported per source, so a poll loop logs a degraded source once rather than
   * every tick — and logs again the moment its reason CHANGES (unreachable -> undecodable is news).
   */
  const reportedDegraded = new Map<string, string>();

  function reportDegraded(source: SourceIdentity, degraded: NativeDiscoveryDegradedSource): void {
    const key = sourceKey(source);
    const line = `${degraded.reason}: ${degraded.detail}`;
    if (reportedDegraded.get(key) === line) return;
    reportedDegraded.set(key, line);
    console.warn(
      `[native-discovery] source ${key} is degraded (${degraded.reason}) — accepting nothing from `
      + `it until it recovers, retrying next poll: ${degraded.detail}`,
    );
  }

  type SourcePollOutcome =
    | { readonly accepted: number }
    | { readonly reason: NativeDiscoveryDegradedReason; readonly detail: string };

  async function pollSource(configured: NativeDiscoverySource): Promise<SourcePollOutcome> {
    const source = configured.identity;
    const prior = checkpoint(source);
    // Poll-time introduction resolution (#2521). A source that cannot be resolved — 404, or
    // introducing a different identity — throws here, exactly the refusal that used to happen
    // at construction, and it names agent/name/baseUrl. A source that is merely DOWN throws
    // the same class marked `kind: 'unreachable'`, which `degradedReason` degrades (#2529 F2).
    const endpoint = await configured.resolveEndpoint();
    let syncedHead: SyncedHead;
    try {
      syncedHead = await fetchHead(endpoint, input.transport);
    } catch (cause) {
      // ## A source that has never published is skipped, not fatal (#2523)
      //
      // #2520 made a mounted archive INTRODUCE every source its operator owns before that
      // source has published anything, and recorded the consuming-side intent exactly: such a
      // source "still finds the head and the archive page absent, so it refuses THAT SOURCE at
      // poll". Refusing the source is right. Throwing out of `sync()` was not — it aborted the
      // whole pass, and `WorkLoop.initialize` awaits this on the daemon start path, so a fleet
      // operator died on its OWN requester source: that source is in `recordSources`, it has
      // published nothing (publishing needs a booted daemon), its head 404s, boot dies. No
      // configuration escapes it — the evaluator leg REQUIRES exactly one requester and one
      // solver source (`native-evaluator-opportunity-source.ts`), so the source cannot be
      // dropped.
      //
      // The tolerated condition is deliberately the narrowest one that unblocks boot, and it
      // is TWO facts, not one:
      //
      //  1. the head object is absent (HTTP 404) — not malformed, not unsigned, not
      //     wrongly-signed, not stale, and not unreachable; and
      //  2. this consumer holds NO durable checkpoint for the source.
      //
      // (2) is the load-bearing half. A source with a checkpoint has published a head this
      // consumer accepted and recorded; that head 404ing now is a rollback or a disappearance,
      // never a cold start, and it stays a hard refusal — otherwise a source could retract its
      // own history by serving 404 and a consumer would shrug. Only (1)-and-(2) together
      // describe a chain this consumer has never seen a single byte of, where there is
      // nothing to roll back and nothing to lose: zero cards, NO checkpoint written, and the
      // remaining sources are polled normally.
      //
      // Nothing about verification moves. Reaching this point already required the source's
      // `.well-known` introduction to resolve and to name this exact identity uniquely, and
      // the moment a head appears the source takes the ordinary cold path — `coldSync` from
      // genesis under `verifySourceChain` with `firstAdoption: true` — so no entry is skipped
      // by having polled early.
      if (prior !== undefined || !headObjectAbsent(cause)) throw cause;
      return {
        reason: 'unpublished',
        detail: `${endpoint.servingRoot}${headPath(source.name)} has no head object yet`,
      };
    }
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
      // A revalidation failure that is NOT freshness — a bad signature, a wrong or revoked key, a
      // head/payload mismatch — refuses for EVERY source, self-hosted or peer alike: a source
      // serving a wrongly-signed head is a real fault, never idle staleness. Only `stale` is
      // eligible for the self-source degrade below.
      if (revalidated.status !== 'ok' && revalidated.status !== 'stale') {
        throw new NativeDiscoverySyncError(source, revalidated.status);
      }
      const stale = revalidated.status === 'stale'
        || new Date(syncedHead.head.refreshBy).getTime() <= (input.now ?? (() => new Date()))().getTime();
      if (stale) {
        // ## A self-hosted source's lapsed head degrades; a peer's still refuses (#2547)
        //
        // A source THIS operator serves from its OWN archive cannot equivocate against itself, so
        // its own not-yet-refreshed idle head is not a trust signal — it is the operator waiting on
        // itself. Nothing re-stamps an idle head's `refreshBy` (it advances only on append,
        // `serve/src/head.ts`), so a co-located requester+evaluator that idles past `refreshBy`
        // (>24h — a normal condition, not an edge case) would DEADLOCK its own boot: the evaluator's
        // first `sync()` reads the operator's own lapsed requester head and a fatal `stale` here
        // aborts `WorkLoop.initialize`, exit 50. Degrading skips that source for the poll — it
        // advances no checkpoint and queues no card, exactly as an idle no-change cycle would — and
        // boot proceeds. The moment the requester appends a new entry the head's sequence advances
        // and the ordinary returning-sync path resumes, so nothing is lost.
        //
        // A PEER's lapsed head stays a hard, fail-closed refusal: a peer serving a head it has not
        // re-signed past `refreshBy` may be partitioned, withholding, or replaying an old head, and
        // this consumer cannot tell that from honest liveness. The discriminator is precise —
        // `selfServed` is set ONLY for a source whose configured `baseUrl` is this operator's own
        // `publicBaseUrl` (`buildNativeDiscoverySources`). Delete it and the peer path degrades too,
        // which the peer-refusal test forbids.
        //
        // (Refreshing the served head at boot instead — "make the head current" — does NOT work with
        // this consumer: a re-signed head at the SAME sequence is not `sameHead` and trips the
        // `rewound-or-tampered-head` guard below for every consumer already checkpointed at that
        // sequence, self AND peer. Degrading the self-consume is the change that closes the deadlock
        // without touching a byte of peer trust.)
        if (configured.selfServed === true) {
          return {
            reason: 'self-source-stale',
            detail: `self-hosted source head lapsed refreshBy ${syncedHead.head.refreshBy}; `
              + 'degrading this poll rather than refusing this operator its own boot',
          };
        }
        throw new NativeDiscoverySyncError(source, 'stale');
      }
      return { accepted: 0 };
    }
    if (prior !== undefined && compareCodeUnitStrings(syncedHead.head.sequence, prior.sequence) <= 0) {
      throw new NativeDiscoverySyncError(source, 'rewound-or-tampered-head');
    }

    // The client sync contract is ordered. Do not merely find a matching item: a verifier
    // that chooses not to consume its iterator must not let a trailing, mismatched page item
    // advance the durable high-water.
    const syncFrom = async (from: SourceEndpoint) => {
      const collected = await collect(
        prior === undefined
          ? coldSync(from, { transport: input.transport })
          : returningSync(from, {
              sequence: prior.sequence,
              entry: prior.entryDigest,
            }, { transport: input.transport }),
      );
      const last = collected.at(-1);
      const reachesAdvertisedHead =
        last !== undefined && sealJson(last.entry).digest === syncedHead.head.entry;
      return { collected, reachesAdvertisedHead };
    };

    // ## A peer's archive page roll is not tamper (#2531 F2)
    //
    // `archiveRootUrl` names the peer's newest archive page, and it rolls as the peer appends.
    // A consumer holding a memoized root keeps reading the OLD page, so `returningSync` collects
    // nothing above its high-water mark and this check fires — under the name
    // `advertised-head-entry-mismatch`, which reads as equivocation. In the live gate that is
    // exactly what happened, for 22 consecutive ticks, over a completely benign roll.
    //
    // A roll and a tamper are distinguishable, and the peer's own signed introduction is what
    // distinguishes them: if re-reading `.well-known` yields a DIFFERENT archive root, the peer
    // moved its page and the correct response is to follow it. If the root is unchanged — or the
    // sync from the new root still does not reach the advertised head — the mismatch is real and
    // refuses exactly as before.
    //
    // The re-resolve is triggered by this failure alone, never by a timer: a steady-state poll
    // reads `.well-known` zero times, and a page roll costs exactly one extra introduction GET
    // (plus re-walking the archive pages from the new root) on the single tick that observes it.
    let attempt = await syncFrom(endpoint);
    if (!attempt.reachesAdvertisedHead) {
      const refreshed = await configured.resolveEndpoint({ refresh: true });
      if (refreshed.archiveRootUrl !== endpoint.archiveRootUrl) {
        // Following the new root cannot LOOSEN anything: the result still has to reach the
        // advertised head below, and `verify` still gates every entry it collected.
        attempt = await syncFrom(refreshed);
        if (attempt.reachesAdvertisedHead) {
          console.info(
            `[native-discovery] source ${sourceKey(source)} rolled its archive page `
            + `(${endpoint.archiveRootUrl} -> ${refreshed.archiveRootUrl}); followed it`,
          );
        }
      }
    }
    if (!attempt.reachesAdvertisedHead) {
      throw new NativeDiscoverySyncError(source, 'advertised-head-entry-mismatch');
    }
    const fetched = attempt.collected;
    const outcome = await configured.verify({
      source,
      head: syncedHead.head,
      headSignature: syncedHead.signature,
      entries: signedEntries(fetched),
      firstAdoption: prior === undefined,
    });
    if (outcome.status !== 'ok') {
      // ## The self-hosted degrade also covers the COLD verify path (#2547 residual, #2549)
      //
      // #2548 degraded a self-hosted source's lapsed head only at the `sameHead` revalidation
      // branch above, which requires `prior !== undefined` — a checkpoint from a previous poll.
      // A co-located requester+evaluator that has never before completed a poll for its own
      // requester source (no row in `native_discovery_source_checkpoints`) never reaches that
      // branch: `prior === undefined` sends it straight here, to `verifySourceChain` via
      // `configured.verify`, which reports the same lapsed-`refreshBy` condition as `{ status:
      // 'stale' }` (`packages/discovery/protocol/src/verify/source-chain.ts`). Before this fix
      // that was thrown as a fatal `NativeDiscoverySyncError('stale')`, aborting
      // `WorkLoop.initialize` on first boot after any idle stretch past `refreshBy` — the exact
      // deadlock #2548 closed at the OTHER call site, still open here.
      //
      // The discriminator is identical to #2548's: `configured.selfServed === true` only for a
      // source this operator serves from its own archive (`buildNativeDiscoverySources`), never
      // for a peer. Only `status === 'stale'` degrades — every other verify failure (`forked`,
      // `broken-chain` at any `at:`, `unauthorized-signer`, etc.) still throws, fail-closed, for
      // self and peer alike, exactly as it always has.
      if (outcome.status === 'stale' && configured.selfServed === true) {
        return {
          reason: 'self-source-stale',
          detail: `self-hosted source head lapsed refreshBy ${syncedHead.head.refreshBy} at cold `
            + 'verify (no prior checkpoint); degrading this poll rather than refusing this '
            + 'operator its own boot',
        };
      }
      throw new NativeDiscoverySyncError(
        source,
        outcome.at === undefined ? outcome.status : `${outcome.status} (at: ${outcome.at})`,
      );
    }

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
      card: Card;
    }> = [];
    const withdrawals: Array<{
      sequence: string;
      entryDigest: `sha256:${string}`;
      announcement: WithdrawnAnnouncement;
    }> = [];
    for (const item of fetched) {
      const entryDigest = sealJson(item.entry).digest;
      for (const announcement of item.entry.announcements) {
        if (announcement.action === 'withdrawn') {
          withdrawals.push({ sequence: item.entry.sequence, entryDigest, announcement });
          continue;
        }
        // ## An announcement this consumer cannot decode degrades the SOURCE (#2529 F1)
        //
        // It does not kill the pass, and it equally does not get skipped past: nothing is
        // queued and — because this returns before `queue()` — the durable high-water does NOT
        // advance over it. A signed announcement this consumer failed to understand stays
        // exactly where it is, to be re-read at the next poll or by a consumer that
        // understands it. Advancing past it would silently drop signed history on a reader
        // bug, which is the failure mode that produced #2529 in the first place.
        //
        // The trade this makes is explicit: a permanently-undecodable announcement wedges that
        // one source's queue rather than that operator's daemon. Loud and stuck beats silent
        // and lossy — and beats dead.
        let decoded: Card | undefined;
        try {
          decoded = await input.decode({
            source,
            entry: item.entry,
            entryDigest,
            announcement,
            signedHighWater: highWater,
          });
        } catch (cause) {
          if (cause instanceof NativeDiscoveryLocalAuthorityError) throw cause;
          throw new NativeDiscoveryUndecodableAnnouncementError(
            source,
            announcement.announcementId,
            { cause },
          );
        }
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
          } as Card,
        });
      }
    }
    queue(source, highWater, cards, withdrawals);
    return { accepted: cards.length + withdrawals.length };
  }

  return {
    async sync() {
      let accepted = 0;
      let verifiedSources = 0;
      const degraded: NativeDiscoveryDegradedSource[] = [];
      for (const configured of sources) {
        const source = configured.identity;
        let outcome: SourcePollOutcome;
        try {
          outcome = await pollSource(configured);
        } catch (cause) {
          // Fail-CLOSED: only the shapes `degradedReason` recognises as "unavailable or
          // unintelligible" are isolated to their source. Everything else — every trust, identity,
          // freshness and ordering refusal — propagates out of `sync()` exactly as it always has.
          const reason = degradedReason(cause);
          if (reason === undefined) throw cause;
          outcome = { reason, detail: cause instanceof Error ? cause.message : String(cause) };
        }
        if ('reason' in outcome) {
          const entry: NativeDiscoveryDegradedSource = {
            source,
            reason: outcome.reason,
            detail: outcome.detail,
          };
          degraded.push(entry);
          reportDegraded(source, entry);
          continue;
        }
        reportedDegraded.delete(sourceKey(source));
        accepted += outcome.accepted;
        verifiedSources += 1;
      }
      return { accepted, verifiedSources, degraded };
    },

    takePending() {
      const rows = input.store.db.prepare(
        `SELECT id, source_agent, source_name, announcement_id, card_json FROM native_discovery_cards
          WHERE acknowledged_at IS NULL ORDER BY id ASC`,
      ).all() as RawQueuedCard[];
      return rows.filter((row) => keys.has(`${row.source_agent}/${row.source_name}`)).map((row) => ({
        id: row.id,
        announcementId: row.announcement_id,
        card: deserialize<Card>(row.card_json),
      }));
    },

    takePendingWithdrawals() {
      const rows = input.store.db.prepare(
        `SELECT id, source_agent, source_name, sequence, entry_digest, announcement_id, retracts, reason
           FROM native_discovery_withdrawals WHERE acknowledged_at IS NULL ORDER BY id ASC`,
      ).all() as Array<{
        id: number; source_agent: string; source_name: string; sequence: string;
        entry_digest: `sha256:${string}`; announcement_id: string; retracts: string;
        reason: WithdrawnAnnouncement['reason'];
      }>;
      return rows.filter((row) => keys.has(`${row.source_agent}/${row.source_name}`)).map((row) => ({
        id: row.id,
        source: { agent: row.source_agent, name: row.source_name },
        sequence: row.sequence,
        entryDigest: row.entry_digest,
        announcementId: row.announcement_id,
        retracts: row.retracts,
        reason: row.reason,
      }));
    },

    acknowledge(card) {
      input.store.db.prepare(
        `UPDATE native_discovery_cards
            SET acknowledged_at = ?
          WHERE id = ? AND acknowledged_at IS NULL`,
      ).run(new Date().toISOString(), card.id);
    },

    acknowledgeWithdrawal(withdrawal) {
      input.store.db.prepare(
        `UPDATE native_discovery_withdrawals SET acknowledged_at = ?
          WHERE id = ? AND acknowledged_at IS NULL`,
      ).run(new Date().toISOString(), withdrawal.id);
    },

    checkpoint,

    resumeSse() {
      if (input.streamTransport === undefined) return { close: () => undefined };
      const subscriptions: StreamSubscription[] = [];
      for (const configured of sources) {
        if (configured.sseUrl === undefined) continue;
        const prior = checkpoint(configured.identity);
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
