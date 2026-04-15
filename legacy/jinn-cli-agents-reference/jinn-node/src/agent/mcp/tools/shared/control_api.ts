import { mcpLogger } from '../../../../logging/index.js';
import {
  buildErc8128IdempotencyKey,
  signRequestWithErc8128,
  type Erc8128Signer,
} from '../../../../http/erc8128.js';
import { createProxyHttpSigner } from '../../../shared/signing-proxy-client.js';

import { config } from '../../../../config/index.js';

type RequestClaim = {
  request_id: string;
  worker_address: string;
  status: string;
  claimed_at: string;
  completed_at?: string | null;
};

type JobReportInput = {
  status: string;
  duration_ms: number;
  total_tokens?: number | null;
  tools_called?: string | null; // JSON string
  final_output?: string | null;
  error_message?: string | null;
  error_type?: string | null;
  raw_telemetry?: string | null; // JSON string
};

type ArtifactInput = {
  cid: string;
  topic: string;
  content?: string | null;
};

type MessageInput = {
  content: string;
  status?: string;
};

const CONTROL_API_URL = config.services.controlApiUrl;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000; // 1 second

let signerPromise: Promise<Erc8128Signer> | null = null;

async function getControlApiSigner(): Promise<Erc8128Signer> {
  if (!signerPromise) {
    signerPromise = createProxyHttpSigner(config.chain.chainId);
  }
  return signerPromise;
}

function buildIdempotencyKey(requestId: string, operationType: string): string {
  return buildErc8128IdempotencyKey([requestId, operationType]);
}

async function postSignedGraphql(
  body: { query: string; variables?: Record<string, any> },
  idempotencyKey: string,
): Promise<any> {
  const signer = await getControlApiSigner();
  const request = await signRequestWithErc8128({
    signer,
    input: CONTROL_API_URL,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
    signOptions: {
      label: 'eth',
      binding: 'request-bound',
      replay: 'non-replayable',
      ttlSeconds: 60,
    },
  });

  const response = await fetch(request);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Control API HTTP ${response.status}: ${text || response.statusText}`);
  }

  try {
    return text ? JSON.parse(text) : null;
  } catch (err) {
    throw new Error(`Control API returned invalid JSON: ${String(err)}`);
  }
}

async function fetchWithRetry(
  body: { query: string; variables?: Record<string, any> },
  idempotencyKey: string,
  attempts = RETRY_ATTEMPTS
): Promise<any> {
  let lastError: any;
  const startTime = Date.now();

  for (let i = 0; i < attempts; i++) {
    const operation = body.query.split('(')[0].split(' ')[1] || 'unknown';
    try {
      mcpLogger.debug({ attempt: i + 1, totalAttempts: attempts, operation }, 'Control API request attempt');

      const json = await postSignedGraphql(body, idempotencyKey);

      if (json?.errors) {
        throw new Error(`Control API GraphQL error: ${JSON.stringify(json.errors)}`);
      }

      const duration = Date.now() - startTime;
      mcpLogger.info({ duration, operation }, 'Control API request successful');
      return json;
    } catch (e: any) {
      lastError = e;
      const duration = Date.now() - startTime;
      mcpLogger.warn({ attempt: i + 1, totalAttempts: attempts, duration, error: e?.message || String(e) }, 'Control API request failed');
      if (i < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (i + 1)));
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  throw new Error(`Failed to call Control API after ${attempts} attempts (${totalDuration}ms): ${lastError?.message || String(lastError)}`);
}

export async function claimRequest(requestId: string): Promise<{ request_id: string; status: string }> {
  const idempotencyKey = buildIdempotencyKey(requestId, 'claim');
  const query = `mutation Claim($requestId: String!) { claimRequest(requestId: $requestId) { request_id status } }`;
  try {
    const json = await fetchWithRetry({ query, variables: { requestId } }, idempotencyKey);
    return json.data.claimRequest;
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes('already claimed')) {
      return { request_id: requestId, status: 'IN_PROGRESS' };
    }
    throw e;
  }
}

export async function createJobReport(requestId: string, report: JobReportInput): Promise<string> {
  const idempotencyKey = buildIdempotencyKey(requestId, 'report');
  const query = `mutation Report($requestId: String!, $data: JobReportInput!) { createJobReport(requestId: $requestId, reportData: $data) { id } }`;
  const json = await fetchWithRetry({ query, variables: { requestId, data: report } }, idempotencyKey);
  return json.data.createJobReport.id as string;
}

export async function createArtifact(requestId: string, artifact: ArtifactInput): Promise<string> {
  const idempotencyKey = buildIdempotencyKey(requestId, `artifact:${artifact.topic || 'default'}`);
  const query = `mutation Artifact($requestId: String!, $data: ArtifactInput!) { createArtifact(requestId: $requestId, artifactData: $data) { id } }`;
  const json = await fetchWithRetry({ query, variables: { requestId, data: artifact } }, idempotencyKey);
  return json.data.createArtifact.id as string;
}

export async function createMessage(requestId: string, message: MessageInput): Promise<string> {
  const idempotencyKey = buildIdempotencyKey(requestId, `message:${message.status || 'PENDING'}`);
  const query = `mutation Message($requestId: String!, $data: MessageInput!) { createMessage(requestId: $requestId, messageData: $data) { id } }`;
  const json = await fetchWithRetry({ query, variables: { requestId, data: message } }, idempotencyKey);
  return json.data.createMessage.id as string;
}

export function isControlApiEnabled(): boolean {
  return config.services.useControlApi;
}

export function shouldUseControlApi(tableName: string): boolean {
  if (!isControlApiEnabled()) return false;

  const onchainTables = ['onchain_request_claims', 'onchain_job_reports', 'onchain_artifacts', 'onchain_messages'];
  return onchainTables.includes(tableName);
}

export type { RequestClaim };
