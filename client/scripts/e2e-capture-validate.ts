#!/usr/bin/env tsx

/**
 * Live capture acceptance runner.
 *
 * Defaults are loaded from the same local operator state used by the UI:
 *   ~/.jinn-client/.env.testnet   deploy slug/key + optional env overrides
 *   ~/.jinn-client/config.json    apiPort, subgraphUrl, ipfsGatewayUrl
 *   ~/.jinn-client/ui-token       UI token accepted by /api/captures/*
 *
 * Environment overrides:
 *   JINN_DAEMON_URL        default http://127.0.0.1:<config.apiPort || 7331>
 *   JINN_UI_TOKEN          default ~/.jinn-client/ui-token
 *   JINN_SUBGRAPH_URL      default config.subgraphUrl
 *
 * Optional:
 *   JINN_CAPTURE_SESSION_ID     approve this pending session; otherwise first pending row
 *   JINN_IPFS_GATEWAY_URL       verify the signed envelope is fetchable from IPFS
 *   JINN_CAPTURE_DEPLOY_SUBGRAPH=1  run subgraph deploy:base-sepolia before validation
 *   JINN_SUBGRAPH_STUDIO_SLUG   Studio slug used when deploying the subgraph
 *   GRAPH_STUDIO_DEPLOY_KEY     optional deploy key passed to graph deploy
 *   JINN_SUBGRAPH_VERSION_LABEL optional graph deploy version label
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeIpfsGatewayBase } from '../src/adapters/mech/ipfs.js';
import { distillCaptureToTasks } from '../src/solver-types/_session-derived-distill.js';

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

const steps: StepResult[] = [];
const JINN_HOME = join(homedir(), '.jinn-client');
const DEFAULT_LOCAL_ENV_PATH = join(JINN_HOME, '.env.testnet');
const DEFAULT_CONFIG_PATH = join(JINN_HOME, 'config.json');
const DEFAULT_UI_TOKEN_PATH = join(JINN_HOME, 'ui-token');

loadLocalEnvFile(DEFAULT_LOCAL_ENV_PATH);

async function main(): Promise<void> {
  const localConfig = readLocalConfig();
  const daemonUrl = optionalEnv('JINN_DAEMON_URL') ?? defaultDaemonUrl(localConfig);
  const uiToken = optionalEnv('JINN_UI_TOKEN') ?? readUiToken();
  if (!uiToken) {
    throw new Error(`JINN_UI_TOKEN is required for live capture acceptance; set it or start the daemon so ${DEFAULT_UI_TOKEN_PATH} exists`);
  }
  const subgraphUrl = optionalEnv('JINN_SUBGRAPH_URL') ?? stringConfig(localConfig, 'subgraphUrl');
  if (!subgraphUrl) {
    throw new Error(`JINN_SUBGRAPH_URL is required for live capture acceptance; set it or add subgraphUrl to ${DEFAULT_CONFIG_PATH}`);
  }
  const ipfsGatewayUrl = optionalEnv('JINN_IPFS_GATEWAY_URL') ?? stringConfig(localConfig, 'ipfsGatewayUrl');

  if (process.env['JINN_CAPTURE_DEPLOY_SUBGRAPH'] === '1') {
    deploySubgraph();
    steps.push({ step: 'subgraph.deploy', ok: true });
  }

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
  }

  const indexed = await waitForCaptureIndex(subgraphUrl, approved.envelopeCid);
  steps.push({
    step: 'subgraph.capture_index',
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

function requiredSetting(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`${name} is required for this live capture acceptance step`);
  return value;
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

async function waitForCaptureIndex(
  subgraphUrl: string,
  envelopeCid: string,
  timeoutMs = Number(process.env['JINN_CAPTURE_INDEX_TIMEOUT_MS'] ?? 120_000),
): Promise<Record<string, unknown>> {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(subgraphUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query Capture($id: ID!) {
          captureEnvelope(id: $id) {
            id
            manifestCid
            publishedAt
            operator { id }
          }
        }`,
        variables: { id: envelopeCid },
      }),
    });
    const body = await response.json() as {
      data?: { captureEnvelope?: Record<string, unknown> | null };
      errors?: Array<{ message: string }>;
    };
    if (body.data?.captureEnvelope) return body.data.captureEnvelope;
    lastError = body.errors?.map((err) => err.message).join('; ') ?? 'not indexed yet';
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`capture:${envelopeCid} was not indexed before timeout: ${lastError}`);
}

function deploySubgraph(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const subgraphDir = resolve(here, '..', '..', 'subgraph');
  const slug = requiredSetting('JINN_SUBGRAPH_STUDIO_SLUG');
  const args = [
    'exec',
    'graph',
    'deploy',
    slug,
    '--node',
    'https://api.studio.thegraph.com/deploy/',
    '--ipfs',
    'https://api.thegraph.com/ipfs/',
    '--network',
    'base-sepolia',
    '--network-file',
    'networks.json',
  ];
  const deployKey = process.env['GRAPH_STUDIO_DEPLOY_KEY']?.trim();
  if (deployKey) args.push(`--deploy-key=${deployKey}`);
  const versionLabel = process.env['JINN_SUBGRAPH_VERSION_LABEL']?.trim();
  if (versionLabel) args.push('--version-label', versionLabel);

  const result = spawnSync('yarn', args, {
    cwd: subgraphDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`subgraph deploy failed with exit code ${result.status ?? 'unknown'}`);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    steps,
  }, null, 2));
  process.exit(1);
});
