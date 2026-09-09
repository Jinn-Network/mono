/**
 * `jinn evidence` verb — the read side of the quickstart loop.
 *
 * Three READ-ONLY subverbs turn an identifier into a result:
 *   jinn evidence show --envelope-cid <cid> [--verify]
 *   jinn evidence find --task-id <id> [--role solution|verdict]
 *   jinn evidence fetch --envelope-cid <cid> [--sha256 <hex>]
 *
 * All three are config-only: no keystore, no signer, no daemon, no bootstrap.
 * They read IPFS (show, fetch), the HTTP discovery indexer (find), and the
 * artifact's own origin (fetch) — and nothing else. `fetch` is legal in this
 * family only because the retrieval primitive it calls is keyless and
 * store-free (#4179); the fetch path that predated it demanded a Safe and a
 * SQLite store, which is why the deliverable was unreachable from here.
 */

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  fetchVerifiedArtifact as defaultFetchVerifiedArtifact,
  type ArtifactFetchFailureReason,
} from '@jinn-network/core/corpus-read';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { emitResult } from '../output.js';
import { getConfigPathFromArgs, loadConfig } from '../../config.js';
import { fetchSignedEnvelopeBytesRaw } from '../../adapters/mech/ipfs.js';
import { runConformance } from '../../conformance/harness.js';
import { SignedEnvelopeSchema, type SignedEnvelope } from '../../types/envelope.js';
import { createHttpDiscoveryClient } from '../../discovery-client/http.js';
import type { AutopilotDeliveryRole } from '../../discovery-client/types.js';

const SHOW_EXAMPLE = 'jinn evidence show --envelope-cid bafybeiabc123...';
const FIND_EXAMPLE = 'jinn evidence find --task-id 42 --role solution';
const FETCH_EXAMPLE = 'jinn evidence fetch --envelope-cid bafybeiabc123...';

/**
 * The retrieval primitive is injected so tests exercise the verb's selection,
 * output, and error mapping without a network. Production wiring is the
 * default; see docs/runbooks/testing.md and `doctor.ts` for the pattern.
 */
export interface EvidenceDeps {
  fetchVerifiedArtifact: typeof defaultFetchVerifiedArtifact;
}

const PRODUCTION_DEPS: EvidenceDeps = {
  fetchVerifiedArtifact: defaultFetchVerifiedArtifact,
};

/**
 * Chain id per configured network. `evidence find` needs only the chain id to
 * scope the indexer read, so it resolves it from `config.network` rather than
 * loading the full ChainConfig (which reads deployment artifacts off disk —
 * unnecessary weight for a read-only verb).
 */
const CHAIN_ID_BY_NETWORK = { testnet: 84532, mainnet: 8453 } as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Both indexer-backed subverbs require `discovery.mode: 'http'` with a url.
 * There is no silent fall-through to the on-chain floor: the floor cannot
 * answer a taskId → envelope lookup, so degrading to it would answer "not
 * found" for a task that was in fact delivered.
 *
 * `tasks observe-autopilot-delivery` used to enforce the same requirement; it
 * was retired by one-swap R3b (issue #2494), leaving `evidence find` and
 * `tasks watch` as the exact-delivery reads.
 */
function requireHttpDiscoveryUrl(
  ctx: CommandContext,
  config: ReturnType<typeof loadConfig>,
  exampleCli: string,
): string | undefined {
  const discovery = config.discovery;
  if (discovery?.mode === 'http' && discovery.url) return discovery.url;
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message:
        'An HTTP discovery indexer is required for this verb, but '
        + `discovery.mode is '${discovery?.mode ?? 'unset'}'`
        + (discovery?.mode === 'http' ? ' with no discovery.url' : '')
        + '.',
      hint:
        'Set `discovery.mode: "http"` and `discovery.url: "<indexer url>"` in '
        + '~/.jinn-client/config.json (or export JINN_DISCOVERY_MODE=http and '
        + 'JINN_DISCOVERY_URL=<indexer url>). The on-chain floor cannot resolve '
        + 'a task id to an envelope, so this verb does not fall back to it.',
      exampleCli,
      details: {
        field: 'discovery.mode',
        expected: 'http',
        actual: discovery?.mode ?? null,
        configKeys: ['discovery.mode', 'discovery.url'],
        envVars: ['JINN_DISCOVERY_MODE', 'JINN_DISCOVERY_URL'],
      },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
  return undefined;
}

// ── evidence show ─────────────────────────────────────────────────────────────

/**
 * The identifying fields of a signed envelope, projected from
 * `SignedEnvelopeSchema`.
 *
 * Field-name notes (verified against packages/core/src/execution-envelope.ts):
 *  - There is no `envelopeDigest` on the schema. `envelopeDigest` below is the
 *    sha256 of the exact bytes stored at the CID, computed here.
 *  - There is no operator *agentId* on an envelope. The operator identity the
 *    envelope actually carries is `participant.safeAddress` + `participant.agentEoa`
 *    (an agentId only exists on the indexer-side EnvelopeRef).
 *  - `trajectory` is a TrajectoryRef — `{ sha256, access, sources[] }`. It has
 *    no top-level `cid`; the CID lives on `sources[].cid` for `kind: 'ipfs'`.
 *  - `kind` in the payload registry is the envelope's `solverType`; both names
 *    are emitted so callers can key off either.
 */
interface EnvelopeSummary {
  envelopeCid: string;
  envelopeDigest: string;
  schemaVersion: string;
  kind: string;
  solverType: string;
  role: string;
  evidenceTier: string;
  generatedAt: number;
  operator: {
    safeAddress: string;
    agentEoa: string;
    /** Envelopes carry no agent id; kept explicit so the absence is legible. */
    agentId: null;
  };
  task: {
    cid: string;
    requestId: string;
    onchainCreationTx: string;
    onchainCreationBlock: number;
  } | null;
  artifacts: Array<{ artifactType: string; sha256: string }>;
  trajectory: { sha256: string; cid: string | null } | null;
  verdict: { verdict: string; score: string | null } | null;
  signature: { signer: string; hash: string };
}

function summarizeEnvelope(
  envelopeCid: string,
  bytes: Uint8Array,
  envelope: SignedEnvelope,
): EnvelopeSummary {
  const trajectory = envelope.trajectory;
  const trajectoryCid = trajectory
    ? (trajectory.sources ?? []).find((s) => s.kind === 'ipfs')?.cid ?? null
    : null;
  const payload = envelope.payload as Record<string, unknown>;
  const rawVerdict = payload['verdict'];
  const rawScore = payload['score'];
  return {
    envelopeCid,
    envelopeDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    schemaVersion: envelope.schemaVersion,
    kind: envelope.solverType,
    solverType: envelope.solverType,
    role: envelope.role,
    evidenceTier: envelope.evidenceTier,
    generatedAt: envelope.generatedAt,
    operator: {
      safeAddress: envelope.participant.safeAddress,
      agentEoa: envelope.participant.agentEoa,
      agentId: null,
    },
    task: envelope.task
      ? {
          cid: envelope.task.cid,
          requestId: envelope.task.requestId,
          onchainCreationTx: envelope.task.onchainCreationTx,
          onchainCreationBlock: envelope.task.onchainCreationBlock,
        }
      : null,
    artifacts: envelope.artifacts.map((a) => ({
      artifactType: a.artifactType,
      sha256: a.sha256,
    })),
    trajectory: trajectory ? { sha256: trajectory.sha256, cid: trajectoryCid } : null,
    verdict:
      typeof rawVerdict === 'string'
        ? { verdict: rawVerdict, score: typeof rawScore === 'string' ? rawScore : null }
        : null,
    signature: { signer: envelope.signature.signer, hash: envelope.signature.hash },
  };
}

function renderShowHuman(value: unknown): string {
  const v = value as {
    envelope: EnvelopeSummary;
    conformance?: {
      overall: string;
      envelopeTier: string;
      layer1Passed: boolean;
      layer2Passed: boolean | 'N/A';
      summary: { total: number; passed: number; failed: number; skipped: number };
    };
  };
  const e = v.envelope;
  const lines: string[] = [];
  lines.push(`Envelope ${e.envelopeCid}`);
  lines.push(`  Digest    : ${e.envelopeDigest}`);
  lines.push(`  Kind      : ${e.kind}`);
  lines.push(`  Role      : ${e.role}`);
  lines.push(`  Tier      : ${e.evidenceTier}`);
  lines.push(`  Operator  : safe ${e.operator.safeAddress} / eoa ${e.operator.agentEoa}`);
  lines.push(`  Task      : ${e.task ? `${e.task.cid} (request ${e.task.requestId})` : 'none'}`);
  lines.push(
    `  Trajectory: ${e.trajectory ? `${e.trajectory.cid ?? 'no ipfs source'} (${e.trajectory.sha256})` : 'none'}`,
  );
  if (e.verdict) {
    lines.push(`  Verdict   : ${e.verdict.verdict}${e.verdict.score ? ` (score ${e.verdict.score})` : ''}`);
  }
  lines.push(`  Artifacts : ${e.artifacts.length}`);
  for (const a of e.artifacts) lines.push(`    ${a.artifactType} ${a.sha256}`);
  if (v.conformance) {
    const c = v.conformance;
    lines.push('');
    lines.push(`Conformance: ${c.overall} (tier ${c.envelopeTier})`);
    lines.push(
      `  ${c.summary.passed}/${c.summary.total} passed, ${c.summary.failed} failed, ${c.summary.skipped} skipped`,
    );
    lines.push(`  Layer 1: ${c.layer1Passed ? 'PASS' : 'FAIL'}`);
    lines.push(
      `  Layer 2: ${c.layer2Passed === 'N/A' ? 'N/A (not attested tier)' : c.layer2Passed ? 'PASS' : 'FAIL'}`,
    );
  }
  return lines.join('\n');
}

async function runShow(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        'envelope-cid': { type: 'string' as const },
        verify: { type: 'boolean' as const, default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: errorMessage(err),
        exampleCli: SHOW_EXAMPLE,
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const envelopeCid = parsed.values['envelope-cid'] as string | undefined;
  if (!envelopeCid) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--envelope-cid is required',
        exampleCli: SHOW_EXAMPLE,
        details: { field: '--envelope-cid', expected: 'non-empty string IPFS CID' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const config = loadConfig(getConfigPathFromArgs(ctx.argv));

  // Same fetch path `runConformance` uses for the envelope: the exact bytes
  // stored at the CID, no JSON parse/re-encode roundtrip, so the digest below
  // matches the bytes that were hashed at upload time.
  let bytes: Uint8Array;
  try {
    bytes = await fetchSignedEnvelopeBytesRaw(config.ipfsGatewayUrl, envelopeCid);
  } catch (err) {
    emitEnvelope(
      {
        code: 'transient_error',
        message: `Could not fetch envelope ${envelopeCid}: ${errorMessage(err)}`,
        hint: 'Retry when the IPFS gateway is reachable, or set ipfsGatewayUrl to a gateway that pins this CID.',
        exampleCli: SHOW_EXAMPLE,
        details: { envelopeCid, gateway: config.ipfsGatewayUrl },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  let envelope: SignedEnvelope;
  try {
    envelope = SignedEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Bytes at ${envelopeCid} are not a jinn.execution.v1 signed envelope: ${errorMessage(err)}`,
        hint: 'Run `jinn conformance --envelope-cid <cid>` for the per-check breakdown.',
        exampleCli: SHOW_EXAMPLE,
        details: { field: '--envelope-cid', envelopeCid },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const summary = summarizeEnvelope(envelopeCid, bytes, envelope);

  // `--verify` folds the conformance report in as data. It deliberately does
  // NOT change the exit code: a self-signed-tier envelope that legitimately
  // fails an attested-tier check must not red-exit a read verb.
  let conformance: Record<string, unknown> | undefined;
  if (parsed.values.verify === true) {
    try {
      const report = await runConformance({
        envelopeCid,
        options: {
          ipfsGatewayUrl: config.ipfsGatewayUrl,
          ipfsRegistryUrl: config.ipfsRegistryUrl,
        },
      });
      conformance = {
        overall: report.overall,
        envelopeTier: report.envelopeTier,
        summary: report.summary,
        layer1Passed: report.layer1Passed,
        layer2Passed: report.layer2Passed,
        checks: report.checks,
      };
    } catch (err) {
      conformance = { overall: 'ERROR', error: errorMessage(err) };
    }
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'evidence show',
      envelope: summary,
      ...(conformance ? { conformance } : {}),
    },
    renderShowHuman,
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

// ── evidence find ─────────────────────────────────────────────────────────────

function renderFindHuman(value: unknown): string {
  const v = value as {
    taskId: string;
    role: string;
    status: string;
    reason?: string;
    envelopeCids: string[];
    publisherAgentId?: string;
    operator?: string;
    requestId?: string;
  };
  const lines: string[] = [];
  lines.push(`Task ${v.taskId} (${v.role}): ${v.status}${v.reason ? ` — ${v.reason}` : ''}`);
  if (v.envelopeCids.length === 0) {
    lines.push('  No envelope CID yet.');
  } else {
    for (const cid of v.envelopeCids) lines.push(`  ${cid}`);
    if (v.publisherAgentId) lines.push(`  Publisher agent: ${v.publisherAgentId}`);
    if (v.operator) lines.push(`  Operator: ${v.operator}`);
    if (v.requestId) lines.push(`  Request: ${v.requestId}`);
  }
  return lines.join('\n');
}

async function runFind(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        'task-id': { type: 'string' as const },
        role: { type: 'string' as const },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: errorMessage(err),
        exampleCli: FIND_EXAMPLE,
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const taskId = parsed.values['task-id'] as string | undefined;
  if (!taskId) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--task-id is required',
        exampleCli: FIND_EXAMPLE,
        details: { field: '--task-id', expected: 'on-chain task id (decimal string)' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const rawRole = (parsed.values.role as string | undefined) ?? 'solution';
  if (rawRole !== 'solution' && rawRole !== 'verdict') {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `--role must be 'solution' or 'verdict', got '${rawRole}'`,
        exampleCli: FIND_EXAMPLE,
        details: { field: '--role', expected: 'solution|verdict' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const role: AutopilotDeliveryRole = rawRole;

  const config = loadConfig(getConfigPathFromArgs(ctx.argv));
  const discoveryUrl = requireHttpDiscoveryUrl(ctx, config, FIND_EXAMPLE);
  if (!discoveryUrl) return;

  const chainId = CHAIN_ID_BY_NETWORK[config.network];

  let lookup;
  try {
    lookup = await createHttpDiscoveryClient({ url: discoveryUrl })
      .getAutopilotDeliveryCandidates({ chainId, taskId, role });
  } catch (err) {
    emitEnvelope(
      {
        code: 'transient_error',
        message: `Discovery lookup failed for task ${taskId}: ${errorMessage(err)}`,
        hint: 'Retry when the discovery indexer is reachable.',
        exampleCli: FIND_EXAMPLE,
        details: { taskId, role, chainId, discoveryUrl },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const base = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'evidence find',
    taskId,
    role,
    chainId,
  };
  const result =
    lookup.status === 'ready'
      ? {
          ...base,
          status: 'ready' as const,
          envelopeCids: [lookup.envelope.manifestCid],
          publisherAgentId: lookup.envelope.publisherAgentId,
          manifestHash: lookup.envelope.manifestHash,
          requestId: lookup.attempt.requestId,
          operator: lookup.attempt.operator,
        }
      : { ...base, status: lookup.status, reason: lookup.reason, envelopeCids: [] as string[] };

  emitResult(result, renderFindHuman, {
    json: Boolean(parsed.values.json),
    human: Boolean(parsed.values.human),
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

// ── evidence fetch ────────────────────────────────────────────────────────────

/**
 * Failure reasons the primitive can return, mapped onto the closed CLI error
 * code set. The asymmetry with `show --verify` is deliberate: a tier mismatch
 * there is a legitimate read and never reddens the exit, whereas a digest
 * mismatch here is the integrity failure the whole retrieval path exists to
 * catch, so it must exit non-zero.
 *
 * `no_locator` is defensive — `ArtifactSchema` requires `access.endpoint`, so a
 * schema-valid envelope always names at least one locator.
 */
const FETCH_ERROR_CODES: Record<ArtifactFetchFailureReason, 'transient_error' | 'fatal' | 'invalid_invocation'> = {
  timeout: 'transient_error',
  unavailable: 'transient_error',
  not_found: 'fatal',
  blocked: 'fatal',
  too_large: 'fatal',
  digest_mismatch: 'fatal',
  no_locator: 'invalid_invocation',
};

function renderFetchHuman(value: unknown): string {
  const v = value as {
    sha256: string;
    artifactType: string;
    sizeBytes: number;
    verified: boolean;
    provenance: { source: string; sourceUri: string };
  };
  // Deliberately five lines and no payload: a terminal is not a place to put a
  // binary blob. Use --json when you want the bytes.
  return [
    `Artifact ${v.sha256}`,
    `  Type   : ${v.artifactType}`,
    `  Size   : ${v.sizeBytes} bytes`,
    `  Source : ${v.provenance.source} ${v.provenance.sourceUri}`,
    `  Status : ${v.verified ? 'verified against the recorded sha256' : 'unverified'}`,
  ].join('\n');
}

async function runFetch(ctx: CommandContext, deps: EvidenceDeps): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        'envelope-cid': { type: 'string' as const },
        sha256: { type: 'string' as const },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: errorMessage(err),
        exampleCli: FETCH_EXAMPLE,
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const envelopeCid = parsed.values['envelope-cid'] as string | undefined;
  if (!envelopeCid) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--envelope-cid is required',
        exampleCli: FETCH_EXAMPLE,
        details: { field: '--envelope-cid', expected: 'non-empty string IPFS CID' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const config = loadConfig(getConfigPathFromArgs(ctx.argv));

  // Same envelope path `show` uses, so the two subverbs cannot disagree about
  // what an envelope says.
  let bytes: Uint8Array;
  try {
    bytes = await fetchSignedEnvelopeBytesRaw(config.ipfsGatewayUrl, envelopeCid);
  } catch (err) {
    emitEnvelope(
      {
        code: 'transient_error',
        message: `Could not fetch envelope ${envelopeCid}: ${errorMessage(err)}`,
        hint: 'Retry when the IPFS gateway is reachable, or set ipfsGatewayUrl to a gateway that pins this CID.',
        exampleCli: FETCH_EXAMPLE,
        details: { envelopeCid, gateway: config.ipfsGatewayUrl },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  let envelope: SignedEnvelope;
  try {
    envelope = SignedEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Bytes at ${envelopeCid} are not a jinn.execution.v1 signed envelope: ${errorMessage(err)}`,
        hint: 'Run `jinn conformance --envelope-cid <cid>` for the per-check breakdown.',
        exampleCli: FETCH_EXAMPLE,
        details: { field: '--envelope-cid', envelopeCid },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const catalog = envelope.artifacts.map((a) => ({ artifactType: a.artifactType, sha256: a.sha256 }));
  const requestedSha = parsed.values.sha256 as string | undefined;
  const artifact = requestedSha
    ? envelope.artifacts.find((a) => a.sha256 === requestedSha)
    : envelope.artifacts.length === 1
      ? envelope.artifacts[0]
      : undefined;

  if (!artifact) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: requestedSha
          ? `Envelope ${envelopeCid} names no artifact with sha256 ${requestedSha}`
          : `Envelope ${envelopeCid} carries ${catalog.length} artifacts; name one with --sha256`,
        hint: 'Pick a sha256 from the artifacts listed in details, or run `jinn evidence show` first.',
        exampleCli: `jinn evidence fetch --envelope-cid ${envelopeCid} --sha256 <hex>`,
        details: { field: '--sha256', envelopeCid, artifacts: catalog },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const retrieved = await deps.fetchVerifiedArtifact(
    { sha256: artifact.sha256, artifactType: artifact.artifactType },
    {
      sources: artifact.sources,
      ipfsGatewayUrl: config.ipfsGatewayUrl,
      endpoint: artifact.access.endpoint,
      envelopeCid,
      ownerSafe: envelope.participant.safeAddress,
    },
  );

  if (!retrieved.ok) {
    emitEnvelope(
      {
        code: FETCH_ERROR_CODES[retrieved.reason],
        message: retrieved.message,
        hint: retrieved.reason === 'digest_mismatch'
          ? 'The source returned bytes that are not the artifact this envelope names. Nothing was written; report the operator in sourceOperator.'
          : retrieved.retryable
            ? 'Nothing was learned about whether the artifact exists — retry.'
            : 'The source answered, and the answer was final for this address.',
        exampleCli: FETCH_EXAMPLE,
        details: {
          envelopeCid,
          sha256: artifact.sha256,
          reason: retrieved.reason,
          retryable: retrieved.retryable,
          attempts: retrieved.attempts,
          ...(retrieved.mismatch ?? {}),
        },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'evidence fetch',
      envelopeCid,
      sha256: retrieved.artifact.sha256,
      artifactType: retrieved.artifact.artifactType,
      sizeBytes: retrieved.artifact.bytes.length,
      verified: true,
      // Unconditional in JSON mode: a verb that returns everything except the
      // deliverable is the complaint this subverb exists to answer. Where the
      // bytes land is the caller's decision — `fetch` writes no files.
      contentBase64: retrieved.artifact.bytes.toString('base64'),
      provenance: retrieved.artifact.provenance,
    },
    renderFetchHuman,
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

// ── dispatch ──────────────────────────────────────────────────────────────────

export function createEvidenceCommand(deps: EvidenceDeps = PRODUCTION_DEPS): CommandModule {
  async function run(ctx: CommandContext): Promise<void> {
    const [subverb, ...rest] = ctx.argv;
    if (!subverb || subverb === '--help' || subverb === '-h') {
      ctx.writer.write(HELP_TEXT + '\n');
      return;
    }
    if (subverb === 'show') return runShow({ ...ctx, argv: rest });
    if (subverb === 'find') return runFind({ ...ctx, argv: rest });
    if (subverb === 'fetch') return runFetch({ ...ctx, argv: rest }, deps);
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown evidence subverb: ${subverb}`,
        exampleCli: SHOW_EXAMPLE,
        details: { field: 'subverb', expected: 'show|find|fetch' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
  }

  return {
    name: 'evidence',
    summary: 'Read delivered evidence — resolve a task id to an envelope, and an envelope to its result',
    helpText: HELP_TEXT,
    run,
  };
}

const HELP_TEXT = `Usage:
  jinn evidence show --envelope-cid <cid> [--verify] [--json|--human]
  jinn evidence find --task-id <id> [--role solution|verdict] [--json|--human]
  jinn evidence fetch --envelope-cid <cid> [--sha256 <hex>] [--json|--human]

All three subverbs are read-only: config-only, no keystore, no signer, no
daemon, no bootstrap. Together with \`jinn tasks submit\` and \`jinn tasks watch\`
they close the post -> deliver -> retrieve loop.

show
  Fetches the signed envelope bytes from IPFS and prints its identifying
  fields: envelope CID + digest, kind (solverType), role, evidence tier,
  operator Safe/EOA, task provenance, artifacts, trajectory reference, and the
  verdict when the envelope carries one.

  --envelope-cid <cid>  IPFS CID of the SignedEnvelope (required)
  --verify              Also run the conformance suite and fold the report in.
                        This NEVER changes the exit code — a self-signed-tier
                        envelope that fails an attested-tier check is still a
                        successful read. Use \`jinn conformance\` when you want
                        a pass/fail exit code.

find
  Resolves an on-chain task id to the envelope CID delivered for it.

  --task-id <id>        On-chain task id, decimal string (required)
  --role <role>         solution (default) | verdict

  Statuses: 'ready' (envelopeCids populated), 'pending' (not indexed yet),
  'contradiction' (the indexer holds inconsistent rows). All three exit 0 —
  the status field carries the outcome.

fetch
  Retrieves the artifact an envelope names and returns its bytes, having
  verified them against the sha256 the envelope records. A digest mismatch
  fails closed: no bytes are returned and the exit code is non-zero.

  --envelope-cid <cid>  IPFS CID of the SignedEnvelope (required)
  --sha256 <hex>        Which artifact to fetch. Required only when the
                        envelope names more than one; the error lists them.

  JSON output carries the bytes as contentBase64 plus the provenance of the
  source they came from. --human prints a summary and never the bytes. The
  verb writes no files and takes no output path — where the bytes land is
  the caller's decision.

Requires an HTTP discovery indexer (find only):
  config: discovery.mode = "http", discovery.url = "<indexer url>"
  env:    JINN_DISCOVERY_MODE=http, JINN_DISCOVERY_URL=<indexer url>
  There is no fall-through to the on-chain floor — the floor cannot resolve a
  task id to an envelope, so a silent fallback would report a delivered task
  as missing.

Examples:
  jinn evidence find --task-id 42 --json
  jinn evidence show --envelope-cid bafybeiabc123... --human
  jinn evidence show --envelope-cid bafybeiabc123... --verify --json
  jinn evidence fetch --envelope-cid bafybeiabc123... --json
`;

const command: CommandModule = createEvidenceCommand();

export default command;
