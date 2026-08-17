#!/usr/bin/env tsx

/**
 * Live capture acceptance runner.
 *
 * Defaults are loaded from the same local operator state used by the UI:
 *   ~/.jinn-client/.env.testnet   optional env overrides
 *   ~/.jinn-client/config.json    apiPort, discovery.url, ipfsGatewayUrl
 *   ~/.jinn-client/ui-token       UI token accepted by /api/captures/*
 *
 * Environment overrides:
 *   JINN_DAEMON_URL        default http://127.0.0.1:<config.apiPort || 7331>
 *   JINN_UI_TOKEN          default ~/.jinn-client/ui-token
 *   JINN_DISCOVERY_URL     default config.discovery.url, else the testnet
 *                          Ponder indexer (DEFAULT_TESTNET_DISCOVERY_URL)
 *
 * Optional:
 *   JINN_CAPTURE_SESSION_ID     approve this pending session; otherwise first pending row
 *   JINN_IPFS_GATEWAY_URL       verify the signed envelope is fetchable from IPFS
 *   JINN_CAPTURE_INDEX_TIMEOUT_MS  how long to wait for the indexer to pick the envelope up
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeIpfsGatewayBase } from '../src/adapters/mech/ipfs.js';
import { distillCaptureToTasks } from '../src/solver-types/_session-derived-distill.js';
import { createHttpDiscoveryClient } from '../src/discovery-client/http.js';
import { DEFAULT_TESTNET_DISCOVERY_URL } from '../src/config.js';

interface CaptureSummary {
  sessionId: string;
  capturedAt: string;
  originatingTool: { name: string; version?: string };
  repoRemoteUrl?: string;
  repoCommitHash?: string;
}

interface CaptureDetail {
  capture: CaptureSummary;
  spans: Array<{ name: string; attributes: Record<string, unknown>; redactedKeys: string[] }>;
}

interface StepResult {
  step: string;
  ok: boolean;
  detail?: Record<string, unknown>;
}

interface DonationSource {
  kind: 'ipfs';
  cid: string;
  sha256: string;
  encoding: 'jinn.artifact.donation.v1';
}

interface CaptureEnvelopeArtifact {
  artifactType: string;
  sha256: string;
  sources?: DonationSource[];
}

interface CaptureEnvelopeForReadability {
  trajectory?: {
    sha256: string;
    sources?: DonationSource[];
  } | null;
  artifacts?: CaptureEnvelopeArtifact[];
}

const steps: StepResult[] = [];
const JINN_HOME = join(homedir(), '.jinn-client');
const DEFAULT_LOCAL_ENV_PATH = join(JINN_HOME, '.env.testnet');
const DEFAULT_CONFIG_PATH = join(JINN_HOME, 'config.json');
const DEFAULT_UI_TOKEN_PATH = join(JINN_HOME, 'ui-token');
const DEFAULT_IPFS_GATEWAY_URL = 'https://gateway.autonolas.tech';

loadLocalEnvFile(DEFAULT_LOCAL_ENV_PATH);

async function main(): Promise<void> {
  throw new Error(
    'Captures HTTP retired in Stage 6 Task 17. Use `jinn capture` (CLI). yarn e2e:capture is withdrawn.',
  );
  const localConfig = readLocalConfig();
  const daemonUrl = optionalEnv('JINN_DAEMON_URL') ?? defaultDaemonUrl(localConfig);
  const uiToken = optionalEnv('JINN_UI_TOKEN') ?? readUiToken();
  if (!uiToken) {
    throw new Error(`JINN_UI_TOKEN is required for live capture acceptance; set it or start the daemon so ${DEFAULT_UI_TOKEN_PATH} exists`);
  }
  const discoveryUrl =
    optionalEnv('JINN_DISCOVERY_URL') ??
    discoveryUrlFromConfig(localConfig) ??
    DEFAULT_TESTNET_DISCOVERY_URL;
  const ipfsGatewayUrl =
    optionalEnv('JINN_IPFS_GATEWAY_URL') ??
    stringConfig(localConfig, 'ipfsGatewayUrl') ??
    DEFAULT_IPFS_GATEWAY_URL;

  const pending = await daemonJson<{ captures: CaptureSummary[] }>(
    daemonUrl,
    '/api/captures/pending',
    uiToken,
  );
  steps.push({ step: 'capture.pending', ok: pending.captures.length > 0, detail: { count: pending.captures.length } });
  if (pending.captures.length === 0) {
    throw new Error('No pending captures found. Run a tool session first or set JINN_CAPTURE_SESSION_ID for an existing pending capture.');
  }

  const requestedSessionId = process.env['JINN_CAPTURE_SESSION_ID'];
  const selected = requestedSessionId
    ? pending.captures.find((capture) => capture.sessionId === requestedSessionId)
    : pending.captures[0];
  if (!selected) {
    throw new Error(`Pending capture not found for JINN_CAPTURE_SESSION_ID=${requestedSessionId}`);
  }

  const detail = await daemonJson<CaptureDetail>(
    daemonUrl,
    `/api/captures/${encodeURIComponent(selected.sessionId)}`,
    uiToken,
  );
  steps.push({
    step: 'capture.detail',
    ok: detail.spans.length > 0,
    detail: { sessionId: selected.sessionId, spans: detail.spans.length },
  });

  const approved = await daemonJson<{ envelopeCid: string; publishedAt: string }>(
    daemonUrl,
    `/api/captures/${encodeURIComponent(selected.sessionId)}/approve`,
    uiToken,
    { method: 'POST' },
  );
  steps.push({
    step: 'capture.approve_publish',
    ok: approved.envelopeCid.length > 0,
    detail: { envelopeCid: approved.envelopeCid, publishedAt: approved.publishedAt },
  });

  if (ipfsGatewayUrl) {
    const envelope = await fetchIpfsJson(ipfsGatewayUrl, approved.envelopeCid);
    steps.push({
      step: 'ipfs.envelope_fetch',
      ok: typeof envelope === 'object' && envelope !== null,
      detail: { envelopeCid: approved.envelopeCid },
    });
    const trajectory = await fetchReadableCaptureTrajectory(ipfsGatewayUrl, envelope);
    if (trajectory.spans !== detail.spans.length || trajectory.redactionSpans !== detail.spans.length) {
      throw new Error(
        `published trajectory span count mismatch: expected ${detail.spans.length}, got ` +
        `${trajectory.spans} spans and ${trajectory.redactionSpans} redaction entries`,
      );
    }
    steps.push({
      step: 'ipfs.trajectory_fetch',
      ok: true,
      detail: {
        cid: trajectory.cid,
        sha256: trajectory.sha256,
        spans: trajectory.spans,
        redactionSpans: trajectory.redactionSpans,
      },
    });
  }

  const indexed = await waitForCaptureIndex(discoveryUrl, approved.envelopeCid);
  steps.push({
    step: 'indexer.capture_index',
    ok: true,
    detail: indexed,
  });

  const generated = await distillCaptureToTasks({
    envelope: {
      schemaVersion: 'jinn.execution.v1',
      solverType: 'capture',
      role: 'capture',
      generatedAt: Math.floor(Date.now() / 1000),
      sessionProvenance: {
        sessionId: detail.capture.sessionId,
        capturedAt: detail.capture.capturedAt,
        originatingTool: detail.capture.originatingTool,
        ...(detail.capture.repoRemoteUrl || detail.capture.repoCommitHash
          ? {
              repo: {
                ...(detail.capture.repoRemoteUrl ? { remoteUrl: detail.capture.repoRemoteUrl } : {}),
                ...(detail.capture.repoCommitHash ? { commitHash: detail.capture.repoCommitHash } : {}),
              },
            }
          : {}),
        license: { operatorAssertion: 'unspecified' },
      },
      participant: { safeAddress: '0x0000000000000000000000000000000000000000', agentEoa: '0x0000000000000000000000000000000000000000' },
      window: { startTs: 0, endTs: 0 },
      executor: {
        implName: detail.capture.originatingTool.name,
        implVersion: detail.capture.originatingTool.version ?? 'unknown',
        clientGitSha: 'acceptance',
        codeDigest: `sha256:${'0'.repeat(64)}`,
        runtimeBundleDigest: `sha256:${'0'.repeat(64)}`,
        plugins: [],
        signingKey: { kind: 'agent-eoa', pubkey: '0x0000000000000000000000000000000000000000' },
        mode: 'train',
      },
      evidenceTier: 'self-signed',
      attestation: null,
      trajectory: null,
      artifacts: [],
      payload: {},
      signature: { algo: 'secp256k1', signer: '0x0000000000000000000000000000000000000000', hash: `0x${'1'.repeat(64)}`, sig: '0x' },
    } as any,
    sourceCaptureCid: approved.envelopeCid,
    trajectoryText: JSON.stringify(detail.spans),
    model: 'acceptance-fixture',
    now: new Date(),
    distill: async () => [{
      problemStatement: `Reproduce and solve the captured ${detail.capture.originatingTool.name} session ${detail.capture.sessionId}.`,
      expectedArtifacts: {},
      signalHints: detail.spans.slice(0, 5).map((span) => span.name),
    }],
  });
  steps.push({
    step: 'session_derived.generate',
    ok: generated.accepted.length > 0,
    detail: { tasks: generated.accepted.length, sourceCaptureCid: approved.envelopeCid },
  });

  console.log(JSON.stringify({ ok: true, steps }, null, 2));
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function loadLocalEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readLocalConfig(): Record<string, unknown> {
  if (!existsSync(DEFAULT_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to parse ${DEFAULT_CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function stringConfig(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function defaultDaemonUrl(config: Record<string, unknown>): string {
  const rawPort = config['apiPort'];
  const port = typeof rawPort === 'number'
    ? rawPort
    : typeof rawPort === 'string'
      ? Number(rawPort)
      : 7331;
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 7331}`;
}

function readUiToken(): string | undefined {
  if (!existsSync(DEFAULT_UI_TOKEN_PATH)) return undefined;
  const token = readFileSync(DEFAULT_UI_TOKEN_PATH, 'utf8').trim();
  return token || undefined;
}

async function daemonJson<T>(
  daemonUrl: string,
  path: string,
  uiToken: string,
  init: RequestInit = {},
): Promise<T> {
  const url = new URL(path, daemonUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'x-jinn-ui-token': uiToken,
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(`Daemon ${url.href} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Daemon ${path} HTTP ${response.status}: ${body}`);
  }
  return JSON.parse(body) as T;
}

async function fetchIpfsJson(gatewayUrl: string, cid: string): Promise<unknown> {
  const response = await fetch(new URL(cid, normalizeIpfsGatewayBase(gatewayUrl)));
  if (!response.ok) throw new Error(`IPFS fetch ${cid} HTTP ${response.status}`);
  return response.json();
}

async function fetchReadableCaptureTrajectory(
  gatewayUrl: string,
  envelopeRaw: unknown,
): Promise<{ cid: string; sha256: string; spans: number; redactionSpans: number }> {
  const envelope = parseCaptureEnvelopeForReadability(envelopeRaw);
  const source = findTrajectorySource(envelope);
  const wrapper = await fetchIpfsJson(gatewayUrl, source.cid);
  const trajectoryBytes = decodeDonationWrapper(wrapper, source.sha256);
  const actualSha256 = sha256Hex(trajectoryBytes);
  if (actualSha256 !== source.sha256) {
    throw new Error(`trajectory source sha256 mismatch: expected ${source.sha256}, got ${actualSha256}`);
  }
  const trajectory = JSON.parse(trajectoryBytes.toString('utf8')) as {
    schemaVersion?: unknown;
    spans?: unknown;
    redactionManifest?: { spans?: unknown };
  };
  if (trajectory.schemaVersion !== 'jinn.capture-trajectory.v1') {
    throw new Error(`trajectory has unexpected schemaVersion: ${String(trajectory.schemaVersion)}`);
  }
  if (!Array.isArray(trajectory.spans)) {
    throw new Error('trajectory is missing spans[]');
  }
  const redactionSpans = trajectory.redactionManifest && Array.isArray(trajectory.redactionManifest.spans)
    ? trajectory.redactionManifest.spans.length
    : 0;
  return {
    cid: source.cid,
    sha256: source.sha256,
    spans: trajectory.spans.length,
    redactionSpans,
  };
}

function parseCaptureEnvelopeForReadability(raw: unknown): CaptureEnvelopeForReadability {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('published envelope is not an object');
  }
  return raw as CaptureEnvelopeForReadability;
}

function findTrajectorySource(envelope: CaptureEnvelopeForReadability): DonationSource {
  const trajectorySha = envelope.trajectory?.sha256;
  const direct = envelope.trajectory?.sources?.find((source) => source.kind === 'ipfs');
  if (direct) return validateTrajectorySource(direct, trajectorySha);

  const artifact = envelope.artifacts?.find((candidate) =>
    candidate.artifactType === 'jinn.trajectory.v1' &&
    (!trajectorySha || candidate.sha256 === trajectorySha)
  );
  const source = artifact?.sources?.find((candidate) => candidate.kind === 'ipfs');
  if (!source) {
    throw new Error('published capture envelope does not expose a readable IPFS trajectory source');
  }
  return validateTrajectorySource(source, trajectorySha);
}

function validateTrajectorySource(source: DonationSource, trajectorySha?: string): DonationSource {
  if (source.encoding !== 'jinn.artifact.donation.v1') {
    throw new Error(`trajectory source has unexpected encoding: ${source.encoding}`);
  }
  if (trajectorySha && source.sha256 !== trajectorySha) {
    throw new Error(`trajectory source sha256 ${source.sha256} does not match envelope trajectory ${trajectorySha}`);
  }
  return source;
}

function decodeDonationWrapper(raw: unknown, expectedSha256: string): Buffer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('trajectory donation wrapper is not an object');
  }
  const wrapper = raw as Record<string, unknown>;
  if (
    wrapper['schemaVersion'] !== 'jinn.artifact.donation.v1' ||
    wrapper['encoding'] !== 'jinn.artifact.donation.v1'
  ) {
    throw new Error('trajectory donation wrapper has unexpected encoding');
  }
  if (wrapper['sha256'] !== expectedSha256) {
    throw new Error('trajectory donation wrapper sha256 does not match envelope source');
  }
  if (typeof wrapper['data'] !== 'string') {
    throw new Error('trajectory donation wrapper is missing base64 data');
  }
  return Buffer.from(wrapper['data'], 'base64');
}

function sha256Hex(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function discoveryUrlFromConfig(config: Record<string, unknown>): string | undefined {
  const discovery = config['discovery'];
  if (discovery && typeof discovery === 'object' && !Array.isArray(discovery)) {
    const url = (discovery as Record<string, unknown>)['url'];
    if (typeof url === 'string' && url.trim().length > 0) return url.trim();
  }
  return undefined;
}

/**
 * Wait for the published capture envelope to show up in the Ponder discovery
 * indexer. `queryEnvelopes` returns recent envelopes across all SolverNets
 * (the indexer has no server-side filter for a single CID — solverType lives
 * in the IPFS manifest, not the on-chain payload), so we scan the most-recent
 * page for the matching `manifestCid` and retry until it lands.
 */
async function waitForCaptureIndex(
  discoveryUrl: string,
  envelopeCid: string,
  timeoutMs = Number(process.env['JINN_CAPTURE_INDEX_TIMEOUT_MS'] ?? 120_000),
): Promise<Record<string, unknown>> {
  const discovery = createHttpDiscoveryClient({ url: discoveryUrl });
  const started = Date.now();
  let lastError = 'not indexed yet';
  while (Date.now() - started < timeoutMs) {
    try {
      const refs = await discovery.queryEnvelopes({ limit: 500 });
      const match = refs.find((ref) => ref.manifestCid === envelopeCid);
      if (match) {
        return {
          manifestCid: match.manifestCid,
          manifestHash: match.manifestHash,
          agentId: match.operator.agentId,
          evidenceTier: match.evidenceTier,
          publishedAt: match.publishedAt,
        };
      }
      lastError = `not indexed yet (scanned ${refs.length} recent envelopes)`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`capture envelope ${envelopeCid} was not indexed before timeout: ${lastError}`);
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    steps,
  }, null, 2));
  process.exit(1);
});
