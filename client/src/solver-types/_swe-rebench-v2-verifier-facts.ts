/**
 * Source-proof verifier facts for SWE-rebench v2 corpus episodes.
 *
 * The resolver deliberately has no local-semantics or empty-array fallback.
 * It returns F2P/P2P and the evaluator-semantics version as one atomic value
 * only after the signed task, its published vetted-pool proof, and its exact
 * HF or minted row all agree.
 */

import { z } from 'zod/v3';
import { keccak256, recoverAddress, sha256, toBytes, type Hex } from 'viem';
import { SweRebenchV2TaskSchema } from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import { cidToDigestHex } from '../adapters/mech/ipfs.js';
import { canonicalJson } from '../util/canonical-json.js';
import {
  fetchHfWithRetry,
  type FetchHfWithRetryOptions,
} from '../harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { isIpfsCid } from '../task-creator/proofs/ipfs-cid.js';
import { SignedTaskV1Schema } from '../types/task-document.js';
import {
  hashMintedPoolArtifact,
  parseMintedPoolArtifact,
  parseMintedIpfsDataset,
  type MintedPoolRow,
  type MintedPoolRowV2,
  type SweRebenchV2MintedPoolArtifactV1,
  type SweRebenchV2MintedPoolArtifactV2,
} from './_swe-rebench-v2-minted-pool.js';
import { computeRowHash } from './_swe-rebench-v2-substrate.js';
import {
  hashVettedPoolArtifact,
  parseVettedPoolArtifact,
  vettedPoolArtifactRefFromEligibility,
  type SweRebenchV2VettedPoolArtifactEntry,
} from './_swe-rebench-v2-validated-pool.js';

export const SWE_REBENCH_V2_VERIFIER_FACT_MAX_BYTES = 2_000_000;

export interface SweRebenchV2VerifierFacts {
  failToPass: string[];
  passToPass: string[];
  evalSemanticsVersion: string;
  task: {
    solverType: string;
    instanceId: string;
    repo: string;
    baseCommit: string;
    createdAt: number;
    /** Present only after the production resolver authenticates TaskCreated lineage. */
    originalTaskCid?: string;
    /** TaskCreated.creator, authenticated against the original signed task. */
    creatorSafe?: string;
    /** TaskCreated.manifestDigest, authenticated against solverNetManifestCid. */
    manifestDigest?: string;
    /** Creator-authored task description; never copied from the evaluation wrapper. */
    description?: string;
  };
}

/**
 * Chain-authoritative bindings for the evaluation-wrapper → original-task hop.
 *
 * This stays structural so the harness layer can supply its GraphQL/on-chain
 * result without importing client implementation types.
 */
export interface SweRebenchV2AuthoritativeTaskBinding {
  taskCidDigest: string;
  manifestDigest: string;
  creatorSafe: string;
  evaluatorSafe: string;
  taskId?: string;
  chainId?: number;
}

export interface SweRebenchV2VerifierFactPorts {
  /**
   * Fetch and JSON-decode an IPFS object under the supplied response-size cap.
   * The injected implementation owns timeout, redirect, byte-limit, and
   * requested-CID content-digest enforcement before JSON parsing; this module
   * always supplies a finite cap.
   */
  fetchIpfsJson(args: { cid: string; maxBytes: number }): Promise<unknown>;
  /**
   * Fetch the unprojected HF row under the supplied response-size cap. It must
   * not pass through HfRow, which drops row-hash inputs such as patch/base.
   */
  fetchHfRawRow(args: {
    dataset: string;
    split: string;
    instanceId: string;
    maxBytes: number;
  }): Promise<unknown>;
}

export interface BoundedRawHfRowFetcherOptions extends FetchHfWithRetryOptions {
  /** Defaults to the public datasets-server rows endpoint. */
  baseUrl?: string;
  /** HF accepts at most 100 rows per page. Defaults to 100. */
  pageSize?: number;
  /** Hard scan ceiling for one exact-row lookup. Defaults to 1000. */
  maxRows?: number;
  /** Per-attempt request + response-body timeout. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
}

const DEFAULT_HF_ROWS_URL = 'https://datasets-server.huggingface.co/rows';

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('HF row byte cap must be a positive safe integer');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(
      `HF rows response is too large: content-length ${declaredLength} exceeds byte cap ${maxBytes}`,
    );
  }
  if (!response.body) throw new Error('HF rows response has no body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel('HF rows response exceeded byte cap');
        throw new Error(`HF rows response exceeded byte cap ${maxBytes}`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `HF rows response is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `HF rows response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseRawHfPage(body: unknown, requestedLength: number): Record<string, unknown>[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('HF rows response must be an object');
  }
  const rawRows = (body as Record<string, unknown>)['rows'];
  if (!Array.isArray(rawRows)) {
    throw new Error('HF rows response must contain a rows array');
  }
  if (rawRows.length > requestedLength) {
    throw new Error(
      `HF rows response returned ${rawRows.length} rows for requested length ${requestedLength}`,
    );
  }
  return rawRows.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`HF rows response item ${index} must be an object`);
    }
    const row = (item as Record<string, unknown>)['row'];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`HF rows response item ${index}.row must be an object`);
    }
    return row as Record<string, unknown>;
  });
}

/**
 * Production-capable raw HF port. It reuses the daemon's shared retry/rate
 * limiter, walks a finite number of finite pages, enforces a decoded response
 * byte cap on every page, and returns the exact unprojected source row.
 */
export function createBoundedRawHfRowFetcher(
  options: BoundedRawHfRowFetcherOptions = {},
): SweRebenchV2VerifierFactPorts['fetchHfRawRow'] {
  const baseUrl = options.baseUrl ?? DEFAULT_HF_ROWS_URL;
  const pageSize = Math.min(options.pageSize ?? 100, 100);
  const maxRows = options.maxRows ?? 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error('HF verifier pageSize must be a positive integer');
  }
  if (!Number.isSafeInteger(maxRows) || maxRows <= 0) {
    throw new Error('HF verifier maxRows must be a positive integer');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('HF verifier requestTimeoutMs must be a positive integer');
  }
  const upstreamFetch = options.fetchImpl ?? fetch.bind(globalThis);
  const timedFetch: typeof fetch = (input, init) => upstreamFetch(input, {
    ...init,
    // A fresh signal is created per retry attempt. It stays live after headers
    // arrive, so a stalled response body is bounded too.
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const retryOptions: FetchHfWithRetryOptions = {
    ...options,
    fetchImpl: timedFetch,
  };

  return async ({ dataset, split, instanceId, maxBytes }) => {
    let offset = 0;
    while (offset < maxRows) {
      const requestedLength = Math.min(pageSize, maxRows - offset);
      const url = new URL(baseUrl);
      url.searchParams.set('dataset', dataset);
      url.searchParams.set('config', 'default');
      url.searchParams.set('split', split);
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('length', String(requestedLength));

      let response: Response;
      try {
        response = await fetchHfWithRetry(url.toString(), retryOptions);
      } catch (error) {
        const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
        if (typeof status === 'number') {
          throw Object.assign(
            new Error(`HF datasets-server returned ${status} for ${dataset}/${split}`),
            { httpStatus: status },
          );
        }
        throw error;
      }
      if (!response.ok) {
        throw Object.assign(
          new Error(`HF datasets-server returned ${response.status} for ${dataset}/${split}`),
          { httpStatus: response.status },
        );
      }
      const rows = parseRawHfPage(
        await readBoundedJson(response, maxBytes),
        requestedLength,
      );
      for (const row of rows) {
        if (row['instance_id'] === instanceId) return row;
      }
      if (rows.length < requestedLength) break;
      offset += rows.length;
    }
    throw new Error(
      `instance_id ${instanceId} not found in ${dataset}/${split} (scanned up to ${maxRows} rows)`,
    );
  };
}

const NonEmpty = z.string().min(1);
const Commit = z.string().regex(/^[0-9a-f]{40}$/u);
const StringList = z.array(NonEmpty);
const Command = z.union([z.string(), z.array(z.string())]);
const InstallConfig = z.object({
  install: Command.optional(),
  test_cmd: Command,
  log_parser: NonEmpty,
}).passthrough();

/**
 * This is intentionally wider than HfRow only in allowing unrelated source
 * columns. Every field consumed by computeRowHash is required and parsed from
 * the raw HF row before projection.
 */
const RawHfRowSchema = z.object({
  instance_id: NonEmpty,
  repo: NonEmpty,
  base_commit: Commit,
  image_name: NonEmpty,
  patch: z.string(),
  test_patch: z.string(),
  install_config: InstallConfig,
  FAIL_TO_PASS: StringList,
  PASS_TO_PASS: StringList,
}).passthrough();

/**
 * Immutable v1 artifacts predate the strict public v2 schema. For proof
 * extraction we use a strict reader instead of the historical compatibility
 * cast: local-only or malformed fields may not silently become verifier facts.
 * A base_commit is required here even though the old TypeScript interface made
 * it optional; without it the row cannot be bound to the signed task.
 */
const MintedPoolRowV1ProofSchema = z.object({
  instance_id: NonEmpty,
  repo: NonEmpty,
  base_commit: Commit,
  language: NonEmpty,
  problem_statement: z.string().optional(),
  image_name: NonEmpty,
  FAIL_TO_PASS: StringList,
  PASS_TO_PASS: StringList,
  test_patch: z.string(),
  install_config: InstallConfig.strict(),
}).strict();

const MintedPoolArtifactV1ProofSchema = z.object({
  schemaVersion: z.literal('swe-rebench-v2-minted-pool.v1'),
  evalSemanticsVersion: NonEmpty,
  generatedAt: NonEmpty,
  rows: z.array(MintedPoolRowV1ProofSchema),
}).strict();

type StrictMintedPoolArtifact =
  | SweRebenchV2MintedPoolArtifactV1
  | SweRebenchV2MintedPoolArtifactV2;

function parseStrictMintedPoolArtifact(raw: unknown): StrictMintedPoolArtifact {
  if (
    raw !== null
    && typeof raw === 'object'
    && (raw as Record<string, unknown>)['schemaVersion'] === 'swe-rebench-v2-minted-pool.v1'
  ) {
    return MintedPoolArtifactV1ProofSchema.parse(raw) as SweRebenchV2MintedPoolArtifactV1;
  }
  return parseMintedPoolArtifact(raw);
}

function requireExactAdmissionEntry(
  entries: SweRebenchV2VettedPoolArtifactEntry[],
  instanceId: string,
): SweRebenchV2VettedPoolArtifactEntry {
  const matches = entries.filter(
    (entry) => entry.instance_id === instanceId && entry.scorable === true,
  );
  if (matches.length !== 1) {
    throw new Error(
      `vetted pool proof must contain exactly one scorable entry for ${instanceId}; found ${matches.length}`,
    );
  }
  return matches[0]!;
}

function assertTaskIdentity(
  row: { instance_id: string; repo: string; base_commit?: string },
  task: { instance_id: string; repo: string; base_commit: string },
): void {
  if (row.instance_id !== task.instance_id) {
    throw new Error(
      `row instance_id ${row.instance_id} does not match signed task ${task.instance_id}`,
    );
  }
  if (row.repo !== task.repo) {
    throw new Error(`row repo ${row.repo} does not match signed task ${task.repo}`);
  }
  if (row.base_commit !== task.base_commit) {
    throw new Error(
      `row base_commit ${row.base_commit ?? '<missing>'} does not match signed task ${task.base_commit}`,
    );
  }
}

function assertEligibilityIdentity(
  eligibility: Record<string, unknown>,
  task: { hf_dataset: string; hf_split: string; instance_id: string },
): void {
  for (const key of ['hf_dataset', 'hf_split', 'instance_id'] as const) {
    if (eligibility[key] !== task[key]) {
      throw new Error(
        `signed task eligibility ${key} does not match signed SWE task spec`,
      );
    }
  }
}

function assertMintedTaskIdentity(
  row: {
    instance_id: string;
    repo: string;
    base_commit?: string;
    language?: string;
  },
  task: {
    instance_id: string;
    repo: string;
    base_commit: string;
    language: string;
  },
): void {
  assertTaskIdentity(row, task);
  if (row.language !== task.language) {
    throw new Error(
      `row language ${row.language ?? '<missing>'} does not match signed task ${task.language}`,
    );
  }
}

function assertCanonicalCid(artifact: StrictMintedPoolArtifact, cid: string): void {
  if (!isIpfsCid(cid)) {
    throw new Error('signed minted hf_dataset must contain a valid IPFS CID');
  }
  const expected = hashMintedPoolArtifact(artifact).slice('sha256:'.length);
  let actual: string;
  try {
    actual = cidToDigestHex(cid).slice(2).toLowerCase();
  } catch (error) {
    throw new Error(
      `signed minted CID does not encode a canonical sha2-256 digest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (actual !== expected) {
    throw new Error('minted artifact canonical content digest does not match signed CID');
  }
}

function sameOptionalCanonical(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function assertV2Admission(
  row: MintedPoolRowV2,
  entry: SweRebenchV2VettedPoolArtifactEntry,
): void {
  const admittedEnvironment = entry.v2Environment;
  const rowEnvironment = {
    environmentSpecCid: row.environment.environmentSpecCid,
    environmentHash: row.environment.environmentHash,
    parser: row.environment.parser,
    image: row.environment.image,
    platform: row.environment.platform,
  };
  if (
    entry.rowHashVersion !== 2
    || entry.publicRowHash !== row.publicRowHash
    || !admittedEnvironment
    || canonicalJson(admittedEnvironment) !== canonicalJson(rowEnvironment)
    || entry.v2FixCommit !== row.fix_commit
    || !sameOptionalCanonical(entry.differentialAdmission, row.differentialAdmission)
  ) {
    throw new Error(`minted v2 vetted admission/environment binding mismatch for ${row.instance_id}`);
  }
}

function facts(
  row: Pick<MintedPoolRow, 'FAIL_TO_PASS' | 'PASS_TO_PASS'>,
  evalSemanticsVersion: string,
  task: SweRebenchV2VerifierFacts['task'],
): SweRebenchV2VerifierFacts {
  return {
    failToPass: [...row.FAIL_TO_PASS],
    passToPass: [...row.PASS_TO_PASS],
    evalSemanticsVersion,
    task: { ...task },
  };
}

async function authenticateSignedTask(
  rawSignedTask: unknown,
  signedTask: ReturnType<typeof SignedTaskV1Schema.parse>,
): Promise<void> {
  if (
    rawSignedTask === null
    || typeof rawSignedTask !== 'object'
    || Array.isArray(rawSignedTask)
  ) {
    throw new Error('signed task must be an object');
  }
  const { signature: _signature, ...unsignedTask } =
    rawSignedTask as Record<string, unknown>;
  const canonicalHash = keccak256(toBytes(canonicalJson(unsignedTask)));
  if (canonicalHash.toLowerCase() !== signedTask.signature.hash.toLowerCase()) {
    throw new Error(
      `signed task signature.hash does not authenticate the canonical unsigned task: expected ${canonicalHash}`,
    );
  }

  let recovered: `0x${string}`;
  try {
    recovered = await recoverAddress({
      hash: canonicalHash,
      signature: signedTask.signature.sig as Hex,
    });
  } catch (error) {
    throw new Error(
      `signed task signature recovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (recovered.toLowerCase() !== signedTask.signature.signer.toLowerCase()) {
    throw new Error(
      `signed task recovered signer ${recovered} does not match declared signer ${signedTask.signature.signer}`,
    );
  }
  if (recovered.toLowerCase() !== signedTask.creator.agentEoa.toLowerCase()) {
    throw new Error(
      `signed task recovered signer ${recovered} does not match creator.agentEoa ${signedTask.creator.agentEoa}`,
    );
  }
}

function exactHex(
  value: unknown,
  bytes: number,
  sourceName: string,
): string {
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`, 'u');
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${sourceName} must be an exact ${bytes}-byte hex value`);
  }
  return value;
}

function exactSafe(value: unknown, sourceName: string): string {
  return exactHex(value, 20, sourceName);
}

function exactDigest(value: unknown, sourceName: string): string {
  return exactHex(value, 32, sourceName);
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function authenticateAuthoritativeOriginalTask(args: {
  rawEvaluationWrapper: unknown;
  authority: SweRebenchV2AuthoritativeTaskBinding;
  ports: SweRebenchV2VerifierFactPorts;
}): Promise<{
  rawOriginalTask: unknown;
  provenance: Required<Pick<
    SweRebenchV2VerifierFacts['task'],
    'originalTaskCid' | 'creatorSafe' | 'manifestDigest' | 'description'
  >>;
}> {
  let evaluationWrapper: ReturnType<typeof SignedTaskV1Schema.parse>;
  try {
    evaluationWrapper = SignedTaskV1Schema.parse(args.rawEvaluationWrapper);
    await authenticateSignedTask(args.rawEvaluationWrapper, evaluationWrapper);
  } catch (error) {
    throw new Error(
      `evaluation wrapper authentication failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (evaluationWrapper.role !== 'evaluation') {
    throw new Error('evaluation wrapper must have role=evaluation');
  }

  const evaluatorSafe = exactSafe(
    args.authority.evaluatorSafe,
    'authoritative evaluator Safe',
  );
  const wrapperCreatorSafe = exactSafe(
    evaluationWrapper.creator.safeAddress,
    'evaluation wrapper creator Safe',
  );
  if (!sameHex(wrapperCreatorSafe, evaluatorSafe)) {
    throw new Error(
      'evaluation wrapper creator Safe does not match the on-chain evaluator',
    );
  }

  const rawWrapper =
    args.rawEvaluationWrapper !== null
    && typeof args.rawEvaluationWrapper === 'object'
    && !Array.isArray(args.rawEvaluationWrapper)
      ? args.rawEvaluationWrapper as Record<string, unknown>
      : undefined;
  const rawContext =
    rawWrapper?.['context'] !== null
    && typeof rawWrapper?.['context'] === 'object'
    && !Array.isArray(rawWrapper?.['context'])
      ? rawWrapper['context'] as Record<string, unknown>
      : undefined;
  const originalTaskCid = rawContext?.['solutionTaskCid'];
  if (typeof originalTaskCid !== 'string' || originalTaskCid.length === 0) {
    throw new Error(
      'authenticated evaluation wrapper context.solutionTaskCid must be nonempty',
    );
  }
  if (
    !(
      /^f01551220[0-9a-f]{64}$/u.test(originalTaskCid)
      || /^F01551220[0-9A-F]{64}$/u.test(originalTaskCid)
      || (
        originalTaskCid.length === 59
        && originalTaskCid.startsWith('bafk')
        && isIpfsCid(originalTaskCid)
      )
    )
  ) {
    throw new Error(
      'authenticated original task CID must be a canonical raw CIDv1',
    );
  }

  const authoritativeTaskCidDigest = exactDigest(
    args.authority.taskCidDigest,
    'authoritative TaskCreated.taskCidDigest',
  );
  let actualTaskCidDigest: string;
  try {
    actualTaskCidDigest = exactDigest(
      cidToDigestHex(originalTaskCid),
      'evaluation wrapper solutionTaskCid digest',
    );
  } catch (error) {
    throw new Error(
      `evaluation wrapper solutionTaskCid is not a canonical content CID: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!sameHex(actualTaskCidDigest, authoritativeTaskCidDigest)) {
    throw new Error(
      'evaluation wrapper original task CID digest does not match '
      + 'TaskCreated.taskCidDigest',
    );
  }

  const rawOriginalTask = await args.ports.fetchIpfsJson({
    cid: originalTaskCid,
    maxBytes: SWE_REBENCH_V2_VERIFIER_FACT_MAX_BYTES,
  });
  // Production task publications are raw CIDv1 objects whose digest is the
  // sha2-256 of the exact RFC 8785 bytes uploaded by uploadToIpfs. The bounded
  // live port checks the fetched bytes before parsing; repeat the binding over
  // canonical JSON here so alternate/injected ports cannot substitute another
  // otherwise-valid signed task under the authoritative CID.
  if (
    !sameHex(
      sha256(toBytes(canonicalJson(rawOriginalTask))),
      actualTaskCidDigest,
    )
  ) {
    throw new Error(
      'original task canonical content digest does not match its authenticated CID',
    );
  }
  let originalTask: ReturnType<typeof SignedTaskV1Schema.parse>;
  try {
    originalTask = SignedTaskV1Schema.parse(rawOriginalTask);
    await authenticateSignedTask(rawOriginalTask, originalTask);
  } catch (error) {
    throw new Error(
      `original task authentication failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (originalTask.role !== 'restoration') {
    throw new Error('authenticated original task must have role=restoration');
  }

  const authoritativeCreatorSafe = exactSafe(
    args.authority.creatorSafe,
    'authoritative TaskCreated creator Safe',
  );
  const originalCreatorSafe = exactSafe(
    originalTask.creator.safeAddress,
    'original task creator Safe',
  );
  if (!sameHex(originalCreatorSafe, authoritativeCreatorSafe)) {
    throw new Error(
      'original task creator Safe does not match TaskCreated creator',
    );
  }

  const authoritativeManifestDigest = exactDigest(
    args.authority.manifestDigest,
    'authoritative TaskCreated.manifestDigest',
  );
  const actualManifestDigest = keccak256(
    toBytes(originalTask.solverNetManifestCid),
  );
  if (!sameHex(actualManifestDigest, authoritativeManifestDigest)) {
    throw new Error(
      'original task manifest does not match TaskCreated manifestDigest',
    );
  }

  return {
    rawOriginalTask,
    provenance: {
      originalTaskCid,
      creatorSafe: originalCreatorSafe,
      manifestDigest: actualManifestDigest,
      description: originalTask.description,
    },
  };
}

export async function resolveSweRebenchV2VerifierFacts(args: {
  signedTask: unknown;
  expectedInstanceId: string;
  ports: SweRebenchV2VerifierFactPorts;
}): Promise<SweRebenchV2VerifierFacts> {
  const signedTask = SignedTaskV1Schema.parse(args.signedTask);
  await authenticateSignedTask(args.signedTask, signedTask);
  if (
    signedTask.solverType !== 'swe-rebench-v2.v1'
    || signedTask.contractId !== 'swe-rebench-v2'
    || signedTask.contractVersion !== 'v1'
  ) {
    throw new Error('signed task is not the swe-rebench-v2.v1 contract');
  }
  const task = SweRebenchV2TaskSchema.parse(signedTask.spec);
  const taskProvenance: SweRebenchV2VerifierFacts['task'] = {
    solverType: signedTask.solverType,
    instanceId: task.instance_id,
    repo: task.repo,
    baseCommit: task.base_commit,
    createdAt: signedTask.createdAt,
  };
  if (task.instance_id !== args.expectedInstanceId) {
    throw new Error(
      `expected instance ${args.expectedInstanceId} does not match signed task ${task.instance_id}`,
    );
  }
  assertEligibilityIdentity(signedTask.eligibility, task);

  const ref = vettedPoolArtifactRefFromEligibility(signedTask.eligibility);
  if (!ref) {
    throw new Error('signed task eligibility has no vettedPoolRef proof');
  }
  if (ref.manifestCid !== signedTask.solverNetManifestCid) {
    throw new Error(
      `vettedPoolRef manifest ${ref.manifestCid} does not match signed task ${signedTask.solverNetManifestCid}`,
    );
  }
  if (!ref.evalSemanticsVersion) {
    throw new Error('vettedPoolRef evalSemanticsVersion must be nonempty');
  }
  if (!isIpfsCid(ref.artifactCid)) {
    throw new Error('vettedPoolRef artifactCid must be a valid IPFS CID');
  }

  const rawVetted = await args.ports.fetchIpfsJson({
    cid: ref.artifactCid,
    maxBytes: SWE_REBENCH_V2_VERIFIER_FACT_MAX_BYTES,
  });
  const vetted = parseVettedPoolArtifact(rawVetted);
  if (hashVettedPoolArtifact(vetted) !== ref.artifactHash) {
    throw new Error('vetted pool artifact hash does not match signed vettedPoolRef');
  }
  if (vetted.evalSemanticsVersion !== ref.evalSemanticsVersion) {
    throw new Error('vetted pool artifact semantics do not match signed vettedPoolRef');
  }
  const admission = requireExactAdmissionEntry(vetted.entries, task.instance_id);

  const mintedCid = parseMintedIpfsDataset(task.hf_dataset);
  if (mintedCid === null) {
    const rawRow = await args.ports.fetchHfRawRow({
      dataset: task.hf_dataset,
      split: task.hf_split,
      instanceId: task.instance_id,
      maxBytes: SWE_REBENCH_V2_VERIFIER_FACT_MAX_BYTES,
    });
    const row = RawHfRowSchema.parse(rawRow);
    assertTaskIdentity(row, task);
    if (!admission.rowHash || !/^sha256:[0-9a-f]{64}$/u.test(admission.rowHash)) {
      throw new Error(`vetted pool entry for ${task.instance_id} has no exact rowHash proof`);
    }
    const actualRowHash = computeRowHash({
      hf_dataset: task.hf_dataset,
      hf_split: task.hf_split,
      instance_id: row.instance_id,
      repo: row.repo,
      base_commit: row.base_commit,
      image_name: row.image_name,
      patch: row.patch,
      test_patch: row.test_patch,
      install_config: {
        install: row.install_config.install ?? [],
        test_cmd: row.install_config.test_cmd,
        log_parser: row.install_config.log_parser,
      },
      FAIL_TO_PASS: row.FAIL_TO_PASS,
      PASS_TO_PASS: row.PASS_TO_PASS,
    });
    if (actualRowHash !== admission.rowHash) {
      throw new Error(
        `raw HF rowHash ${actualRowHash} does not match vetted proof ${admission.rowHash}`,
      );
    }
    return facts(row, ref.evalSemanticsVersion, taskProvenance);
  }

  if (task.hf_split !== 'minted') {
    throw new Error('signed minted task must use hf_split=minted');
  }
  if (!isIpfsCid(mintedCid)) {
    throw new Error('signed minted hf_dataset must contain a valid IPFS CID');
  }
  const rawMinted = await args.ports.fetchIpfsJson({
    cid: mintedCid,
    maxBytes: SWE_REBENCH_V2_VERIFIER_FACT_MAX_BYTES,
  });
  const minted = parseStrictMintedPoolArtifact(rawMinted);
  assertCanonicalCid(minted, mintedCid);
  if (minted.evalSemanticsVersion !== ref.evalSemanticsVersion) {
    throw new Error('minted artifact semantics do not match signed vettedPoolRef');
  }
  const matchingRows = minted.rows.filter((row) => row.instance_id === task.instance_id);
  if (matchingRows.length !== 1) {
    throw new Error(
      `minted artifact must contain exactly one row for ${task.instance_id}; found ${matchingRows.length}`,
    );
  }
  const row = matchingRows[0]!;
  assertMintedTaskIdentity(row, task);
  if (minted.schemaVersion !== 'swe-rebench-v2-minted-pool.v2') {
    throw new Error('minted v1 artifact has no authenticated admission-row binding');
  }
  assertV2Admission(row as MintedPoolRowV2, admission);
  return facts(row, ref.evalSemanticsVersion, taskProvenance);
}

/**
 * Curried composition-root adapter. Runtime Task objects carry the canonical
 * wire document under `signedTask`; direct callers may pass that wire document
 * itself.
 */
export function createSweRebenchV2VerifierFactsResolver(
  ports: SweRebenchV2VerifierFactPorts,
): (
  taskDocument: unknown,
  expectedInstanceId: string,
  authority?: SweRebenchV2AuthoritativeTaskBinding,
) => Promise<SweRebenchV2VerifierFacts> {
  return async (taskDocument, expectedInstanceId, authority) => {
    const wrapped =
      taskDocument !== null
      && typeof taskDocument === 'object'
      && !Array.isArray(taskDocument)
        ? (taskDocument as Record<string, unknown>)['signedTask']
        : undefined;
    const rawEvaluationOrTask = wrapped ?? taskDocument;
    if (!authority) {
      return resolveSweRebenchV2VerifierFacts({
        signedTask: rawEvaluationOrTask,
        expectedInstanceId,
        ports,
      });
    }

    const authoritative = await authenticateAuthoritativeOriginalTask({
      rawEvaluationWrapper: rawEvaluationOrTask,
      authority,
      ports,
    });
    const authoritativeOriginal = SignedTaskV1Schema.parse(
      authoritative.rawOriginalTask,
    );
    const authoritativeSpec = SweRebenchV2TaskSchema.parse(
      authoritativeOriginal.spec,
    );
    const resolved = await resolveSweRebenchV2VerifierFacts({
      signedTask: authoritative.rawOriginalTask,
      // Indexer enrichment projections are discovery hints, not authority.
      // Once TaskCreated lineage is supplied, derive instance identity from
      // the authenticated original restoration task itself.
      expectedInstanceId: authoritativeSpec.instance_id,
      ports,
    });
    return {
      ...resolved,
      task: {
        ...resolved.task,
        ...authoritative.provenance,
      },
    };
  };
}
