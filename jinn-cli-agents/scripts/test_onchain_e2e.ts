/*
 End-to-end on-chain test:
 1) Post marketplace job via mech-client-ts
 2) Verify Ponder indexed Request
 3) (Optional) Exercise Control API claim/report/artifact for lineage & idempotency
 4) Verify worker delivers on-chain (Deliver event appears in Ponder)
*/

import axios from 'axios';
import { setTimeout as delay } from 'timers/promises';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { createPrivateKeyHttpSigner, type EthHttpSigner } from 'jinn-node/http/erc8128';
import { signRequest } from '@slicekit/erc8128';
import { privateKeyToAccount } from 'viem/accounts';

const PONDER_GRAPHQL_URL = process.env.PONDER_GRAPHQL_URL || `http://localhost:${process.env.PONDER_PORT || '42069'}/graphql`;
const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://localhost:4001/graphql';
const WORKER_PRIVATE_KEY = process.env.WORKER_PRIVATE_KEY || '';

// Build ERC-8128 signer from worker private key (if available)
let controlApiSigner: EthHttpSigner | null = null;
let TEST_WORKER_ADDRESS = '';
if (WORKER_PRIVATE_KEY) {
  const key = WORKER_PRIVATE_KEY as `0x${string}`;
  const account = privateKeyToAccount(key);
  controlApiSigner = createPrivateKeyHttpSigner(key, 8453);
  TEST_WORKER_ADDRESS = account.address;
}

async function gql(url: string, query: string, variables?: any) {
  const res = await axios.post(url, { query, variables }, { headers: { 'Content-Type': 'application/json' } });
  if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

async function postJob(): Promise<{ requestHex: string; txHash: string }> {
  const priorityMech = process.env.PRIORITY_MECH || '0xab15f8d064b59447bd8e9e89dd3fa770abf5eeb7';
  const prompt = 'E2E test: please echo this string.';
  const res: any = await marketplaceInteract({
    prompts: [prompt],
    priorityMech,
    tools: ['manage_artifact'],
    postOnly: true,
    chainConfig: 'base',
  });
  if (!res?.request_ids?.length) throw new Error('Failed to post marketplace request');
  const requestHex = String(res.request_ids[0]);
  const txHash = String(res.transaction_hash || res.transactionHash);
  return { requestHex, txHash };
}

async function waitForRequestIndexed(requestHex: string, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await gql(
      PONDER_GRAPHQL_URL,
      'query { requests { items { id } } }'
    );
    const items: any[] = data?.requests?.items || [];
    if (items.find((i) => i.id === requestHex)) return true;
    await delay(3000);
  }
  throw new Error('Request was not indexed by Ponder within timeout');
}

/**
 * Sign and send a Control API GraphQL request using ERC-8128.
 */
async function signedControlApiPost(query: string, variables?: any) {
  if (!controlApiSigner) throw new Error('No signer available');
  const body = JSON.stringify({ query, variables });

  const unsigned = new Request(CONTROL_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const signed = await signRequest(unsigned, controlApiSigner, {
    binding: 'request-bound',
    replay: 'non-replayable',
    ttlSeconds: 60,
  });

  const headers: Record<string, string> = {};
  signed.headers.forEach((v, k) => { headers[k] = v; });

  return axios.post(CONTROL_API_URL, { query, variables }, { headers });
}

async function controlApiClaim(requestHex: string) {
  if (!controlApiSigner) return; // skip if not configured
  const query = `mutation($id: ID!) { claimRequest(requestId: $id) { request_id worker_address status } }`;
  const res = await signedControlApiPost(query, { id: requestHex });
  if (res.data?.errors) throw new Error('Control API claim error: ' + JSON.stringify(res.data.errors));
  return res.data.data.claimRequest;
}

async function controlApiClaimIdempotent(requestHex: string) {
  if (!controlApiSigner) return; // skip if not configured
  const q = `mutation($id: ID!) { claimRequest(requestId: $id) { request_id worker_address status } }`;
  const p1 = signedControlApiPost(q, { id: requestHex });
  const p2 = signedControlApiPost(q, { id: requestHex });
  const [r1, r2] = await Promise.all([p1, p2]);
  if (r1.data?.errors) throw new Error(JSON.stringify(r1.data.errors));
  if (r2.data?.errors) throw new Error(JSON.stringify(r2.data.errors));
  const a = r1.data.data.claimRequest;
  const b = r2.data.data.claimRequest;
  if (!(a.request_id === b.request_id && a.worker_address === b.worker_address)) {
    throw new Error('Idempotency failed: claims differ');
  }
}

async function waitForDeliver(requestHex: string, timeoutMs = 240000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await gql(
      PONDER_GRAPHQL_URL,
      'query { deliverys { items { id requestId transactionHash } } }'
    );
    const items: any[] = data?.deliverys?.items || [];
    if (items.find((i) => i.requestId === requestHex)) return true;
    await delay(5000);
  }
  throw new Error('Deliver event not observed within timeout');
}

async function main() {
  try {
    console.log('Posting marketplace job...');
    const { requestHex, txHash } = await postJob();
    console.log('Request:', requestHex, 'Tx:', txHash);

    console.log('Waiting for Ponder to index Request...');
    await waitForRequestIndexed(requestHex);
    console.log('Request indexed.');

    if (controlApiSigner) {
      console.log('Claiming via Control API (idempotent)...');
      await controlApiClaim(requestHex);
      await controlApiClaimIdempotent(requestHex);
      console.log('Control API claim OK.');
    } else {
      console.log('Skipping Control API tests (missing WORKER_PRIVATE_KEY).');
    }

    console.log('Waiting for Deliver event (ensure mech worker is running)...');
    await waitForDeliver(requestHex);
    console.log('Deliver observed. E2E test PASSED.');
    process.exit(0);
  } catch (e: any) {
    console.error('E2E test FAILED:', e?.message || e);
    process.exit(1);
  }
}

main();



