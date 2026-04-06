#!/usr/bin/env tsx

/**
 * inspect-job: Comprehensive Job Definition Inspector
 *
 * Fetches and displays the complete story of a job definition including:
 * - Job definition metadata (name, blueprint, tools, lineage)
 * - All execution runs with status and error summaries
 * - Child jobs created by each run
 * - Workstream relationships
 *
 * Usage:
 *   yarn inspect-job <job-definition-id>                  # Summary format (default)
 *   yarn inspect-job <job-definition-id> --format=summary # Summary format
 *   yarn inspect-job <job-definition-id> --format=json    # Full JSON output
 *
 * Output:
 *   Summary format: Job definition header, runs table, failed run details
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
  extractFailedToolCalls,
  extractTimingMetrics,
  type ErrorSummary,
  type FailedToolCall,
} from './shared/workstream-utils.js';

const PONDER_GRAPHQL_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
const IPFS_GATEWAY_URL = process.env.IPFS_GATEWAY_URL || 'https://gateway.autonolas.tech/ipfs/';

interface JobDefinition {
  id: string;
  name: string;
  enabledTools?: string[];
  blueprint?: string;
  sourceJobDefinitionId?: string;
  sourceRequestId?: string;
  codeMetadata?: any;
  createdAt?: string;
  lastInteraction?: string;
  lastStatus?: string;
}

interface Request {
  id: string;
  mech: string;
  sender: string;
  workstreamId?: string;
  jobDefinitionId?: string;
  sourceRequestId?: string;
  sourceJobDefinitionId?: string;
  requestData?: string;
  ipfsHash?: string;
  deliveryIpfsHash?: string;
  transactionHash?: string;
  blockNumber: string;
  blockTimestamp: string;
  delivered: boolean;
  jobName?: string;
  enabledTools?: string[];
  additionalContext?: any;
  dependencies?: string[];
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

const JOB_DEFINITION_QUERY = gql`
  query GetJobDefinition($jobDefinitionId: String!) {
    jobDefinition(id: $jobDefinitionId) {
      id
      name
      enabledTools
      blueprint
      sourceJobDefinitionId
      sourceRequestId
      codeMetadata
      createdAt
      lastInteraction
      lastStatus
    }
  }
`;

const RUNS_QUERY = gql`
  query GetJobRuns($jobDefinitionId: String!) {
    requests(where: { jobDefinitionId: $jobDefinitionId }, orderBy: "blockTimestamp", orderDirection: "asc") {
      items {
        id
        mech
        sender
        workstreamId
        jobDefinitionId
        sourceRequestId
        sourceJobDefinitionId
        requestData
        ipfsHash
        deliveryIpfsHash
        transactionHash
        blockNumber
        blockTimestamp
        delivered
        jobName
        enabledTools
        additionalContext
        dependencies
      }
    }
  }
`;

const CHILD_JOBS_QUERY = gql`
  query GetChildJobs($sourceJobDefinitionId: String!) {
    requests(where: { sourceJobDefinitionId: $sourceJobDefinitionId }, orderBy: "blockTimestamp", orderDirection: "asc") {
      items {
        id
        mech
        sender
        workstreamId
        jobDefinitionId
        sourceRequestId
        sourceJobDefinitionId
        requestData
        ipfsHash
        deliveryIpfsHash
        transactionHash
        blockNumber
        blockTimestamp
        delivered
        jobName
        enabledTools
        additionalContext
        dependencies
      }
    }
  }
`;

const DELIVERIES_QUERY = gql`
  query GetDeliveries($requestIds: [String!]!) {
    deliverys(where: { requestId_in: $requestIds }) {
      items {
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
    }
  }
`;

const ARTIFACTS_QUERY = gql`
  query GetArtifacts($requestIds: [String!]!) {
    artifacts(where: { requestId_in: $requestIds }) {
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

async function fetchIpfsContentLocal(cid: string, requestIdForDelivery?: string): Promise<any> {
  let url = `${IPFS_GATEWAY_URL}${cid}`;

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
    } catch {
      // Fall through to direct CID fetch
    }
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(parseInt(process.env.IPFS_FETCH_TIMEOUT_MS || '7000', 10))
    });
    if (!response.ok) return null;
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

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

interface RunAnalysis {
  requestId: string;
  delivered: boolean;
  timestamp: string;
  status: string;
  duration_ms: number;
  errorCount: number;
  childCount: number;
  errors: ErrorSummary[];
  failedTools: FailedToolCall[];
  deliveryContent?: any;
  telemetry?: WorkerTelemetryLog;
}

async function analyzeRun(
  run: Request,
  delivery: Delivery | undefined,
  artifacts: Artifact[],
  childCount: number
): Promise<RunAnalysis> {
  const analysis: RunAnalysis = {
    requestId: run.id,
    delivered: run.delivered,
    timestamp: new Date(parseInt(run.blockTimestamp) * 1000).toISOString(),
    status: 'PENDING',
    duration_ms: 0,
    errorCount: 0,
    childCount,
    errors: [],
    failedTools: [],
  };

  if (!run.delivered) {
    analysis.status = 'PENDING';
    return analysis;
  }

  // Try to get delivery content
  let deliveryContent: any = null;
  if (delivery?.ipfsHash) {
    deliveryContent = await fetchIpfsContentLocal(delivery.ipfsHash, delivery.requestId);
    if (deliveryContent) {
      deliveryContent = tryParseNestedJson(deliveryContent);
      analysis.deliveryContent = deliveryContent;
    }
  } else if (run.deliveryIpfsHash) {
    deliveryContent = await fetchIpfsContentLocal(run.deliveryIpfsHash, run.id);
    if (deliveryContent) {
      deliveryContent = tryParseNestedJson(deliveryContent);
      analysis.deliveryContent = deliveryContent;
    }
  }

  // Extract status
  if (deliveryContent?.status) {
    analysis.status = deliveryContent.status;
  } else {
    analysis.status = 'COMPLETED';
  }

  // Try to get worker telemetry
  const telemetryArtifact = artifacts.find(a => a.topic === 'WORKER_TELEMETRY');
  if (telemetryArtifact) {
    const telemetry = await fetchIpfsContentLocal(telemetryArtifact.cid);
    if (telemetry?.version === 'worker-telemetry-v1') {
      analysis.telemetry = telemetry as WorkerTelemetryLog;
      analysis.duration_ms = telemetry.totalDuration_ms || 0;
      analysis.errors = extractErrorsFromTelemetry(telemetry);
      analysis.errorCount = analysis.errors.length;
    }
  }

  // Extract failed tool calls from delivery telemetry
  if (deliveryContent?.telemetry) {
    analysis.failedTools = extractFailedToolCalls(run.id, run.jobName, deliveryContent.telemetry);
    if (analysis.failedTools.length > 0 && analysis.errorCount === 0) {
      analysis.errorCount = analysis.failedTools.length;
    }
  }

  // Check delivery content for error
  if (deliveryContent?.error && analysis.status !== 'FAILED') {
    analysis.status = 'FAILED';
    analysis.errors.push({
      requestId: run.id,
      jobName: run.jobName,
      phase: 'delivery',
      error: deliveryContent.error,
      timestamp: analysis.timestamp,
    });
    analysis.errorCount = analysis.errors.length;
  }

  return analysis;
}

function formatDuration(ms: number): string {
  if (ms === 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function truncateId(id: string, len: number = 10): string {
  if (id.length <= len) return id;
  return id.slice(0, len) + '...';
}

function printSummary(
  jobDef: JobDefinition,
  runs: Request[],
  childJobs: Request[],
  analyses: RunAnalysis[],
  workstreams: Set<string>
): void {
  // Header
  console.log(`# Job Definition: ${jobDef.id}`);
  console.log(`Name: ${jobDef.name}`);
  console.log(`Last Status: ${jobDef.lastStatus || 'N/A'}`);
  if (jobDef.createdAt) {
    console.log(`Created: ${new Date(parseInt(jobDef.createdAt) * 1000).toISOString()}`);
  }
  if (jobDef.lastInteraction) {
    console.log(`Last Interaction: ${new Date(parseInt(jobDef.lastInteraction) * 1000).toISOString()}`);
  }
  if (workstreams.size > 0) {
    console.log(`Workstreams: ${Array.from(workstreams).map(w => truncateId(w, 16)).join(', ')}`);
  }
  console.log('');

  // Runs Summary
  const completedCount = analyses.filter(a => a.status === 'COMPLETED').length;
  const failedCount = analyses.filter(a => a.status === 'FAILED').length;
  const pendingCount = analyses.filter(a => a.status === 'PENDING').length;
  const delegatingCount = analyses.filter(a => a.status === 'DELEGATING').length;

  const statusParts: string[] = [];
  if (completedCount > 0) statusParts.push(`${completedCount} completed`);
  if (failedCount > 0) statusParts.push(`${failedCount} failed`);
  if (delegatingCount > 0) statusParts.push(`${delegatingCount} delegating`);
  if (pendingCount > 0) statusParts.push(`${pendingCount} pending`);

  console.log(`## Runs (${runs.length} total: ${statusParts.join(', ')})`);
  console.log('');

  if (runs.length === 0) {
    console.log('No runs found.');
    console.log('');
    return;
  }

  // Runs table
  console.log('| # | Request ID | Status | Duration | Errors | Children |');
  console.log('|---|------------|--------|----------|--------|----------|');

  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i];
    const statusEmoji = a.status === 'COMPLETED' ? '✅' : a.status === 'FAILED' ? '❌' : a.status === 'DELEGATING' ? '🔄' : '⏳';
    console.log(`| ${i + 1} | ${truncateId(a.requestId, 12)} | ${statusEmoji} ${a.status} | ${formatDuration(a.duration_ms)} | ${a.errorCount} | ${a.childCount} |`);
  }
  console.log('');

  // Failed runs detail
  const failedRuns = analyses.filter(a => a.status === 'FAILED' || a.errorCount > 0);
  if (failedRuns.length > 0) {
    console.log('## Failed/Error Runs Detail');
    console.log('');

    for (let i = 0; i < failedRuns.length; i++) {
      const a = failedRuns[i];
      const runNum = analyses.indexOf(a) + 1;

      console.log(`### Run #${runNum} (${truncateId(a.requestId, 16)}) - ${a.status}`);

      if (a.errors.length > 0) {
        console.log('Errors:');
        for (const err of a.errors) {
          console.log(`- [${err.phase}] ${err.error}`);
        }
      }

      if (a.failedTools.length > 0) {
        console.log('Failed Tools:');
        for (const ft of a.failedTools) {
          const execType = ft.executionFailed ? 'execution' : 'logical';
          console.log(`- ${ft.tool}: ${ft.errorCode || 'ERROR'} - ${ft.errorMessage} (${execType})`);
        }
      }

      console.log(`Full details: yarn inspect-job-run ${a.requestId}`);
      console.log('');
    }
  }

  // Child jobs summary
  if (childJobs.length > 0) {
    const childDelivered = childJobs.filter(c => c.delivered).length;
    console.log(`## Child Jobs (${childJobs.length} total: ${childDelivered} delivered, ${childJobs.length - childDelivered} pending)`);
    console.log('');

    // Group by job name
    const byJobName = new Map<string, Request[]>();
    for (const child of childJobs) {
      const name = child.jobName || 'Unknown';
      if (!byJobName.has(name)) {
        byJobName.set(name, []);
      }
      byJobName.get(name)!.push(child);
    }

    for (const [name, children] of byJobName) {
      const delivered = children.filter(c => c.delivered).length;
      console.log(`- ${name}: ${delivered}/${children.length} delivered`);
    }
    console.log('');
  }

  // Raw data reference
  console.log('## Raw Data');
  console.log(`Full JSON: yarn inspect-job ${jobDef.id} --format=json`);
}

async function resolveRunIpfsReferences(
  run: Request,
  delivery?: Delivery,
  artifacts?: Artifact[]
): Promise<any> {
  const resolved: any = {
    ...run,
    resolvedRequestContent: null,
    resolvedDeliveryContent: null,
    resolvedArtifacts: []
  };

  if (run.ipfsHash) {
    console.error(`  Resolving request IPFS hash: ${run.ipfsHash}`);
    const content = await fetchIpfsContentLocal(run.ipfsHash);
    resolved.resolvedRequestContent = tryParseNestedJson(content);
  }

  if (delivery?.ipfsHash) {
    console.error(`  Resolving delivery IPFS hash: ${delivery.ipfsHash}`);
    const content = await fetchIpfsContentLocal(delivery.ipfsHash, delivery.requestId);
    resolved.resolvedDeliveryContent = tryParseNestedJson(content);
  }

  if (run.deliveryIpfsHash && run.deliveryIpfsHash !== delivery?.ipfsHash) {
    console.error(`  Resolving request delivery IPFS hash: ${run.deliveryIpfsHash}`);
    const content = await fetchIpfsContentLocal(run.deliveryIpfsHash, run.id);
    resolved.resolvedDeliveryContent = tryParseNestedJson(content);
  }

  if (artifacts && artifacts.length > 0) {
    for (const artifact of artifacts) {
      console.error(`  Resolving artifact ${artifact.name} (${artifact.topic}): ${artifact.cid}`);
      const content = await fetchIpfsContentLocal(artifact.cid);
      const parsedContent = tryParseNestedJson(content);

      resolved.resolvedArtifacts.push({
        ...artifact,
        resolvedContent: parsedContent
      });
    }
  }

  return resolved;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .usage('Usage: $0 <job-definition-id> [options]')
    .demandCommand(1, 'You must provide a job definition ID')
    .option('format', {
      type: 'string',
      choices: ['summary', 'json'],
      default: 'summary',
      describe: 'Output format: summary (table with failed details) or json (raw data)'
    })
    .help()
    .alias('h', 'help')
    .parserConfiguration({
      'parse-numbers': false,
      'parse-positional-numbers': false
    })
    .parse();

  const jobDefinitionId = String(argv._[0]);
  const format = argv.format as 'summary' | 'json';

  console.error(`\n🔍 Inspecting job definition: ${jobDefinitionId}\n`);
  console.error(`Ponder API: ${PONDER_GRAPHQL_URL}`);
  console.error(`IPFS Gateway: ${IPFS_GATEWAY_URL}\n`);

  const client = new GraphQLClient(PONDER_GRAPHQL_URL);

  try {
    // Step 1: Fetch Job Definition
    console.error('Fetching job definition...');
    const jobDefResponse = await client.request<{
      jobDefinition?: JobDefinition;
    }>(JOB_DEFINITION_QUERY, { jobDefinitionId });

    if (!jobDefResponse.jobDefinition) {
      console.error(`\n❌ Job definition ${jobDefinitionId} not found in Ponder\n`);
      process.exit(1);
    }

    const jobDefinition = jobDefResponse.jobDefinition;
    console.error(`✅ Found job definition: ${jobDefinition.name}`);

    // Step 2: Fetch all runs for this job definition
    console.error('\nFetching job runs...');
    const runsResponse = await client.request<{
      requests: { items: Request[] };
    }>(RUNS_QUERY, { jobDefinitionId });

    const runs = runsResponse.requests.items;
    console.error(`✅ Found ${runs.length} run(s)`);

    // Step 3: Fetch all child jobs (requests created by this job)
    console.error('\nFetching child jobs...');
    const childJobsResponse = await client.request<{
      requests: { items: Request[] };
    }>(CHILD_JOBS_QUERY, { sourceJobDefinitionId: jobDefinitionId });

    const childJobs = childJobsResponse.requests.items;
    console.error(`✅ Found ${childJobs.length} child job(s)`);

    // Step 4: Fetch deliveries and artifacts for all runs
    const allRequestIds = [...runs.map(r => r.id), ...childJobs.map(c => c.id)];

    let deliveries: Delivery[] = [];
    let artifacts: Artifact[] = [];

    if (allRequestIds.length > 0) {
      console.error('\nFetching deliveries...');
      const deliveriesResponse = await client.request<{
        deliverys: { items: Delivery[] };
      }>(DELIVERIES_QUERY, { requestIds: allRequestIds });
      deliveries = deliveriesResponse.deliverys.items;
      console.error(`✅ Found ${deliveries.length} delivery/deliveries`);

      console.error('\nFetching artifacts...');
      const artifactsResponse = await client.request<{
        artifacts: { items: Artifact[] };
      }>(ARTIFACTS_QUERY, { requestIds: allRequestIds });
      artifacts = artifactsResponse.artifacts.items;
      console.error(`✅ Found ${artifacts.length} artifact(s)`);
    }

    // Step 5: Build maps
    const deliveryMap = new Map<string, Delivery>();
    deliveries.forEach(d => deliveryMap.set(d.requestId, d));

    const artifactsByRequest = new Map<string, Artifact[]>();
    artifacts.forEach(a => {
      if (!artifactsByRequest.has(a.requestId)) {
        artifactsByRequest.set(a.requestId, []);
      }
      artifactsByRequest.get(a.requestId)!.push(a);
    });

    // Step 6: Map children to their parent runs
    const childrenByParentRequest = new Map<string, Request[]>();
    childJobs.forEach(child => {
      if (child.sourceRequestId) {
        if (!childrenByParentRequest.has(child.sourceRequestId)) {
          childrenByParentRequest.set(child.sourceRequestId, []);
        }
        childrenByParentRequest.get(child.sourceRequestId)!.push(child);
      }
    });

    // Step 7: Identify workstreams
    const workstreams = new Set<string>();
    runs.forEach(r => {
      if (r.workstreamId) {
        workstreams.add(r.workstreamId);
      }
    });
    childJobs.forEach(c => {
      if (c.workstreamId) {
        workstreams.add(c.workstreamId);
      }
    });

    console.error(`\n✅ Identified ${workstreams.size} workstream(s)`);

    if (format === 'summary') {
      // Analyze runs for summary
      console.error('\nAnalyzing runs...');
      const analyses: RunAnalysis[] = [];
      for (const run of runs) {
        const delivery = deliveryMap.get(run.id);
        const runArtifacts = artifactsByRequest.get(run.id) || [];
        const children = childrenByParentRequest.get(run.id) || [];
        const analysis = await analyzeRun(run, delivery, runArtifacts, children.length);
        analyses.push(analysis);
      }

      console.error('\n========== OUTPUT ==========\n');
      printSummary(jobDefinition, runs, childJobs, analyses, workstreams);
    } else {
      // JSON format - full resolution
      console.error('\nResolving IPFS references for runs...\n');
      const resolvedRuns = [];

      for (const run of runs) {
        console.error(`Processing run ${run.id}...`);
        const delivery = deliveryMap.get(run.id);
        const runArtifacts = artifactsByRequest.get(run.id) || [];
        const children = childrenByParentRequest.get(run.id) || [];

        const resolved = await resolveRunIpfsReferences(run, delivery, runArtifacts);

        resolved.children = children.map(child => ({
          id: child.id,
          jobDefinitionId: child.jobDefinitionId,
          jobName: child.jobName,
          workstreamId: child.workstreamId,
          delivered: child.delivered,
          blockTimestamp: child.blockTimestamp,
        }));

        resolvedRuns.push(resolved);
      }

      const output = {
        jobDefinition: {
          ...jobDefinition,
          resolvedBlueprint: jobDefinition.blueprint ? tryParseNestedJson(jobDefinition.blueprint) : null
        },
        workstreams: Array.from(workstreams),
        summary: {
          totalRuns: runs.length,
          completedRuns: runs.filter(r => r.delivered).length,
          pendingRuns: runs.filter(r => !r.delivered).length,
          totalChildren: childJobs.length,
          completedChildren: childJobs.filter(c => c.delivered).length,
          pendingChildren: childJobs.filter(c => !c.delivered).length,
          totalArtifacts: artifacts.length,
        },
        runs: resolvedRuns,
        allChildJobs: childJobs.map(child => ({
          id: child.id,
          jobDefinitionId: child.jobDefinitionId,
          jobName: child.jobName,
          sourceRequestId: child.sourceRequestId,
          workstreamId: child.workstreamId,
          delivered: child.delivered,
          blockTimestamp: child.blockTimestamp,
        }))
      };

      console.error(`\n✅ All data resolved\n`);
      console.error('========== OUTPUT ==========\n');

      console.log(JSON.stringify(output, null, 2));
    }

  } catch (error) {
    console.error(`\n❌ Error:`, error);
    process.exit(1);
  }
}

main();
