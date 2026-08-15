/**
 * The bridge's `fetchEvidence` adapter (spec/2026-07-06-distillation-v1.md §8, D5).
 *
 * Implements the VERIFIED verdict→solution join that reaches
 * the SOLVER's coding patch — the reference implementation is `fetchEvidence` in
 * operator/scripts/distill-run-live.ts:
 *
 *   verdict(ref.requestId, ref.chainId) → authoritative (taskId, attemptIndex, evaluator)
 *     + bounded verdictEnvelopeMeta candidates → historical publisher,
 *       participant, signed-hash, request, and polarity binding
 *     → authenticated evaluation wrapper → signed original task CID
 *     → TaskCreated task-CID / creator / manifest commitments
 *     → authenticated original task (description + verifier facts)
 *     → attempt(taskId, attemptIndex, chainId) → the SOLVE request
 *     → bounded attemptEnvelopeMeta candidates → publisher + signed-hash binding
 *     → authenticated solution envelope (IPFS) → .payload.patch (the coding diff)
 *   problem statement = authenticated original task description
 *   typed history (hop 4, best-effort, #1472/#1473) = the solution's system_snapshot
 *     artifact → donation unwrap → gunzip+untar → the harness stdout
 *     transcript → canonical core stream parser → typed trajectory spans
 *
 * The predecessor selected the solution with the task document's mutable
 * `restorationRequestId`. That allowed an otherwise-valid signed task to be
 * relabelled onto another solution. The selection path now comes exclusively
 * from chain-indexed verdict + attempt rows. Any outer task copy is only a
 * consistency assertion and can never select the patch.
 *
 * All I/O and authentication boundaries are injected ports so this stays
 * unit-testable. Production uses the Autonolas gateway, Ponder GraphQL,
 * canonical envelope verification, and an IdentityRegistry wallet read; tests
 * inject fakes. The returned function is directly usable as
 * `BridgeDeps.fetchEvidence`.
 */

import { type AttemptRef, type BridgeEvidence } from './bridge.js';
import {
  extractSnapshotTranscript,
  parseSolveTranscript,
} from './snapshot-transcript.js';

/** Cap the fetched patch / problem so one huge diff does not blow the prompt. */
const MAX_PATCH_CHARS = 6000;
const MAX_PROBLEM_CHARS = 1500;
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string =>
    typeof item === 'string' && item.length > 0);
  return strings.length === value.length ? strings : undefined;
}

function generatorModel(value: unknown): BridgeEvidence['generatorModel'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = nonEmptyString(raw['id']);
  const source = raw['source'];
  if (!id || (source !== 'stream' && source !== 'config')) return undefined;
  const provider = nonEmptyString(raw['provider']);
  const openWeights = typeof raw['openWeights'] === 'boolean'
    ? raw['openWeights']
    : undefined;
  return {
    id,
    source,
    ...(provider ? { provider } : {}),
    ...(openWeights !== undefined ? { openWeights } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface AuthenticatedExecutionEnvelope {
  solverType: string;
  role: 'solution' | 'verdict' | 'capture' | 'restoration';
  task?: unknown;
  participant: {
    safeAddress: string;
    agentEoa: string;
  };
  signature: {
    hash: string;
    signer: string;
    sig: string;
    algo: string;
  };
  payload: Record<string, unknown>;
  executor?: unknown;
  artifacts?: unknown[];
  distributionClass?: 'open' | 'restricted-tos' | 'unknown';
}

export type ExecutionEnvelopeAuthenticator = (
  value: unknown,
  sourceName: string,
) => Promise<AuthenticatedExecutionEnvelope>;

export type PublisherSafeResolver = (
  chainId: number,
  publisherAgentId: string,
  publishedAtBlock: bigint,
) => Promise<string>;

function exactAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} must be an exact 20-byte address`);
  }
  return value.toLowerCase();
}

function exactHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be an exact bytes32 hash`);
  }
  return value.toLowerCase();
}

function exactAgentId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive decimal agent id`);
  }
  return value;
}

function exactBlockNumber(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive decimal block number`);
  }
  return BigInt(value);
}

function assertAuthenticatedEnvelopeKind(
  envelope: AuthenticatedExecutionEnvelope,
  sourceName: string,
  expectedRole: 'solution' | 'verdict',
): void {
  if (envelope.role !== expectedRole) {
    throw new Error(`${sourceName}.role must be exactly ${expectedRole}`);
  }
  if (envelope.solverType === undefined) {
    throw new Error(`${sourceName}.solverType requires exact authenticated task provenance`);
  }
  if (envelope.solverType !== 'swe-rebench-v2.v1') {
    throw new Error(`${sourceName}.solverType must be exactly swe-rebench-v2.v1`);
  }
}

async function assertEnvelopeAuthority(args: {
  envelope: AuthenticatedExecutionEnvelope;
  sourceName: 'verdict envelope' | 'solution envelope';
  expectedSafe: string;
  publisherAgentId: string;
  publishedAtBlock: bigint;
  manifestHash: string;
  chainId: number;
  resolvePublisherSafe: PublisherSafeResolver;
  onchainRole: 'evaluator' | 'operator';
}): Promise<void> {
  const participantSafe = exactAddress(
    record(args.envelope['participant'])?.['safeAddress'],
    `${args.sourceName} participant.safeAddress`,
  );
  if (participantSafe !== args.expectedSafe) {
    throw new Error(
      `${args.sourceName} participant Safe does not match on-chain ${args.onchainRole}`,
    );
  }
  const publisherSafe = exactAddress(
    await args.resolvePublisherSafe(
      args.chainId,
      args.publisherAgentId,
      args.publishedAtBlock,
    ),
    `${args.sourceName} publisher Safe`,
  );
  if (publisherSafe !== args.expectedSafe) {
    throw new Error(
      `${args.sourceName} publisher does not match on-chain ${args.onchainRole}`,
    );
  }
  const signedHash = exactHash(
    record(args.envelope['signature'])?.['hash'],
    `${args.sourceName} signature.hash`,
  );
  if (signedHash !== args.manifestHash) {
    throw new Error(
      `${args.sourceName} signature hash does not match its MetadataSet manifest hash`,
    );
  }
}

function hasExactSweTaskType(taskDoc: unknown): boolean {
  const outer = record(taskDoc);
  const task = record(outer?.['signedTask']) ?? outer;
  return task?.['solverType'] === 'swe-rebench-v2.v1';
}

export interface AuthenticatedTaskProvenance {
  solverType: string;
  instanceId: string;
  repo: string;
  baseCommit: string;
  createdAt: number;
  originalTaskCid: string;
  creatorSafe: string;
  manifestDigest: string;
  description: string;
}

export interface AuthoritativeTaskBinding {
  taskId: string;
  chainId: number;
  taskCidDigest: string;
  manifestDigest: string;
  creatorSafe: string;
  evaluatorSafe: string;
}

export interface VerifierFacts {
  failToPass: string[];
  passToPass: string[];
  evalSemanticsVersion: string;
  task: AuthenticatedTaskProvenance;
}

export type VerifierFactsResolver = (
  taskDoc: unknown,
  expectedInstanceId: string,
  authority: AuthoritativeTaskBinding,
) => Promise<unknown>;

function validateVerifierFacts(value: unknown, instanceId: string): VerifierFacts {
  const facts = record(value);
  if (!facts) {
    throw new Error(`authenticated verifier facts for ${instanceId} must be an object`);
  }
  const failToPass = stringArray(facts['failToPass']);
  const passToPass = stringArray(facts['passToPass']);
  const evalSemanticsVersion = nonEmptyString(facts['evalSemanticsVersion']);
  if (!failToPass || !passToPass || !evalSemanticsVersion) {
    throw new Error(
      `authenticated verifier facts for ${instanceId} require exact failToPass, passToPass, and evalSemanticsVersion`,
    );
  }
  const rawTask = record(facts['task']);
  const solverType = rawTask?.['solverType'];
  const authenticatedInstanceId = nonEmptyString(rawTask?.['instanceId']);
  const repo = nonEmptyString(rawTask?.['repo']);
  const baseCommit = nonEmptyString(rawTask?.['baseCommit']);
  const createdAt = rawTask?.['createdAt'];
  const originalTaskCid = nonEmptyString(rawTask?.['originalTaskCid']);
  const creatorSafe = exactAddress(
    rawTask?.['creatorSafe'],
    `authenticated verifier facts for ${instanceId} task.creatorSafe`,
  );
  const manifestDigest = exactHash(
    rawTask?.['manifestDigest'],
    `authenticated verifier facts for ${instanceId} task.manifestDigest`,
  );
  const description = nonEmptyString(rawTask?.['description']);
  if (
    solverType !== 'swe-rebench-v2.v1'
    || !authenticatedInstanceId
    || !repo
    || !baseCommit
    || !originalTaskCid
    || !description
    || !Number.isInteger(createdAt)
    || (createdAt as number) < 0
  ) {
    throw new Error(
      `authenticated verifier facts for ${instanceId} require an exact task provenance tuple`,
    );
  }
  return {
    failToPass,
    passToPass,
    evalSemanticsVersion,
    task: {
      solverType,
      instanceId: authenticatedInstanceId,
      repo,
      baseCommit,
      createdAt: createdAt as number,
      originalTaskCid,
      creatorSafe,
      manifestDigest,
      description,
    },
  };
}

function assertExactEnvelopeTaskProvenance(
  sourceName: string,
  value: unknown,
  authenticated: AuthenticatedTaskProvenance,
): void {
  const envelope = record(value);
  if (!envelope) {
    throw new Error(`${sourceName} requires exact authenticated task provenance`);
  }
  const solverType = envelope['solverType'];
  if (solverType === undefined) {
    throw new Error(`${sourceName}.solverType requires exact authenticated task provenance`);
  }
  if (solverType !== authenticated.solverType) {
    throw new Error(
      `authenticated task provenance mismatch at ${sourceName}.solverType: `
      + `expected ${JSON.stringify(authenticated.solverType)}, got ${JSON.stringify(solverType)}`,
    );
  }

  const source = record(envelope['task']);
  if (!source) {
    throw new Error(`${sourceName}.task requires exact authenticated task provenance`);
  }
  for (const field of [
    'instanceId',
    'repo',
    'baseCommit',
  ] as const) {
    const candidate = source[field];
    if (candidate !== undefined && candidate !== authenticated[field]) {
      throw new Error(
        `authenticated task provenance mismatch at ${sourceName}.${field}: `
        + `expected ${JSON.stringify(authenticated[field])}, got ${JSON.stringify(candidate)}`,
      );
    }
  }
}

function assertEnvelopeRequestId(
  sourceName: string,
  value: unknown,
  expectedRequestId: string,
): void {
  const task = record(record(value)?.['task']);
  const requestId = nonEmptyString(task?.['requestId']);
  if (!requestId || requestId.toLowerCase() !== expectedRequestId.toLowerCase()) {
    throw new Error(
      `${sourceName}.task.requestId must match authoritative requestId ${expectedRequestId}`,
    );
  }
}

function exactItems(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const items = record(value)?.['items'];
  if (!Array.isArray(items) || items.length !== 1 || !record(items[0])) {
    throw new Error(
      `expected exactly one ${label} row; found ${Array.isArray(items) ? items.length : 0}`,
    );
  }
  return record(items[0])!;
}

const MAX_METADATA_PAGES = 20;

async function* walkMetadataCandidatePages(
  label: string,
  fetchPage: (after: string | null) => Promise<unknown>,
): AsyncGenerator<Record<string, unknown>[]> {
  let candidateCount = 0;
  let after: string | null = null;
  for (let page = 0; page < MAX_METADATA_PAGES; page += 1) {
    const value = record(await fetchPage(after));
    const items = value?.['items'];
    if (!Array.isArray(items)) {
      throw new Error(`${label} page ${page + 1} has no items array`);
    }
    const candidates = items.flatMap((item) => {
      const parsed = record(item);
      return parsed ? [parsed] : [];
    });
    const pageInfo = record(value?.['pageInfo']);
    if (!pageInfo || typeof pageInfo['hasNextPage'] !== 'boolean') {
      throw new Error(`${label} page ${page + 1} has malformed pageInfo`);
    }
    candidateCount += candidates.length;
    yield candidates;
    if (pageInfo['hasNextPage'] === false) {
      if (candidateCount === 0) {
        throw new Error(`expected at least one ${label} row; found 0`);
      }
      return;
    }
    const endCursor = pageInfo['endCursor'];
    if (typeof endCursor !== 'string' || endCursor.length === 0) {
      throw new Error(`${label} page ${page + 1} has no continuation cursor`);
    }
    after = endCursor;
  }
  throw new Error(
    `incomplete ${label} walk after ${MAX_METADATA_PAGES} pages`,
  );
}

const AUTHORITATIVE_VERDICT_QUERY = `
query AuthoritativeVerdict($requestId: String!, $chainId: Int!) {
  verdicts(
    where: { requestId: $requestId, chainId: $chainId },
    limit: 2
  ) {
    items { requestId chainId taskId attemptIndex evaluator }
  }
}
`;

const AUTHORITATIVE_TASK_QUERY = `
query AuthoritativeTask($taskId: String!, $chainId: Int!) {
  tasks(
    where: { id: $taskId, chainId: $chainId },
    limit: 2
  ) {
    items { id chainId taskCidDigest manifestDigest creator }
  }
}
`;

const VERDICT_ENVELOPE_META_CANDIDATES_QUERY = `
query AuthoritativeVerdictEnvelopeMetaCandidates(
  $requestId: String!
  $chainId: Int!
  $manifestCid: String!
  $after: String
) {
  verdictEnvelopeMetas(
    where: {
      requestId: $requestId
      chainId: $chainId
      manifestCid: $manifestCid
    },
    orderBy: "enrichedAtBlock"
    orderDirection: "desc"
    limit: 1000
    after: $after
  ) {
    items { requestId chainId manifestCid publisherAgentId manifestHash enrichedAtBlock }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const AUTHORITATIVE_ATTEMPT_QUERY = `
query AuthoritativeAttempt($taskId: String!, $attemptIndex: Int!, $chainId: Int!) {
  attempts(
    where: { taskId: $taskId, attemptIndex: $attemptIndex, chainId: $chainId },
    limit: 2
  ) {
    items { requestId chainId taskId attemptIndex operator }
  }
}
`;

const SOLUTION_ENVELOPE_META_CANDIDATES_QUERY = `
query SolutionEnvelopeMetaCandidates($requestId: String!, $chainId: Int!, $after: String) {
  attemptEnvelopeMetas(
    where: { requestId: $requestId, chainId: $chainId },
    orderBy: "enrichedAtBlock"
    orderDirection: "desc"
    limit: 1000
    after: $after
  ) {
    items { requestId chainId manifestCid publisherAgentId manifestHash enrichedAtBlock }
    pageInfo { hasNextPage endCursor }
  }
}
`;

export interface EvidenceFetcherPorts {
  /**
   * Fetch + JSON-parse an IPFS object by CID (autonolas gateway in production).
   * Callers that authenticate smaller artifacts may request a tighter ceiling.
   */
  ipfs: (cid: string, maxBytes?: number) => Promise<any>;
  /** Run a GraphQL query against the Ponder indexer, returning `data`. */
  gql: (query: string, variables?: Record<string, unknown>) => Promise<any>;
  /** Parse and cryptographically authenticate one raw execution envelope. */
  authenticateEnvelope: ExecutionEnvelopeAuthenticator;
  /** Resolve the Safe owned by an ERC-8004 publisher agent at the event block. */
  resolvePublisherSafe: PublisherSafeResolver;
  /** Resolve one atomic, authenticated verifier proof for an identified SWE task. */
  resolveVerifierFacts?: VerifierFactsResolver;
}

/**
 * Fetch + parse the solver's reasoning for one solution envelope (§8, #1472).
 *
 * The decision path does NOT live in `jinn.trajectory.v1` (that carries only
 * the packaging step's 2 `jinn.artifact.emit` spans — #1473 tracks making it
 * truthful at solve time). It lives in the `system_snapshot` artifact: a
 * donation-wrapped gzipped tar of the solve working dir containing the
 * harness's raw stdout transcript. Resolve that artifact, unwrap (sha256-
 * verified), decompress (bomb-guarded), locate the transcript, and parse it
 * with the same canonical typed-span implementation as the live path.
 *
 * Best-effort: ANY failure (no snapshot, unresolvable CID, sha mismatch,
 * corrupt bytes, no transcript — e.g. hermes) degrades to `undefined` — the
 * trace is enrichment, never a gate on the evidence fetch. Absence is later
 * recorded as a `patch-only` tag.
 */
async function fetchTrajectorySpans(
  ipfs: (cid: string) => Promise<any>,
  solutionEnv: any,
): Promise<BridgeEvidence['trajectorySpans']> {
  try {
    const arts = solutionEnv?.artifacts;
    if (!Array.isArray(arts)) return undefined;
    const snap = arts.find((a) => a?.artifactType === 'system_snapshot');
    const cid = snap?.sources?.[0]?.cid;
    const sha256 = typeof snap?.sha256 === 'string' ? snap.sha256 : snap?.sources?.[0]?.sha256;
    if (typeof cid !== 'string' || !cid || typeof sha256 !== 'string' || !sha256) return undefined;
    const wrapper = await ipfs(cid); // the donation wrapper is itself JSON
    const transcript = extractSnapshotTranscript(wrapper, sha256);
    if (!transcript) return undefined;
    const spans = parseSolveTranscript(transcript);
    return spans.length > 0 ? spans : undefined;
  } catch {
    return undefined;
  }
}

function rawSnapshotRef(solutionEnv: AuthenticatedExecutionEnvelope): string | undefined {
  const snapshot = solutionEnv.artifacts?.find((artifact) =>
    record(artifact)?.['artifactType'] === 'system_snapshot');
  const sources = record(snapshot)?.['sources'];
  return Array.isArray(sources)
    ? nonEmptyString(record(sources[0])?.['cid'])
    : undefined;
}

/**
 * Build the bridge's `fetchEvidence`. Consumes injected `ipfs` / `gql` ports
 * (fakes in tests; a gateway + indexer in production). Throws a clear error at
 * each missing hop so a per-instance miss is diagnosable and skipped, not silent.
 */
export function createEvidenceFetcher(
  ports: EvidenceFetcherPorts,
): (ref: AttemptRef) => Promise<BridgeEvidence> {
  type SelectedSolutionCandidate = {
    envelope: AuthenticatedExecutionEnvelope;
    patch: string;
    manifestCid: string;
  };
  const authoritativeVerdicts = new Map<string, Promise<unknown>>();
  const authoritativeTasks = new Map<string, Promise<unknown>>();
  const authoritativeAttempts = new Map<string, Promise<unknown>>();
  const selectedSolutions = new Map<string, Promise<SelectedSolutionCandidate>>();
  const cachedAuthority = (
    cache: Map<string, Promise<unknown>>,
    key: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> => {
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = ports.gql(query, variables);
    cache.set(key, pending);
    return pending;
  };
  return async (ref: AttemptRef): Promise<BridgeEvidence> => {
    if (!ref.verdictManifestCid) {
      throw new Error(`AttemptRef ${ref.instanceId} has no verdictManifestCid (join entry point)`);
    }
    if (!Number.isSafeInteger(ref.chainId) || ref.chainId <= 0) {
      throw new Error(`AttemptRef ${ref.instanceId} has invalid chainId ${ref.chainId}`);
    }

    // Hop 1a: the on-chain verdict row authoritatively identifies the task
    // attempt. A metadata envelope cannot choose a different task tuple.
    const verdictData = await cachedAuthority(
      authoritativeVerdicts,
      `${ref.chainId}:${ref.requestId.toLowerCase()}`,
      AUTHORITATIVE_VERDICT_QUERY,
      {
        requestId: ref.requestId,
        chainId: ref.chainId,
      },
    );
    const verdictRow = exactItems(
      record(verdictData)?.['verdicts'],
      'authoritative verdict',
    );
    const verdictRequestId = nonEmptyString(verdictRow['requestId']);
    const verdictChainId = verdictRow['chainId'];
    const taskId = nonEmptyString(verdictRow['taskId']);
    const attemptIndex = verdictRow['attemptIndex'];
    const evaluator = exactAddress(
      verdictRow['evaluator'],
      'authoritative verdict evaluator',
    );
    if (
      !verdictRequestId
      || verdictRequestId.toLowerCase() !== ref.requestId.toLowerCase()
      || verdictChainId !== ref.chainId
      || !taskId
      || !Number.isInteger(attemptIndex)
      || (attemptIndex as number) < 0
    ) {
      throw new Error('authoritative verdict row does not match the requested chain tuple');
    }

    // Hop 1b: retain the immutable TaskCreated commitments that the
    // authenticated evaluation wrapper and original restoration task must
    // prove. The evaluator-supplied task description is never authoritative.
    const taskData = await cachedAuthority(
      authoritativeTasks,
      `${ref.chainId}:${taskId}`,
      AUTHORITATIVE_TASK_QUERY,
      {
        taskId,
        chainId: ref.chainId,
      },
    );
    const taskRow = exactItems(
      record(taskData)?.['tasks'],
      'authoritative task',
    );
    const taskCidDigest = exactHash(
      taskRow['taskCidDigest'],
      'authoritative task taskCidDigest',
    );
    const manifestDigest = exactHash(
      taskRow['manifestDigest'],
      'authoritative task manifestDigest',
    );
    const creatorSafe = exactAddress(
      taskRow['creator'],
      'authoritative task creator',
    );
    if (taskRow['id'] !== taskId || taskRow['chainId'] !== ref.chainId) {
      throw new Error('authoritative task row does not match the verdict task tuple');
    }
    const taskAuthority: AuthoritativeTaskBinding = {
      taskId,
      chainId: ref.chainId,
      taskCidDigest,
      manifestDigest,
      creatorSafe,
      evaluatorSafe: evaluator,
    };

    // Hop 1c: a request can have many enrichment rows because MetadataSet is
    // permissionless. Walk a finite, newest-first candidate set and accept
    // only a cryptographically authenticated envelope whose historical
    // publisher, participant, committed hash, request, and polarity all bind
    // to the authoritative verdict. The ref CID is only a discovery seed.
    const verdictMetaPages = walkMetadataCandidatePages(
      'verdict envelope metadata',
      async (after) => record(await ports.gql(
        VERDICT_ENVELOPE_META_CANDIDATES_QUERY,
        {
          requestId: ref.requestId,
          chainId: ref.chainId,
          manifestCid: ref.verdictManifestCid!,
          after,
        },
      ))?.['verdictEnvelopeMetas'],
    );
    let selectedVerdict:
      | {
          envelope: AuthenticatedExecutionEnvelope;
          evaluationTaskCid: string;
          manifestCid: string;
        }
      | undefined;
    let lastVerdictCandidateError: unknown;
    for await (const verdictMetaRows of verdictMetaPages) {
      for (const metaRow of verdictMetaRows) {
        try {
          const cid = nonEmptyString(metaRow['manifestCid']);
          const publisherAgentId = exactAgentId(
            metaRow['publisherAgentId'],
            'verdict envelope publisherAgentId',
          );
          const candidateManifestHash = exactHash(
            metaRow['manifestHash'],
            'verdict envelope manifestHash',
          );
          const publishedAtBlock = exactBlockNumber(
            metaRow['enrichedAtBlock'],
            'verdict envelope enrichedAtBlock',
          );
          if (
            !cid
            || nonEmptyString(metaRow['requestId'])?.toLowerCase()
              !== ref.requestId.toLowerCase()
            || metaRow['chainId'] !== ref.chainId
          ) {
            throw new Error(
              'verdict envelope metadata row does not match the requested chain tuple',
            );
          }
          const publisherSafe = exactAddress(
            await ports.resolvePublisherSafe(
              ref.chainId,
              publisherAgentId,
              publishedAtBlock,
            ),
            'verdict envelope publisher Safe',
          );
          if (publisherSafe !== evaluator) {
            throw new Error(
              'verdict envelope publisher does not match on-chain evaluator',
            );
          }
          const envelope = await ports.authenticateEnvelope(
            await ports.ipfs(cid),
            'verdictEnvelope',
          );
          assertAuthenticatedEnvelopeKind(envelope, 'verdictEnvelope', 'verdict');
          const evaluationTaskCid = nonEmptyString(record(envelope['task'])?.['cid']);
          if (!evaluationTaskCid) {
            throw new Error(`no task.cid on verdict envelope ${cid}`);
          }
          await assertEnvelopeAuthority({
            envelope,
            sourceName: 'verdict envelope',
            expectedSafe: evaluator,
            publisherAgentId,
            publishedAtBlock,
            manifestHash: candidateManifestHash,
            chainId: ref.chainId,
            resolvePublisherSafe: ports.resolvePublisherSafe,
            onchainRole: 'evaluator',
          });
          assertEnvelopeRequestId('verdictEnvelope', envelope, ref.requestId);
          const signedPassed = record(envelope['payload'])?.['passed_match'];
          if (typeof signedPassed !== 'boolean') {
            throw new Error('verdictEnvelope.payload.passed_match must be an exact boolean');
          }
          if ((signedPassed ? 'pass' : 'fail') !== ref.polarity) {
            throw new Error('signed verdict polarity does not match the indexed candidate');
          }
          selectedVerdict = { envelope, evaluationTaskCid, manifestCid: cid };
          break;
        } catch (error) {
          lastVerdictCandidateError = error;
        }
      }
      if (selectedVerdict) break;
    }
    if (!selectedVerdict) {
      const reason = lastVerdictCandidateError instanceof Error
        ? `: ${lastVerdictCandidateError.message}`
        : '';
      throw new Error(
        `no authenticated verdict envelope metadata candidate matched the on-chain evaluator${reason}`,
      );
    }
    const verdictEnv = selectedVerdict.envelope;

    // Hop 2a: the chain attempt row supplies the SOLVE request id. This is the
    // only value allowed to select a solution envelope.
    const attemptData = await cachedAuthority(
      authoritativeAttempts,
      `${ref.chainId}:${taskId}:${String(attemptIndex)}`,
      AUTHORITATIVE_ATTEMPT_QUERY,
      {
        taskId,
        attemptIndex,
        chainId: ref.chainId,
      },
    );
    const attemptRow = exactItems(
      record(attemptData)?.['attempts'],
      'authoritative attempt',
    );
    const solveReq = nonEmptyString(attemptRow['requestId']);
    const operator = exactAddress(
      attemptRow['operator'],
      'authoritative attempt operator',
    );
    if (
      !solveReq
      || attemptRow['chainId'] !== ref.chainId
      || attemptRow['taskId'] !== taskId
      || attemptRow['attemptIndex'] !== attemptIndex
    ) {
      throw new Error('authoritative attempt row does not match the verdict task tuple');
    }

    // Hop 2b: fetch the evaluator-signed wrapper. The verifier resolver must
    // authenticate it, extract its signed original-task CID, and prove that
    // original task against taskAuthority before any task fact is consumed.
    const taskDoc = await ports.ipfs(selectedVerdict.evaluationTaskCid);
    const outerTaskForRequestBinding = record(taskDoc);
    const signedTaskForRequestBinding = record(outerTaskForRequestBinding?.['signedTask']);
    for (const [sourceName, candidate] of [
      ['mutable task', outerTaskForRequestBinding?.['restorationRequestId']],
      ['signed task', signedTaskForRequestBinding?.['restorationRequestId']],
    ] as const) {
      if (candidate === undefined) continue;
      const requestId = nonEmptyString(candidate);
      if (!requestId || requestId.toLowerCase() !== solveReq.toLowerCase()) {
        throw new Error(
          `${sourceName} restorationRequestId does not match `
          + `authoritative solution requestId ${solveReq}`,
        );
      }
    }

    // Hop 2c: authenticate the retained solution candidates in the same
    // bounded way, selecting only the one bound to the historical operator.
    const solutionMetadataKey = `${ref.chainId}:${solveReq.toLowerCase()}`;
    let selectedSolutionPromise = selectedSolutions.get(solutionMetadataKey);
    if (!selectedSolutionPromise) {
      selectedSolutionPromise = (async (): Promise<SelectedSolutionCandidate> => {
        let lastSolutionCandidateError: unknown;
        const metaPages = walkMetadataCandidatePages(
          'solution envelope metadata',
          async (after) => record(await ports.gql(
            SOLUTION_ENVELOPE_META_CANDIDATES_QUERY,
            {
              requestId: solveReq,
              chainId: ref.chainId,
              after,
            },
          ))?.['attemptEnvelopeMetas'],
        );
        for await (const metaRows of metaPages) {
          for (const metaRow of metaRows) {
            try {
              const cid = nonEmptyString(metaRow['manifestCid']);
              const publisherAgentId = exactAgentId(
                metaRow['publisherAgentId'],
                'solution envelope publisherAgentId',
              );
              const candidateManifestHash = exactHash(
                metaRow['manifestHash'],
                'solution envelope manifestHash',
              );
              const publishedAtBlock = exactBlockNumber(
                metaRow['enrichedAtBlock'],
                'solution envelope enrichedAtBlock',
              );
              if (
                !cid
                || nonEmptyString(metaRow['requestId'])?.toLowerCase()
                  !== solveReq.toLowerCase()
                || metaRow['chainId'] !== ref.chainId
              ) {
                throw new Error(
                  'solution envelope metadata row does not match the authoritative attempt',
                );
              }
              const publisherSafe = exactAddress(
                await ports.resolvePublisherSafe(
                  ref.chainId,
                  publisherAgentId,
                  publishedAtBlock,
                ),
                'solution envelope publisher Safe',
              );
              if (publisherSafe !== operator) {
                throw new Error(
                  'solution envelope publisher does not match on-chain operator',
                );
              }
              const envelope = await ports.authenticateEnvelope(
                await ports.ipfs(cid),
                'solutionEnvelope',
              );
              assertAuthenticatedEnvelopeKind(envelope, 'solutionEnvelope', 'solution');
              await assertEnvelopeAuthority({
                envelope,
                sourceName: 'solution envelope',
                expectedSafe: operator,
                publisherAgentId,
                publishedAtBlock,
                manifestHash: candidateManifestHash,
                chainId: ref.chainId,
                resolvePublisherSafe: ports.resolvePublisherSafe,
                onchainRole: 'operator',
              });
              assertEnvelopeRequestId('solutionEnvelope', envelope, solveReq);
              const candidatePatch = record(envelope['payload'])?.['patch'];
              if (!candidatePatch || typeof candidatePatch !== 'string') {
                throw new Error(`no payload.patch on solution envelope ${cid}`);
              }
              return { envelope, patch: candidatePatch, manifestCid: cid };
            } catch (error) {
              lastSolutionCandidateError = error;
            }
          }
        }
        const reason = lastSolutionCandidateError instanceof Error
          ? `: ${lastSolutionCandidateError.message}`
          : '';
        throw new Error(
          `no authenticated solution envelope metadata candidate matched the on-chain operator${reason}`,
        );
      })();
      selectedSolutions.set(solutionMetadataKey, selectedSolutionPromise);
    }
    const selectedSolution = await selectedSolutionPromise;
    const solutionEnv = selectedSolution.envelope;
    const patch = selectedSolution.patch;

    // Hop 3 (best-effort, §8 v0.5): the solver's own trajectory off the SAME
    // solution envelope. Never throws — absence is recorded as `patch-only`.
    const trajectorySpans = await fetchTrajectorySpans(ports.ipfs, solutionEnv);
    const snapshotRef = rawSnapshotRef(solutionEnv);

    const outerTaskDocument = record(taskDoc) ?? {};
    const signedTaskDocument =
      record(outerTaskDocument['signedTask']) ?? outerTaskDocument;
    const signedTaskSpec = record(signedTaskDocument['spec']) ?? {};
    const problem = String(
      signedTaskDocument['description']
      ?? signedTaskSpec['problem_statement']
      ?? '',
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PROBLEM_CHARS);
    let verifier: VerifierFacts | undefined;
    if (ports.resolveVerifierFacts) {
      if (!hasExactSweTaskType(taskDoc)) {
        throw new Error(
          `verifier resolution for ${ref.instanceId} requires an exact swe-rebench-v2.v1 task type`,
        );
      }
      verifier = validateVerifierFacts(
        await ports.resolveVerifierFacts(taskDoc, ref.instanceId, taskAuthority),
        ref.instanceId,
      );
    } else if (hasExactSweTaskType(taskDoc)) {
      throw new Error(
        `identified SWE task ${ref.instanceId} requires authenticated verifier facts`,
      );
    }

    if (verifier) {
      // Execution-envelope task.createdAt is the on-chain TaskCreated block
      // timestamp (epoch seconds), while the authenticated tuple carries the
      // signed TaskV1 creation time (epoch milliseconds). They are distinct
      // events, so envelope createdAt is deliberately ignored rather than
      // compared or allowed to override the authenticated signed-task value.
      assertExactEnvelopeTaskProvenance('verdictEnvelope', verdictEnv, verifier.task);
      assertExactEnvelopeTaskProvenance('solutionEnvelope', solutionEnv, verifier.task);
      if (verifier.task.creatorSafe !== creatorSafe) {
        throw new Error(
          'authenticated task creator Safe does not match TaskCreated creator',
        );
      }
      if (verifier.task.manifestDigest !== manifestDigest) {
        throw new Error(
          'authenticated task manifest digest does not match TaskCreated manifestDigest',
        );
      }
      const solutionTaskCid = nonEmptyString(record(solutionEnv['task'])?.['cid']);
      if (solutionTaskCid !== verifier.task.originalTaskCid) {
        throw new Error(
          'solutionEnvelope.task.cid does not match authenticated original task CID',
        );
      }
    }

    const model = generatorModel(record(solutionEnv['executor'])?.['generatorModel']);
    const distributionClass =
      solutionEnv['distributionClass'] === 'open'
      || solutionEnv['distributionClass'] === 'restricted-tos'
      || solutionEnv['distributionClass'] === 'unknown'
        ? solutionEnv['distributionClass']
        : undefined;
    return {
      taskSummary: (verifier?.task.description || problem || ref.instanceId)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_PROBLEM_CHARS) || ref.instanceId,
      patch: patch.slice(0, MAX_PATCH_CHARS),
      ...(verifier
        ? {
            repo: verifier.task.repo,
            baseCommit: verifier.task.baseCommit,
            taskCreatedAt: verifier.task.createdAt,
            instanceId: verifier.task.instanceId,
          }
        : {}),
      ...(model ? { generatorModel: model } : {}),
      ...(distributionClass ? { distributionClass } : {}),
      ...(verifier
        ? {
            verifier: {
              failToPass: verifier.failToPass,
              passToPass: verifier.passToPass,
              evalSemanticsVersion: verifier.evalSemanticsVersion,
            },
          }
        : {}),
      verdictEnvelopeCid: selectedVerdict.manifestCid,
      solutionEnvelopeCid: selectedSolution.manifestCid,
      ...(snapshotRef ? { rawSnapshotRef: snapshotRef } : {}),
      ...(trajectorySpans ? { trajectorySpans } : {}),
    };
  };
}
