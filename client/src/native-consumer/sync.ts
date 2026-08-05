import type { DsseEnvelope } from '@jinn-network/trust-core';
import {
  coldSync,
  fetchHead,
  returningSync,
  type SourceEndpoint,
  type SyncedEntry,
  type Transport,
} from '@jinn-network/record-discovery-client';
import {
  compareCodeUnitStrings,
  formatOrigin,
  parseAnnouncementEntry,
  sealJson,
  verifySourceChain,
  type AnnouncementEntry,
  type FreshnessPolicy,
  type HighWaterMark,
  type KeyResolver,
  type SignatureVerifier,
  type SourceHead,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import { ConsumerState } from './state.js';

export class ConsumerSyncError extends Error {
  override readonly name = 'ConsumerSyncError';
  constructor(readonly reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

export type ConsumerSyncMode = 'cold' | 'returning' | 'rewind' | 'unchanged';

export interface PublicSourceVerificationInput {
  readonly mode: ConsumerSyncMode;
  readonly source: SourceIdentity;
  readonly head: SourceHead;
  readonly headSignature: DsseEnvelope;
  readonly entries: readonly { readonly entry: AnnouncementEntry; readonly signature: DsseEnvelope }[];
  readonly prior?: { readonly sequence: string; readonly entry: `sha256:${string}`; readonly issuedAt: string };
  readonly commonEntry?: `sha256:${string}`;
}

export type PublicSourceVerificationDecision =
  | { readonly status: 'ok' }
  | { readonly status: 'rejected'; readonly reason: string };

export interface PublicSourceVerifier {
  verify(input: PublicSourceVerificationInput): Promise<PublicSourceVerificationDecision>;
}

export interface ProtocolSourceVerifierOptions {
  readonly state: ConsumerState;
  readonly keys: KeyResolver;
  readonly sigs: SignatureVerifier;
  readonly fresh: FreshnessPolicy;
  readonly now: () => Date;
}

export interface PublicSourceSyncResult {
  readonly source: SourceIdentity;
  readonly mode: ConsumerSyncMode;
  readonly received: number;
  readonly accepted: number;
  readonly duplicate: number;
  readonly lag: 0;
  readonly head: { readonly sequence: string; readonly entry: `sha256:${string}` };
}

function canonicalJson(value: unknown): string {
  return new TextDecoder().decode(sealJson(value).bytes);
}

async function collect(iterable: AsyncIterable<SyncedEntry>): Promise<SyncedEntry[]> {
  const entries: SyncedEntry[] = [];
  for await (const value of iterable) entries.push(value);
  return entries;
}

function requirePublishedEntries(entries: readonly SyncedEntry[]): Array<{ entry: AnnouncementEntry; signature: DsseEnvelope }> {
  return entries.map((value) => {
    if (value.signature === undefined) throw new ConsumerSyncError('unsigned-source-entry', value.entry.sequence);
    return { entry: value.entry, signature: value.signature };
  });
}

function latestCommonEntry(
  prior: ReturnType<ConsumerState['entries']>,
  current: readonly SyncedEntry[],
): `sha256:${string}` | undefined {
  const active = new Set(prior.filter((value) => value.active).map((value) => value.digest));
  let common: { sequence: string; digest: `sha256:${string}` } | undefined;
  for (const value of current) {
    const digest = sealJson(value.entry).digest;
    if (!active.has(digest)) continue;
    if (common === undefined || compareCodeUnitStrings(value.entry.sequence, common.sequence) > 0) {
      common = { sequence: value.entry.sequence, digest };
    }
  }
  return common?.digest;
}

function outcomeReason(status: Exclude<Awaited<ReturnType<typeof verifySourceChain>>['status'], 'ok'>): string {
  switch (status) {
    case 'stale': return 'stale-source-head';
    case 'unauthorized-signer': return 'unauthorized-source-signer';
    case 'forked': return 'forked-source-chain';
    case 'broken-chain': return 'discontinuous-source-chain';
  }
}

/**
 * Adapts the consumer's durable checkpoint to the protocol's named source-chain verification.
 * Verification uses a transaction-local high-water mark; only `syncPublicSource` advances durable
 * state after the complete result succeeds.
 */
export function createProtocolSourceVerifier(options: ProtocolSourceVerifierOptions): PublicSourceVerifier {
  return {
    async verify(input): Promise<PublicSourceVerificationDecision> {
      const checkpoint = options.state.checkpoint(input.source);
      if (input.mode === 'unchanged'
        && checkpoint !== undefined
        && checkpoint.envelope === canonicalJson(input.headSignature)) {
        return options.fresh.isFresh(input.head.refreshBy, options.now())
          ? { status: 'ok' }
          : { status: 'rejected', reason: 'stale-source-head' };
      }

      let firstAdoption = input.mode === 'cold' && checkpoint === undefined;
      let mark: HighWaterMark | undefined;
      const entries = [...input.entries];
      if (!firstAdoption) {
        const boundaryDigest = input.mode === 'rewind' ? input.commonEntry : input.prior?.entry;
        if (boundaryDigest === undefined || input.prior === undefined) {
          return { status: 'rejected', reason: 'discontinuous-source-chain' };
        }
        const boundary = options.state.entries(input.source).find(
          (value) => value.digest === boundaryDigest && value.active,
        );
        if (boundary === undefined) return { status: 'rejected', reason: 'discontinuous-source-chain' };
        mark = {
          sequence: boundary.sequence,
          entry: boundary.digest,
          issuedAt: input.prior.issuedAt,
        };
        if (!entries.some((value) => sealJson(value.entry).digest === boundaryDigest)) {
          try {
            entries.unshift({
              entry: parseAnnouncementEntry(JSON.parse(boundary.entryJson)),
              signature: JSON.parse(boundary.signatureJson) as DsseEnvelope,
            });
          } catch {
            return { status: 'rejected', reason: 'discontinuous-source-chain' };
          }
        }
      }
      let advanced: HighWaterMark | undefined;
      const outcome = await verifySourceChain({
        head: input.head,
        headSignature: input.headSignature,
        entries: (async function* () { for (const value of entries) yield value; })(),
        ports: {
          keys: options.keys,
          sigs: options.sigs,
          fresh: options.fresh,
          hwm: {
            async get() { return mark; },
            async put(_source, value) { advanced = value; },
          },
          now: options.now(),
          firstAdoption,
        },
      });
      if (outcome.status !== 'ok') return { status: 'rejected', reason: outcomeReason(outcome.status) };
      if (advanced?.sequence !== input.head.sequence || advanced.entry !== input.head.entry) {
        return { status: 'rejected', reason: 'source-checkpoint-advance-mismatch' };
      }
      return { status: 'ok' };
    },
  };
}

export async function syncPublicSource(input: {
  readonly endpoint: SourceEndpoint;
  readonly transport: Transport;
  readonly state: ConsumerState;
  readonly verifier: PublicSourceVerifier;
}): Promise<PublicSourceSyncResult> {
  const source: SourceIdentity = { agent: input.endpoint.agent, name: input.endpoint.name };
  let fetchedHead: Awaited<ReturnType<typeof fetchHead>>;
  try {
    fetchedHead = await fetchHead(input.endpoint, input.transport);
  } catch (cause) {
    throw new ConsumerSyncError('source-head-invalid', String(cause));
  }
  if (fetchedHead.signature === undefined) throw new ConsumerSyncError('unsigned-source-head');
  if (fetchedHead.head.origin !== formatOrigin(source.agent, source.name)) {
    throw new ConsumerSyncError('source-head-origin-mismatch');
  }
  const prior = input.state.checkpoint(source);
  let mode: ConsumerSyncMode;
  let synced: SyncedEntry[];
  let commonEntry: `sha256:${string}` | undefined;

  if (prior === undefined) {
    mode = 'cold';
    synced = await collect(coldSync(input.endpoint, { transport: input.transport }));
  } else if (prior.sequence === fetchedHead.head.sequence && prior.entry === fetchedHead.head.entry) {
    mode = 'unchanged';
    synced = [];
  } else if (compareCodeUnitStrings(fetchedHead.head.sequence, prior.sequence) > 0) {
    mode = 'returning';
    synced = await collect(returningSync(
      input.endpoint,
      { sequence: prior.sequence, entry: prior.entry },
      { transport: input.transport },
    ));
    if (synced.length === 0 || synced[0]!.entry.previous !== prior.entry) {
      mode = 'rewind';
      synced = await collect(coldSync(input.endpoint, { transport: input.transport }));
      commonEntry = latestCommonEntry(input.state.entries(source), synced);
      if (commonEntry === undefined) throw new ConsumerSyncError('source-rewind-no-common-head');
    }
  } else {
    mode = 'rewind';
    synced = await collect(coldSync(input.endpoint, { transport: input.transport }));
    commonEntry = latestCommonEntry(input.state.entries(source), synced);
    if (commonEntry === undefined) throw new ConsumerSyncError('source-rewind-no-common-head');
  }

  const entries = requirePublishedEntries(synced);
  const decision = await input.verifier.verify({
    mode,
    source,
    head: fetchedHead.head,
    headSignature: fetchedHead.signature,
    entries,
    ...(prior === undefined ? {} : {
      prior: { sequence: prior.sequence, entry: prior.entry, issuedAt: prior.issuedAt },
    }),
    ...(commonEntry === undefined ? {} : { commonEntry }),
  });
  if (decision.status === 'rejected') throw new ConsumerSyncError(decision.reason);

  const persisted = input.state.commitSource({
    source,
    head: {
      sequence: fetchedHead.head.sequence,
      entry: fetchedHead.head.entry,
      issuedAt: fetchedHead.head.issuedAt,
      refreshBy: fetchedHead.head.refreshBy,
      envelope: canonicalJson(fetchedHead.signature),
    },
    entries: entries.map((value) => ({
      sequence: value.entry.sequence,
      digest: sealJson(value.entry).digest,
      entryJson: canonicalJson(value.entry),
      signatureJson: canonicalJson(value.signature),
    })),
    ...(commonEntry === undefined ? {} : { commonEntry }),
  });

  return {
    source,
    mode,
    received: entries.length,
    accepted: persisted.accepted,
    duplicate: persisted.duplicate,
    lag: 0,
    head: { sequence: fetchedHead.head.sequence, entry: fetchedHead.head.entry },
  };
}
