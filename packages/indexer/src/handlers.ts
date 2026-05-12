/**
 * Pure event-handler logic for the Jinn protocol indexer, extracted out of the
 * `ponder.on(...)` registrations in `src/index.ts` so it can be unit-tested
 * without booting the Ponder runtime.
 *
 * Why an extract instead of Ponder's test utilities: Ponder 0.16.x ships no
 * first-class unit-test util for indexing functions — the `ponder:registry`,
 * `ponder:schema`, and `ponder:api` modules are virtual modules resolved only
 * by the Ponder build, not importable from Vitest. So `src/index.ts` is reduced
 * to thin `ponder.on(...)` shims that forward `{ event, context }` to the pure
 * functions here, passing the schema table objects as arguments. Tests call the
 * pure functions directly with synthetic events, the real schema tables, and an
 * in-memory `db` stub that mirrors the `insert / update / find /
 * onConflictDoUpdate / onConflictDoNothing` surface the handlers use.
 *
 * The behaviour here is byte-for-byte the same as the original inline handlers
 * — this is a refactor, not a behaviour change. See `src/index.ts` for the
 * Ponder docs links and the schema rationale.
 */
import { decodeAbiParameters, type Hex } from 'viem';
import {
  parseEnvelopeKey,
  parseSolverNetManifestKey,
  tierFromRaw,
} from './types.js';

// ── Minimal structural types for the handler context ──────────────────────────
// Deliberately narrow — only the fields the handlers actually touch. The real
// Ponder `event` / `context` objects are structurally compatible supersets of
// these, so `src/index.ts` passes them through without casts.

/** The `db` surface the handlers use — a structural subset of Ponder's `Db`. */
export interface HandlerDb {
  find: (table: unknown, key: Record<string, unknown>) => Promise<unknown | null>;
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => Promise<unknown> & {
      onConflictDoNothing: () => Promise<unknown>;
      onConflictDoUpdate: (
        update: Record<string, unknown> | ((row: any) => Record<string, unknown>),
      ) => Promise<unknown>;
    };
  };
  update: (
    table: unknown,
    key: Record<string, unknown>,
  ) => { set: (values: Record<string, unknown> | ((row: any) => Record<string, unknown>)) => Promise<unknown> };
}

export interface HandlerContext {
  db: HandlerDb;
  chain: { id: number };
}

export interface BlockShape {
  number: bigint;
}
export interface TransactionShape {
  hash: `0x${string}`;
  transactionIndex?: number;
}
export interface LogShape {
  logIndex?: number;
}

export interface TaskCreatedEvent {
  args: {
    creator: `0x${string}`;
    taskId: bigint;
    manifestDigest: `0x${string}`;
    taskCidDigest: `0x${string}`;
    maxClaims: bigint | number;
    requiredVerdicts: bigint | number;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface TaskAttemptCreatedEvent {
  args: {
    taskId: bigint;
    attemptIndex: bigint | number;
    requestId: `0x${string}`;
    operator: `0x${string}`;
    priorityMech: `0x${string}`;
    deliveryRate: bigint;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface SolutionDeliveryClaimedEvent {
  args: {
    operator: `0x${string}`;
    requestId: `0x${string}`;
    taskId: bigint;
    attemptIndex: bigint | number;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface VerdictDeliveryClaimedEvent {
  args: {
    evaluator: `0x${string}`;
    requestId: `0x${string}`;
    taskId: bigint;
    attemptIndex: bigint | number;
    verdictIndex: bigint | number;
    verdictCode: bigint | number;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

export interface MetadataSetEvent {
  args: {
    agentId: bigint;
    metadataKey: string;
    metadataValue: `0x${string}`;
  };
  block: BlockShape;
  transaction: TransactionShape;
  log: LogShape;
}

// ── ABI tuple for payload decoding ────────────────────────────────────────────
// Matches PAYLOAD_TUPLE_V2 in client/src/erc8004/abis.ts. We try V2 first,
// then fall back to V1 (without the trailing harness identity fields).

export const PAYLOAD_TUPLE_V2 = [
  { name: 'version', type: 'uint8' },
  { name: 'tier', type: 'uint8' },
  { name: 'manifestHash', type: 'bytes32' },
  { name: 'attestationQuoteCid', type: 'bytes' },
  { name: 'sourceMeasurement', type: 'bytes32' },
  { name: 'codeDigest', type: 'bytes32' },
  { name: 'implName', type: 'string' },
  { name: 'modeFlag', type: 'uint8' },
] as const;

export const PAYLOAD_TUPLE_V1 = [
  { name: 'version', type: 'uint8' },
  { name: 'tier', type: 'uint8' },
  { name: 'manifestHash', type: 'bytes32' },
  { name: 'attestationQuoteCid', type: 'bytes' },
  { name: 'sourceMeasurement', type: 'bytes32' },
] as const;

export function decodeEnvelopePayload(value: Hex): {
  manifestHash: string;
  evidenceTier: 'self-signed' | 'committed' | 'attested' | 'unknown';
} {
  try {
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE_V2, value);
    return {
      manifestHash: decoded[2],
      evidenceTier: tierFromRaw(Number(decoded[1])),
    };
  } catch {
    // not V2 — try V1
  }
  try {
    const decoded = decodeAbiParameters(PAYLOAD_TUPLE_V1, value);
    return {
      manifestHash: decoded[2],
      evidenceTier: tierFromRaw(Number(decoded[1])),
    };
  } catch {
    return { manifestHash: '', evidenceTier: 'unknown' };
  }
}

// ── JinnRouter: TaskCreated ───────────────────────────────────────────────────

export async function handleTaskCreated({
  event,
  context,
  task,
}: {
  event: TaskCreatedEvent;
  context: HandlerContext;
  task: unknown;
}): Promise<void> {
  await context.db
    .insert(task)
    .values({
      id: event.args.taskId.toString(),
      manifestDigest: event.args.manifestDigest,
      taskCidDigest: event.args.taskCidDigest,
      creator: event.args.creator,
      maxClaims: Number(event.args.maxClaims),
      requiredVerdicts: Number(event.args.requiredVerdicts ?? 0),
      createdAtBlock: event.block.number,
      createdAtTx: event.transaction.hash,
      // claimWindowStart and claimWindowEnd are not emitted in TaskCreated on
      // JinnRouter V3 — they require call-trace decoding (280n.4). Left null.
      claimWindowStart: null,
      claimWindowEnd: null,
      finalized: false,
      refunded: false,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}

// ── JinnRouter: TaskAttemptCreated ───────────────────────────────────────────

export async function handleTaskAttemptCreated({
  event,
  context,
  attempt,
}: {
  event: TaskAttemptCreatedEvent;
  context: HandlerContext;
  attempt: unknown;
}): Promise<void> {
  await context.db
    .insert(attempt)
    .values({
      taskId: event.args.taskId.toString(),
      attemptIndex: Number(event.args.attemptIndex),
      requestId: event.args.requestId,
      operator: event.args.operator,
      priorityMech: event.args.priorityMech,
      deliveryRate: event.args.deliveryRate,
      createdAtBlock: event.block.number,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}

// ── JinnRouter: VerdictDeliveryClaimed → verdict ─────────────────────────────
// One row per delivered verdict. verdictCode 0..4 per the VerdictCode enum.
// Idempotent: a replayed event with the same (taskId, attemptIndex, verdictIndex,
// chainId) does not clobber the original.
export async function handleVerdictDeliveryClaimed({
  event,
  context,
  verdict,
}: {
  event: VerdictDeliveryClaimedEvent;
  context: HandlerContext;
  verdict: unknown;
}): Promise<void> {
  await context.db
    .insert(verdict)
    .values({
      taskId: event.args.taskId.toString(),
      attemptIndex: Number(event.args.attemptIndex),
      verdictIndex: Number(event.args.verdictIndex),
      evaluator: event.args.evaluator,
      requestId: event.args.requestId,
      verdictCode: Number(event.args.verdictCode),
      createdAtBlock: event.block.number,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();
}

// ── JinnRouter: SolutionDeliveryClaimed ──────────────────────────────────────
// Used as a proxy for task finalization. JinnRouter V3 has no standalone
// TaskFinalized event; SolutionDeliveryClaimed is the terminal success state.
//
// Existence guard: the matching TaskCreated may predate `startBlock` (or, in a
// future multi-chain config, live on a chain this indexer doesn't cover), in
// which case there is no `task` row. `db.update` on a missing row throws and
// crashes the indexer — so look it up first and skip if absent. The daemon's
// canClaimTask simulation is the correctness gate regardless.
export async function handleSolutionDeliveryClaimed({
  event,
  context,
  task,
}: {
  event: SolutionDeliveryClaimedEvent;
  context: HandlerContext;
  task: unknown;
}): Promise<void> {
  const id = event.args.taskId.toString();
  const existing = await context.db.find(task, { id });
  if (!existing) return;
  await context.db.update(task, { id }).set({ finalized: true });
}

// ── IdentityRegistry: MetadataSet ────────────────────────────────────────────
// Routes by key prefix:
//   solvernet-manifest:<cid>  → upsert SolverNetManifest (most-recent-wins)
//   envelope:<cid>            → upsert Envelope
//   evaluation:<cid>          → upsert Envelope
//   capture:<cid>             → upsert Envelope

export async function handleMetadataSet({
  event,
  context,
  solverNetManifest,
  envelope,
}: {
  event: MetadataSetEvent;
  context: HandlerContext;
  solverNetManifest: unknown;
  envelope: unknown;
}): Promise<void> {
  const key = event.args.metadataKey;
  const agentId = event.args.agentId.toString();
  const chainId = context.chain.id;
  const blockNumber = event.block.number;

  // ── SolverNet manifest lifecycle ─────────────────────────────────────────
  const manifestCid = parseSolverNetManifestKey(key);
  if (manifestCid !== null) {
    // Decode the lifecycle payload. The payload is JSON-encoded UTF-8 bytes
    // following the most-recent-wins spec (§6.3):
    //   { schemaVersion, status, at, hash }
    let status: 'launched' | 'paused' | 'retired' = 'launched';
    let statusUpdatedAt = new Date().toISOString();
    let manifestHash: `0x${string}` = '0x';
    let transactionIndex = 0;
    const logIndex = typeof event.log.logIndex === 'number' ? event.log.logIndex : 0;

    try {
      const payloadText = Buffer.from(event.args.metadataValue.slice(2), 'hex').toString('utf8');
      const payload = JSON.parse(payloadText) as {
        status?: string;
        at?: string;
        hash?: string;
        schemaVersion?: string;
      };
      if (payload.status === 'launched' || payload.status === 'paused' || payload.status === 'retired') {
        status = payload.status;
      }
      if (payload.at) statusUpdatedAt = payload.at;
      if (payload.hash && /^0x[0-9a-fA-F]{64}$/.test(payload.hash)) {
        manifestHash = payload.hash as `0x${string}`;
      }
      if (typeof event.transaction.transactionIndex === 'number') {
        transactionIndex = event.transaction.transactionIndex;
      }
    } catch {
      // Non-JSON payload — skip this event; it's not a valid lifecycle update.
      return;
    }

    // Most-recent-wins upsert: only update if the new event is more recent than
    // the stored one, ordered by (block, transactionIndex, logIndex). Including
    // logIndex makes two lifecycle updates in the same transaction resolve
    // deterministically (later log wins) instead of tiebreaking arbitrarily.
    await context.db
      .insert(solverNetManifest)
      .values({
        id: manifestCid,
        launcherAgentId: agentId,
        status,
        statusUpdatedAt,
        manifestHash,
        anchorBlock: blockNumber,
        anchorTransactionIndex: transactionIndex,
        anchorLogIndex: logIndex,
        chainId,
      })
      .onConflictDoUpdate((row) => {
        // Only update if the incoming event is more recent than the stored one.
        //
        // IMPORTANT: Drizzle's onConflictDoUpdate generates `ON CONFLICT DO UPDATE
        // SET col1 = val1, col2 = val2, ...`. Returning `{}` here would produce an
        // empty SET clause which is invalid SQL on Postgres/PGlite. The no-op path
        // must return all existing row fields so Drizzle generates a valid
        // `SET col = col, ...` statement — semantically a no-op, syntactically valid.
        const incomingIsNewer =
          blockNumber > row.anchorBlock ||
          (blockNumber === row.anchorBlock && transactionIndex > row.anchorTransactionIndex) ||
          (blockNumber === row.anchorBlock &&
            transactionIndex === row.anchorTransactionIndex &&
            logIndex > row.anchorLogIndex);
        if (incomingIsNewer) {
          return {
            launcherAgentId: agentId,
            status,
            statusUpdatedAt,
            manifestHash,
            anchorBlock: blockNumber,
            anchorTransactionIndex: transactionIndex,
            anchorLogIndex: logIndex,
            chainId,
          };
        }
        // No-op: return existing row fields so Drizzle generates valid SQL.
        // (SET col = col, ... is a valid no-op; SET with empty SET clause is not.)
        return {
          launcherAgentId: row.launcherAgentId,
          status: row.status,
          statusUpdatedAt: row.statusUpdatedAt,
          manifestHash: row.manifestHash,
          anchorBlock: row.anchorBlock,
          anchorTransactionIndex: row.anchorTransactionIndex,
          anchorLogIndex: row.anchorLogIndex,
          chainId: row.chainId,
        };
      });
    return;
  }

  // ── Envelope (evidence / evaluation / capture) ───────────────────────────
  const envelopeKey = parseEnvelopeKey(key);
  if (envelopeKey !== null) {
    const payload = decodeEnvelopePayload(event.args.metadataValue as Hex);
    const logIndex = typeof event.log.logIndex === 'number' ? event.log.logIndex : 0;

    // Guard against empty manifestHash from total decode failures.
    // `decodeEnvelopePayload` returns `manifestHash: ''` when both V2 and V1
    // decode attempts throw. An empty string is not a valid hex value and would
    // fail the `hex()` column constraint at runtime. Substitute `'0x'` (a valid
    // zero-length hex sentinel) so the row is written and the event is not lost.
    // The daemon compensates: canClaimTask and corpus-fetch verify content via
    // the IPFS manifest hash independently of this indexed copy.
    const manifestHash = (payload.manifestHash || '0x') as `0x${string}`;

    await context.db
      .insert(envelope)
      .values({
        agentId,
        metadataKey: key,
        chainId,
        kind: envelopeKey.kind,
        manifestCid: envelopeKey.cid,
        manifestHash,
        evidenceTier: payload.evidenceTier,
        publishedAtBlock: blockNumber,
        logIndex,
      })
      .onConflictDoUpdate((row) => {
        // Most-recent-wins: if the same agent re-publishes to the same key,
        // keep the later event ordered by (publishedAtBlock, logIndex). Two
        // MetadataSet events in the same block must compare logIndex so they
        // resolve deterministically (later log wins) rather than letting the
        // unconditional update clobber a newer row with an older one.
        //
        // The no-op branch returns existing row fields so Drizzle emits a valid
        // `SET col = col, ...` rather than an empty SET clause.
        const incomingIsNewer =
          blockNumber > row.publishedAtBlock ||
          (blockNumber === row.publishedAtBlock && logIndex >= row.logIndex);
        if (incomingIsNewer) {
          return {
            manifestHash,
            evidenceTier: payload.evidenceTier,
            publishedAtBlock: blockNumber,
            logIndex,
          };
        }
        return {
          manifestHash: row.manifestHash,
          evidenceTier: row.evidenceTier,
          publishedAtBlock: row.publishedAtBlock,
          logIndex: row.logIndex,
        };
      });
    return;
  }

  // Any other key (e.g. future metadata types) — no-op.
}
