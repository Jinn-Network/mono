import { createHash } from 'node:crypto';
import 'dotenv/config';
import { getMechChainConfig, getServicePrivateKey } from '../env/operate-profile.js';
import { config } from '../config/index.js';
import {
  buildErc8128IdempotencyKey,
  createPrivateKeyHttpSigner,
  resolveChainId,
  signRequestWithErc8128,
  type Erc8128Signer,
} from '../http/erc8128.js';

type Json = Record<string, any> | any[] | string | number | boolean | null;

export type JobReportInput = {
  status: string;
  duration_ms: number;
  total_tokens?: number;
  tools_called?: Json;
  final_output?: string | null;
  error_message?: string | null;
  error_type?: string | null;
  raw_telemetry?: Json;
};

export type ArtifactInput = {
  cid: string;
  topic: string;
  content?: string | null;
};

export type MessageInput = {
  content: string;
  status?: string;
};

const CONTROL_API_URL = config.services.controlApiUrl;

let cachedControlApiSigner: Erc8128Signer | null = null;

/**
 * Reset the cached signer so the next call re-derives from the current
 * active service key. Must be called after service rotation.
 */
export function resetControlApiSigner(): void {
  cachedControlApiSigner = null;
}

function getControlApiSigner(): Erc8128Signer {
  if (cachedControlApiSigner) return cachedControlApiSigner;

  const privateKey = getServicePrivateKey();
  if (!privateKey) {
    throw new Error('Service private key not found in .operate config or environment');
  }

  const chainId = resolveChainId(String(config.chain.chainId) || getMechChainConfig() || 'base');
  cachedControlApiSigner = createPrivateKeyHttpSigner(privateKey as `0x${string}`, chainId);
  return cachedControlApiSigner;
}

function buildIdempotencyKey(parts: Array<string | number | null | undefined>): string {
  return buildErc8128IdempotencyKey(parts);
}

async function postSignedGraphql(body: any, idempotencyKey: string, attempt: number): Promise<any> {
  const signer = getControlApiSigner();
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

  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    throw new Error(`Control API returned invalid JSON on attempt ${attempt + 1}: ${String(err)}`);
  }

  if (!json || json.errors) {
    const msg = json?.errors?.map((e: any) => e?.message).join('; ') || 'GraphQL error';
    throw new Error(msg);
  }

  return json;
}

async function fetchWithRetry(body: any, idempotencyKey: string, attempt = 0): Promise<any> {
  try {
    return await postSignedGraphql(body, idempotencyKey, attempt);
  } catch (err) {
    if (attempt < 3) {
      const backoffMs = Math.pow(2, attempt) * 500;
      await new Promise(r => setTimeout(r, backoffMs));
      return fetchWithRetry(body, idempotencyKey, attempt + 1);
    }
    throw err;
  }
}

export async function claimRequest(requestId: string): Promise<{ request_id: string; status: string; claimed_at?: string; alreadyClaimed?: boolean }> {
  const idempotencyKey = buildIdempotencyKey([requestId, 'claim']);
  const query = `mutation Claim($requestId: String!) { claimRequest(requestId: $requestId) { request_id status claimed_at alreadyClaimed } }`;
  try {
    const json = await fetchWithRetry({ query, variables: { requestId } }, idempotencyKey);
    const claim = json.data.claimRequest;
    // Control API returns alreadyClaimed=true if another worker has active claim
    return claim;
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes('already claimed')) {
      return { request_id: requestId, status: 'IN_PROGRESS', alreadyClaimed: true };
    }
    throw e;
  }
}

export async function claimParentDispatch(
  parentJobDefId: string,
  childJobDefId: string
): Promise<{ allowed: boolean; claimed_by?: string }> {
  const idempotencyKey = buildIdempotencyKey([childJobDefId, 'claim-parent']);
  const query = `mutation Claim($p: String!, $c: String!) { 
    claimParentDispatch(parentJobDefId: $p, childJobDefId: $c) { 
      allowed claimed_by 
    } 
  }`;
  const json = await fetchWithRetry({ query, variables: { p: parentJobDefId, c: childJobDefId } }, idempotencyKey);
  return json.data.claimParentDispatch;
}

export async function claimVentureDispatch(
  ventureId: string,
  templateId: string,
  scheduleTick: string
): Promise<{ allowed: boolean; claimed_by?: string }> {
  const idempotencyKey = buildIdempotencyKey([`${ventureId}:${templateId}`, 'claim-venture']);
  const query = `mutation ClaimVenture($v: String!, $t: String!, $s: String!) {
    claimVentureDispatch(ventureId: $v, templateId: $t, scheduleTick: $s) {
      allowed claimed_by
    }
  }`;
  const json = await fetchWithRetry({ query, variables: { v: ventureId, t: templateId, s: scheduleTick } }, idempotencyKey);
  return json.data.claimVentureDispatch;
}

export async function createJobReport(requestId: string, report: JobReportInput): Promise<string> {
  const idempotencyKey = buildIdempotencyKey([requestId, 'report']);
  const query = `mutation Report($requestId: String!, $data: JobReportInput!) { createJobReport(requestId: $requestId, reportData: $data) { id } }`;
  const json = await fetchWithRetry({ query, variables: { requestId, data: report } }, idempotencyKey);
  return json.data.createJobReport.id as string;
}

export async function createArtifact(requestId: string, artifact: ArtifactInput): Promise<string> {
  const idempotencyKey = buildIdempotencyKey([requestId, `artifact:${artifact.topic || 'default'}`]);
  const query = `mutation Artifact($requestId: String!, $data: ArtifactInput!) { createArtifact(requestId: $requestId, artifactData: $data) { id } }`;
  const json = await fetchWithRetry({ query, variables: { requestId, data: artifact } }, idempotencyKey);
  return json.data.createArtifact.id as string;
}

export async function createMessage(requestId: string, message: MessageInput): Promise<string> {
  const idempotencyKey = buildIdempotencyKey([requestId, `message:${message.status || 'PENDING'}`]);
  const query = `mutation Message($requestId: String!, $data: MessageInput!) { createMessage(requestId: $requestId, messageData: $data) { id } }`;
  const json = await fetchWithRetry({ query, variables: { requestId, data: message } }, idempotencyKey);
  return json.data.createMessage.id as string;
}

export async function claimTransactionRequest(): Promise<any | null> {
  const idempotencyKey = buildIdempotencyKey(['tx-claim', Date.now()]);
  const query = `mutation { claimTransactionRequest { id request_id worker_address chain_id execution_strategy status payload tx_hash safe_tx_hash error_code error_message created_at updated_at } }`;
  const json = await fetchWithRetry({ query, variables: {} }, idempotencyKey);
  return json.data?.claimTransactionRequest ?? null;
}

export async function updateTransactionStatus(args: { id: string; status: string; safe_tx_hash?: string; tx_hash?: string; error_code?: string; error_message?: string }): Promise<any> {
  const idempotencyKey = buildIdempotencyKey(['tx-update', args.id, args.status]);
  const query = `mutation UpdateTx($id: String!, $status: String!, $safe_tx_hash: String, $tx_hash: String, $error_code: String, $error_message: String) { updateTransactionStatus(id: $id, status: $status, safe_tx_hash: $safe_tx_hash, tx_hash: $tx_hash, error_code: $error_code, error_message: $error_message) { id status tx_hash safe_tx_hash error_code error_message updated_at } }`;
  const variables = { ...args } as any;
  const json = await fetchWithRetry({ query, variables }, idempotencyKey);
  return json.data.updateTransactionStatus;
}

export async function updateJobStatus(requestId: string, statusUpdate: string): Promise<string | null> {
  const report: JobReportInput = {
    status: 'IN_PROGRESS',
    duration_ms: 0, // Intermediate update
    raw_telemetry: JSON.stringify({ jobInstanceStatusUpdate: statusUpdate })
  };
  try {
    const statusHash = createHash('sha256').update(statusUpdate).digest('base64url').slice(0, 32);
    const idempotencyKey = buildIdempotencyKey([requestId, 'status-update', statusHash]);
    const query = `mutation Report($requestId: String!, $data: JobReportInput!) { createJobReport(requestId: $requestId, reportData: $data) { id } }`;
    const json = await fetchWithRetry({ query, variables: { requestId, data: report } }, idempotencyKey);
    return json?.data?.createJobReport?.id as string;
  } catch (e: any) {
    console.warn(`[updateJobStatus] Failed to send status update for ${requestId}: ${e?.message || e}`);
    return null;
  }
}
