/**
 * `jinn evidence` verb — the read side of the quickstart loop.
 *
 * Two READ-ONLY subverbs turn an identifier into a result:
 *   jinn evidence show --envelope-cid <cid> [--verify]
 *   jinn evidence find --task-id <id> [--role solution|verdict]
 *
 * Both are config-only: no keystore, no signer, no daemon, no bootstrap. They
 * read IPFS (show) and the HTTP discovery indexer (find) and nothing else.
 */

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
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

// ── dispatch ──────────────────────────────────────────────────────────────────

async function run(ctx: CommandContext): Promise<void> {
  const [subverb, ...rest] = ctx.argv;
  if (!subverb || subverb === '--help' || subverb === '-h') {
    ctx.writer.write(command.helpText + '\n');
    return;
  }
  if (subverb === 'show') return runShow({ ...ctx, argv: rest });
  if (subverb === 'find') return runFind({ ...ctx, argv: rest });
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: `Unknown evidence subverb: ${subverb}`,
      exampleCli: SHOW_EXAMPLE,
      details: { field: 'subverb', expected: 'show|find' },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'evidence',
  summary: 'Read delivered evidence — resolve a task id to an envelope, and an envelope to its result',
  helpText: `Usage:
  jinn evidence show --envelope-cid <cid> [--verify] [--json|--human]
  jinn evidence find --task-id <id> [--role solution|verdict] [--json|--human]

Both subverbs are read-only: config-only, no keystore, no signer, no daemon,
no bootstrap. Together with \`jinn tasks submit\` and \`jinn tasks watch\` they
close the post -> deliver -> retrieve loop.

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
`,
  run,
};

export default command;
