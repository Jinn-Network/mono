#!/usr/bin/env tsx

/**
 * inspect-job-run: Deep dive into a single job execution
 *
 * Fetches and displays details of a specific job run including:
 * - Request and delivery data with IPFS-resolved content
 * - Status, errors, failed tool calls
 * - Timing breakdown by phase
 * - Measurement coverage for invariants
 * - Git operations summary
 * - Token usage
 *
 * Usage:
 *   yarn inspect-job-run <request-id>                    # Summary format (default)
 *   yarn inspect-job-run <request-id> --format=summary   # Summary format
 *   yarn inspect-job-run <request-id> --format=json      # Raw JSON output
 *
 * Output:
 *   Summary format: Extracted debugging info to stdout
 *   JSON format: Full resolved data as JSON to stdout
 *   Progress messages to stderr
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { GraphQLClient, gql } from 'graphql-request';
import type { WorkerTelemetryLog } from 'jinn-node/worker/worker_telemetry.js';
import {
  fetchIpfsContent,
  extractErrorsFromTelemetry,
  extractGitOpsFromTelemetry,
  extractTimingMetrics,
  extractFailedToolCalls,
  extractInvariantMetrics,
  extractTokenMetrics,
  type ErrorSummary,
  type GitOperationSummary,
  type TimingMetrics,
  type FailedToolCall,
  type InvariantMetrics,
  type TokenMetrics,
} from './shared/workstream-utils.js';

const PONDER_GRAPHQL_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
const IPFS_GATEWAY_URL = process.env.IPFS_GATEWAY_URL || 'https://gateway.autonolas.tech/ipfs/';

interface Request {
  id: string;
  mech: string;
  sender: string;
  workstreamId?: string;
  jobDefinitionId?: string;
  sourceRequestId?: string;
  requestData?: string;
  ipfsHash?: string;
  deliveryIpfsHash?: string;
  blockNumber: string;
  blockTimestamp: string;
  delivered: boolean;
  jobName?: string;
  enabledTools?: string[];
}

interface Delivery {
  id: string;
  requestId: string;
  mech: string;
  mechServiceMultisig: string;
  deliveryRate: string;
  ipfsHash?: string;
  transactionHash: string;
  blockNumber: string;
  blockTimestamp: string;
}

interface Artifact {
  id: string;
  requestId: string;
  name: string;
  cid: string;
  topic: string;
  contentPreview?: string;
}

interface JobRunData {
  request?: Request;
  delivery?: Delivery;
  artifacts: Artifact[];
  workerTelemetryArtifact?: Artifact;
}

const QUERY = gql`
  query GetJobRun($requestId: String!) {
    request(id: $requestId) {
      id
      mech
      sender
      workstreamId
      jobDefinitionId
      sourceRequestId
      requestData
      ipfsHash
      deliveryIpfsHash
      blockNumber
      blockTimestamp
      delivered
      jobName
      enabledTools
    }
    delivery(id: $requestId) {
      id
      requestId
      mech
      mechServiceMultisig
      deliveryRate
      ipfsHash
      transactionHash
      blockNumber
      blockTimestamp
    }
    artifacts(where: { requestId: $requestId }) {
      items {
        id
        requestId
        name
        cid
        topic
        contentPreview
      }
    }
    workerTelemetryArtifact: artifacts(where: { requestId: $requestId, topic: "WORKER_TELEMETRY" }, limit: 1) {
      items {
        id
        requestId
        name
        cid
        topic
        contentPreview
      }
    }
  }
`;

function tryParseNestedJson(value: any): any {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return tryParseNestedJson(parsed);
    } catch {
      return value;
    }
  }

  if (Array.isArray(value)) {
    return value.map(tryParseNestedJson);
  }

  if (value !== null && typeof value === 'object') {
    const result: any = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = tryParseNestedJson(val);
    }
    return result;
  }

  return value;
}

async function fetchIpfsContentLocal(cid: string, requestIdForDelivery?: string): Promise<any> {
  let url = `${IPFS_GATEWAY_URL}${cid}`;

  // Special handling for delivery IPFS hashes: reconstruct directory path
  if (requestIdForDelivery && cid.startsWith('f01551220')) {
    const digestHex = cid.replace(/^f01551220/i, '');

    try {
      const digestBytes: number[] = [];
      for (let i = 0; i < digestHex.length; i += 2) {
        digestBytes.push(parseInt(digestHex.slice(i, i + 2), 16));
      }

      const cidBytes = [0x01, 0x70, 0x12, 0x20, ...digestBytes];

      const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
      let bitBuffer = 0;
      let bitCount = 0;
      let out = '';

      for (const b of cidBytes) {
        bitBuffer = (bitBuffer << 8) | (b & 0xff);
        bitCount += 8;
        while (bitCount >= 5) {
          const idx = (bitBuffer >> (bitCount - 5)) & 0x1f;
          bitCount -= 5;
          out += base32Alphabet[idx];
        }
      }

      if (bitCount > 0) {
        const idx = (bitBuffer << (5 - bitCount)) & 0x1f;
        out += base32Alphabet[idx];
      }

      const dirCid = 'b' + out;
      url = `${IPFS_GATEWAY_URL}${dirCid}/${requestIdForDelivery}`;
      console.error(`  Reconstructed directory CID: ${dirCid}`);
    } catch (e) {
      console.error(`  Failed to reconstruct directory CID: ${e}`);
    }
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(parseInt(process.env.IPFS_FETCH_TIMEOUT_MS || '7000', 10))
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    console.error(`Failed to fetch IPFS content for ${cid}:`, error);
    return { _error: `Failed to fetch: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function resolveIpfsReferences(data: JobRunData): Promise<any> {
  const resolved: any = {
    request: { ...data.request },
    delivery: data.delivery ? { ...data.delivery } : null,
    artifacts: [],
    workerTelemetry: null,
  };

  // Resolve request IPFS hash
  if (data.request?.ipfsHash) {
    console.error(`Resolving request IPFS hash: ${data.request.ipfsHash}`);
    const content = await fetchIpfsContentLocal(data.request.ipfsHash);
    resolved.request.ipfsContent = tryParseNestedJson(content);
  }

  // Resolve delivery IPFS hash (with directory reconstruction)
  if (data.delivery?.ipfsHash) {
    console.error(`Resolving delivery IPFS hash: ${data.delivery.ipfsHash}`);
    const content = await fetchIpfsContentLocal(data.delivery.ipfsHash, data.delivery.requestId);
    resolved.delivery.ipfsContent = tryParseNestedJson(content);
  }

  // Resolve delivery IPFS hash from request (alternative location)
  if (data.request?.deliveryIpfsHash && data.request.deliveryIpfsHash !== data.delivery?.ipfsHash) {
    console.error(`Resolving request delivery IPFS hash: ${data.request.deliveryIpfsHash}`);
    const content = await fetchIpfsContentLocal(data.request.deliveryIpfsHash, data.request.id);
    resolved.request.deliveryIpfsContent = tryParseNestedJson(content);
  }

  // Resolve worker telemetry artifact
  if (data.workerTelemetryArtifact) {
    console.error(`Resolving WORKER_TELEMETRY artifact: ${data.workerTelemetryArtifact.cid}`);
    const content = await fetchIpfsContentLocal(data.workerTelemetryArtifact.cid);
    const parsedContent = tryParseNestedJson(content);
    if (parsedContent?.version === 'worker-telemetry-v1') {
      resolved.workerTelemetry = parsedContent;
    }
  }

  // Resolve all artifact CIDs
  for (const artifact of data.artifacts) {
    console.error(`Resolving artifact ${artifact.name} (${artifact.topic}): ${artifact.cid}`);
    const content = await fetchIpfsContentLocal(artifact.cid);
    const parsedContent = tryParseNestedJson(content);

    resolved.artifacts.push({
      ...artifact,
      resolvedContent: parsedContent
    });
  }

  return resolved;
}

function extractStatus(resolved: any): string {
  // Try delivery content status first
  const deliveryContent = resolved.delivery?.ipfsContent || resolved.request?.deliveryIpfsContent;
  if (deliveryContent?.status) {
    return deliveryContent.status;
  }

  // Infer from request state
  if (!resolved.request?.delivered) {
    return 'PENDING';
  }

  // Check for errors in telemetry
  if (resolved.workerTelemetry) {
    const errors = extractErrorsFromTelemetry(resolved.workerTelemetry);
    if (errors.length > 0) {
      return 'FAILED';
    }
  }

  return 'COMPLETED';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function printSummary(resolved: any, data: JobRunData): void {
  const request = resolved.request;
  const deliveryContent = resolved.delivery?.ipfsContent || resolved.request?.deliveryIpfsContent;
  const telemetry: WorkerTelemetryLog | null = resolved.workerTelemetry;

  const status = extractStatus(resolved);
  const statusEmoji = status === 'COMPLETED' ? '✅' : status === 'FAILED' ? '❌' : status === 'DELEGATING' ? '🔄' : '⏳';

  // Header
  console.log(`# Job Run: ${request.id}`);
  console.log(`Status: ${statusEmoji} ${status}`);
  console.log(`Job: ${request.jobName || 'N/A'} (def: ${request.jobDefinitionId || 'N/A'})`);
  console.log(`Workstream: ${request.workstreamId || 'N/A'}`);
  if (request.sourceRequestId) {
    console.log(`Parent: ${request.sourceRequestId}`);
  }
  console.log('');

  // Errors Section
  if (telemetry) {
    const errors = extractErrorsFromTelemetry(telemetry);
    if (errors.length > 0) {
      console.log('## Errors');
      for (const error of errors) {
        console.log(`- [${error.phase}] ${error.error}`);
      }
      console.log('');
    }
  }

  // Check delivery content for errors too
  if (deliveryContent?.error) {
    console.log('## Delivery Error');
    console.log(`- ${deliveryContent.error}`);
    console.log('');
  }

  // Failed Tool Calls Section
  if (deliveryContent?.telemetry) {
    const failedCalls = extractFailedToolCalls(request.id, request.jobName, deliveryContent.telemetry);
    if (failedCalls.length > 0) {
      console.log('## Failed Tool Calls');
      for (const call of failedCalls) {
        const execType = call.executionFailed ? 'execution failure' : 'logical failure';
        console.log(`- ${call.tool}: ${call.errorCode || 'ERROR'} - ${call.errorMessage} (${execType})`);
      }
      console.log('');
    }
  }

  // Timing Section
  if (telemetry) {
    const timing = extractTimingMetrics(request.id, request.jobName, telemetry);
    if (timing && timing.totalDuration_ms > 0) {
      console.log('## Timing');
      console.log(`Total: ${formatDuration(timing.totalDuration_ms)}`);
      const phases = Object.entries(timing.byPhase).sort((a, b) => b[1] - a[1]);
      for (const [phase, duration] of phases) {
        const pct = Math.round((duration / timing.totalDuration_ms) * 100);
        console.log(`- ${phase}: ${formatDuration(duration)} (${pct}%)`);
      }
      console.log('');
    }
  }

  // Measurement Coverage Section
  if (deliveryContent) {
    const invariants = extractInvariantMetrics(request.id, request.jobName, deliveryContent);
    if (invariants && invariants.totalInvariants > 0) {
      const coveragePct = Math.round((invariants.measuredInvariants / invariants.totalInvariants) * 100);
      console.log('## Measurement Coverage');
      console.log(`Coverage: ${invariants.measuredInvariants}/${invariants.totalInvariants} (${coveragePct}%)`);
      if (invariants.passedInvariants > 0 || invariants.failedInvariants > 0) {
        console.log(`Passed: ${invariants.passedInvariants} | Failed: ${invariants.failedInvariants}`);
      }
      if (invariants.unmeasuredIds.length > 0) {
        console.log(`Unmeasured: ${invariants.unmeasuredIds.join(', ')}`);
      }
      console.log('');
    }
  }

  // Git Operations Section
  if (telemetry) {
    const gitOps = extractGitOpsFromTelemetry(telemetry);
    if (gitOps) {
      console.log('## Git Operations');
      if (gitOps.branchName) {
        console.log(`Branch: ${gitOps.branchName}${gitOps.baseBranch ? ` (from ${gitOps.baseBranch})` : ''}`);
      }
      console.log(`Pushed: ${gitOps.pushed ? 'Yes' : 'No'}`);
      if (gitOps.filesChanged !== undefined) {
        console.log(`Files changed: ${gitOps.filesChanged}`);
      }
      if (gitOps.hasConflicts) {
        console.log(`Conflicts: Yes${gitOps.conflictingFiles?.length ? ` (${gitOps.conflictingFiles.join(', ')})` : ''}`);
      }
      if (gitOps.branchUrl) {
        console.log(`URL: ${gitOps.branchUrl}`);
      }
      console.log('');
    }
  }

  // Token Usage Section
  if (deliveryContent) {
    const tokens = extractTokenMetrics(request.id, request.jobName, deliveryContent);
    if (tokens && tokens.totalTokens > 0) {
      console.log('## Token Usage');
      if (tokens.model) {
        console.log(`Model: ${tokens.model}`);
      }
      console.log(`Input: ${tokens.inputTokens?.toLocaleString() || 'N/A'} | Output: ${tokens.outputTokens?.toLocaleString() || 'N/A'} | Total: ${tokens.totalTokens.toLocaleString()}`);
      console.log('');
    }
  }

  // Raw Data References Section
  console.log('## Raw Data');
  if (data.workerTelemetryArtifact) {
    console.log(`Telemetry artifact: ${data.workerTelemetryArtifact.cid}`);
  }
  if (data.delivery?.ipfsHash) {
    console.log(`Delivery IPFS: ${data.delivery.ipfsHash}`);
  }
  console.log(`To inspect raw: yarn inspect-job-run ${request.id} --format=json`);
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .usage('Usage: $0 <request-id> [options]')
    .demandCommand(1, 'You must provide a request ID')
    .option('format', {
      type: 'string',
      choices: ['summary', 'json'],
      default: 'summary',
      describe: 'Output format: summary (extracted debugging info) or json (raw data)'
    })
    .help()
    .alias('h', 'help')
    .parserConfiguration({
      'parse-numbers': false,
      'parse-positional-numbers': false
    })
    .parse();

  const requestId = String(argv._[0]);
  const format = argv.format as 'summary' | 'json';

  console.error(`\n🔍 Inspecting job run: ${requestId}\n`);
  console.error(`Ponder API: ${PONDER_GRAPHQL_URL}`);
  console.error(`IPFS Gateway: ${IPFS_GATEWAY_URL}\n`);

  const client = new GraphQLClient(PONDER_GRAPHQL_URL);

  try {
    console.error('Fetching data from Ponder...');
    const response = await client.request<{
      request?: Request;
      delivery?: Delivery;
      artifacts: { items: Artifact[] };
      workerTelemetryArtifact: { items: Artifact[] };
    }>(QUERY, { requestId });

    if (!response.request) {
      console.error(`\n❌ Request ${requestId} not found in Ponder\n`);
      process.exit(1);
    }

    const jobRunData: JobRunData = {
      request: response.request,
      delivery: response.delivery,
      artifacts: response.artifacts.items,
      workerTelemetryArtifact: response.workerTelemetryArtifact.items[0]
    };

    console.error(`\n✅ Found request data:`);
    console.error(`   Job Name: ${jobRunData.request?.jobName || 'N/A'}`);
    console.error(`   Delivered: ${jobRunData.request?.delivered ? 'Yes' : 'No'}`);
    console.error(`   Artifacts: ${jobRunData.artifacts.length}`);
    console.error(`   Worker Telemetry: ${jobRunData.workerTelemetryArtifact ? 'Yes' : 'No'}`);
    console.error(`\nResolving IPFS references...\n`);

    const resolved = await resolveIpfsReferences(jobRunData);

    console.error(`\n✅ All IPFS references resolved\n`);
    console.error('========== OUTPUT ==========\n');

    if (format === 'json') {
      console.log(JSON.stringify(resolved, null, 2));
    } else {
      printSummary(resolved, jobRunData);
    }

  } catch (error) {
    console.error(`\n❌ Error:`, error);
    process.exit(1);
  }
}

main();
