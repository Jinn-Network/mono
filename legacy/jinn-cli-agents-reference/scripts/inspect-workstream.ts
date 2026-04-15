#!/usr/bin/env tsx

/**
 * inspect-workstream: Workstream Execution Graph Inspector
 *
 * Primary entry point for workstream debugging. Provides filtering, error aggregation,
 * dispatch tracing, git operations, and metrics views.
 *
 * Usage:
 *   yarn inspect-workstream <workstream-id> [options]
 *
 * Flags:
 *   --status=failed|pending|completed|all  Filter by job status
 *   --job-name=<pattern>                   Filter by job name (regex)
 *   --depth=<n>                            Max hierarchy depth
 *   --since=<timestamp>                    Only requests after timestamp
 *   --show-errors                          Include error aggregation
 *   --show-dispatch                        Include dispatch chain/reasons
 *   --show-git                             Include git operations
 *   --show-metrics                         Include token/invariant stats
 *   --show-telemetry                       Fetch full worker telemetry
 *   --show-timing                          Include phase duration analysis
 *   --show-tools                           Include tool usage analytics
 *   --format=json|summary                  Output format
 *   --raw                                  Output full data without truncation
 *   --top-n=<n>                            Max items in summary lists (default: 5)
 *
 * Drill-down helpers:
 *   yarn inspect-job-run <request-id>      Full details for one execution
 *   yarn inspect-job <job-def-id>          History of a job definition
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { GraphQLClient, gql } from 'graphql-request';
import {
  fetchIpfsContent,
  fetchWorkerTelemetryArtifact,
  extractErrorsFromTelemetry,
  extractGitOpsFromTelemetry,
  detectDispatchType,
  parseDispatchMessage,
  extractTokenMetrics,
  extractInvariantMetrics,
  extractTimingMetrics,
  extractToolMetricsFromTelemetry,
  extractFailedToolCalls,
  aggregateErrorsByPattern,
  aggregateTimingMetrics,
  aggregateToolMetrics,
  computeDepth,
  type ErrorSummary,
  type GitOperationSummary,
  type DispatchInfo,
  type DispatchType,
  type TokenMetrics,
  type InvariantMetrics,
  type TimingMetrics,
  type ToolMetrics,
  type FailedToolCall,
} from './shared/workstream-utils.js';

const PONDER_GRAPHQL_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';

// --- Types ---

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
  blockNumber: string;
  blockTimestamp: string;
  delivered: boolean;
  jobName?: string;
  enabledTools?: string[];
  additionalContext?: string;
}

interface Delivery {
  id: string;
  requestId: string;
  ipfsHash?: string;
  blockTimestamp: string;
}

interface Artifact {
  id: string;
  requestId: string;
  name: string;
  cid: string;
  topic: string;
  type?: string;
  tags?: string[];
}

interface WorkstreamNode {
  id: string;
  jobName?: string;
  jobDefinitionId?: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'UNKNOWN';
  timestamp: string;
  duration?: number;
  summary?: string;
  error?: string;
  children: WorkstreamNode[];
  artifacts: { name: string; topic: string; type?: string }[];
  _debug?: {
    delivered: boolean;
    hasDelivery: boolean;
    finalStatus?: string;
  };
}

interface FilterOptions {
  status?: 'failed' | 'pending' | 'completed' | 'all';
  jobNamePattern?: RegExp;
  maxDepth?: number;
  since?: Date;
}

// --- Queries ---

const WORKSTREAM_QUERY = gql`
  query GetWorkstream($workstreamId: String!, $limit: Int!, $offset: Int!) {
    requests(
      where: { workstreamId: $workstreamId }
      orderBy: "blockTimestamp"
      orderDirection: "asc"
      limit: $limit
      offset: $offset
    ) {
      items {
        id
        mech
        workstreamId
        jobDefinitionId
        sourceRequestId
        sourceJobDefinitionId
        ipfsHash
        deliveryIpfsHash
        blockTimestamp
        delivered
        jobName
        enabledTools
        additionalContext
      }
    }
  }
`;

const JOB_DEFINITIONS_QUERY = gql`
  query GetJobDefinitions($jobDefIds: [String!]!, $limit: Int!) {
    jobDefinitions(where: { id_in: $jobDefIds }, limit: $limit) {
      items {
        id
        name
        lastStatus
        lastInteraction
        sourceJobDefinitionId
      }
    }
  }
`;

const DELIVERIES_QUERY = gql`
  query GetDeliveries($requestIds: [String!]!, $limit: Int!, $offset: Int!) {
    deliverys(where: { requestId_in: $requestIds }, limit: $limit, offset: $offset) {
      items {
        id
        requestId
        ipfsHash
        blockTimestamp
      }
    }
  }
`;

const ARTIFACTS_QUERY = gql`
  query GetArtifacts($requestIds: [String!]!, $limit: Int!, $offset: Int!) {
    artifacts(where: { requestId_in: $requestIds }, limit: $limit, offset: $offset) {
      items {
        id
        requestId
        name
        cid
        topic
        type
        tags
      }
    }
  }
`;

// --- Helpers ---

function truncate(str: string, maxLength: number = 100): string {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  if (size <= 0) return chunks;
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchPaged<T>(
  fetchPage: (limit: number, offset: number) => Promise<T[]>,
  pageSize: number,
  maxItems?: number
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;

  while (true) {
    const remaining = maxItems ? maxItems - results.length : pageSize;
    if (maxItems && remaining <= 0) break;
    const limit = Math.min(pageSize, remaining);
    const page = await fetchPage(limit, offset);
    if (page.length === 0) break;
    results.push(...page);
    offset += page.length;
    if (page.length < limit) break;
  }

  return results;
}

function shouldIncludeRequest(
  req: Request,
  nodeStatus: 'COMPLETED' | 'PENDING' | 'FAILED' | 'UNKNOWN',
  depth: number,
  filters: FilterOptions
): boolean {
  // Status filter
  if (filters.status && filters.status !== 'all') {
    const statusMap: Record<string, string[]> = {
      failed: ['FAILED'],
      pending: ['PENDING', 'UNKNOWN'],
      completed: ['COMPLETED'],
    };
    if (!statusMap[filters.status].includes(nodeStatus)) {
      return false;
    }
  }

  // Job name filter
  if (filters.jobNamePattern && req.jobName) {
    if (!filters.jobNamePattern.test(req.jobName)) {
      return false;
    }
  }

  // Depth filter
  if (filters.maxDepth !== undefined && depth > filters.maxDepth) {
    return false;
  }

  // Since filter
  if (filters.since) {
    const reqTime = new Date(Number(req.blockTimestamp) * 1000);
    if (reqTime < filters.since) {
      return false;
    }
  }

  return true;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

interface FormatOptions {
  topN: number;
  raw: boolean;
}

function formatSummaryOutput(result: any, options: FormatOptions = { topN: 5, raw: false }): string {
  const { topN, raw } = options;
  const limit = raw ? Infinity : topN;
  const lines: string[] = [];

  lines.push('═'.repeat(60));
  lines.push(`Workstream: ${result.workstreamId}`);
  lines.push('═'.repeat(60));
  lines.push('');

  // Stats
  const s = result.stats;
  const successRate = s.totalJobRuns > 0
    ? ((s.completedRuns / s.totalJobRuns) * 100).toFixed(1)
    : '0';
  lines.push(`Status: ${s.completedRuns} completed, ${s.failedRuns || 0} failed, ${s.pendingRuns} pending (${successRate}% success)`);
  lines.push(`Jobs: ${s.uniqueJobs} unique definitions, ${s.totalJobRuns} total runs`);
  lines.push(`Artifacts: ${s.totalArtifacts}`);
  lines.push('');

  // Errors section
  if (result.errors && result.errors.total > 0) {
    lines.push('─'.repeat(40));
    lines.push(`Errors (${result.errors.total} total)`);
    lines.push('─'.repeat(40));

    // By phase
    if (result.errors.byPhase) {
      const phases = Object.entries(result.errors.byPhase as Record<string, number>)
        .sort((a, b) => b[1] - a[1]);
      for (const [phase, count] of phases) {
        lines.push(`  ${phase}: ${count}`);
      }
    }

    // Top errors
    if (result.errors.topErrors && result.errors.topErrors.length > 0) {
      lines.push('');
      lines.push('Top Errors:');
      for (const err of result.errors.topErrors.slice(0, limit)) {
        lines.push(`  [${err.count}x] ${raw ? err.pattern : truncate(err.pattern, 60)}`);
      }
    }
    lines.push('');
  }

  // Dispatch chain
  if (result.dispatchChain && result.dispatchChain.length > 0) {
    lines.push('─'.repeat(40));
    lines.push('Dispatch Chain');
    lines.push('─'.repeat(40));

    const sorted = [...result.dispatchChain].sort((a: any, b: any) => a.depth - b.depth);
    for (const d of sorted) {
      const indent = '  '.repeat(d.depth);
      const name = d.jobName || d.requestId.slice(0, 10) + '...';
      const typeTag = d.dispatchType !== 'manual' ? ` [${d.dispatchType}]` : '';
      const statusIcon = d.status === 'COMPLETED' ? '✓' : d.status === 'FAILED' ? '✗' : '○';
      lines.push(`${indent}${statusIcon} ${name}${typeTag}`);
    }
    lines.push('');
  }

  // Metrics
  if (result.metrics) {
    lines.push('─'.repeat(40));
    lines.push('Metrics');
    lines.push('─'.repeat(40));

    if (result.metrics.tokenUsage) {
      lines.push(`Tokens: ${result.metrics.tokenUsage.total.toLocaleString()} total`);
    }

    if (result.metrics.invariants) {
      const inv = result.metrics.invariants;
      lines.push(`Invariants: ${inv.totalMeasured} measured (${inv.totalPassed} passed, ${inv.totalFailed} failed)`);
    }

    if (result.metrics.toolCalls) {
      const tc = result.metrics.toolCalls;
      lines.push(`Tool Calls: ${tc.total} total (${tc.failures} failures)`);
    }
    lines.push('');
  }

  // Git summary
  if (result.gitSummary) {
    lines.push('─'.repeat(40));
    lines.push('Git Activity');
    lines.push('─'.repeat(40));
    lines.push(`Branches: ${result.gitSummary.totalBranches} total, ${result.gitSummary.pushedBranches} pushed`);

    if (result.gitSummary.conflicts && result.gitSummary.conflicts.length > 0) {
      lines.push(`Conflicts: ${result.gitSummary.conflicts.length}`);
      for (const c of result.gitSummary.conflicts) {
        lines.push(`  - ${c.branch}: ${c.files.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Timing analysis
  if (result.timing) {
    lines.push('─'.repeat(40));
    lines.push('Timing Analysis');
    lines.push('─'.repeat(40));
    lines.push(`Total: ${formatDuration(result.timing.totalDuration_ms)} across ${result.timing.slowestJobs?.length || 0}+ jobs`);
    lines.push(`Average job: ${formatDuration(result.timing.avgJobDuration_ms)}`);

    if (result.timing.byPhase && result.timing.byPhase.length > 0) {
      lines.push('');
      lines.push('By Phase (avg):');
      for (const phase of result.timing.byPhase.slice(0, limit + 1)) {
        lines.push(`  ${phase.phase}: ${formatDuration(phase.avgDuration_ms)} (${phase.percentage}%)`);
      }
    }

    if (result.timing.slowestJobs && result.timing.slowestJobs.length > 0) {
      lines.push('');
      lines.push('Slowest Jobs:');
      for (const job of result.timing.slowestJobs.slice(0, limit)) {
        const name = job.jobName || job.requestId.slice(0, 10) + '...';
        lines.push(`  ${name}: ${formatDuration(job.totalDuration_ms)} (${job.slowestPhase})`);
      }
    }
    lines.push('');
  }

  // Tool analytics
  if (result.tools) {
    lines.push('─'.repeat(40));
    lines.push('Tool Analytics');
    lines.push('─'.repeat(40));
    const failureStr = result.tools.totalFailures > 0
      ? ` (${result.tools.totalFailures} failures, ${result.tools.failureRate}% failure rate)`
      : '';
    lines.push(`Total: ${result.tools.totalCalls} calls${failureStr}`);

    if (result.tools.byTool && result.tools.byTool.length > 0) {
      lines.push('');
      lines.push('Most Used:');
      for (const tool of result.tools.byTool.slice(0, limit)) {
        const failStr = tool.failures > 0 ? ` (${tool.failures} failures)` : '';
        lines.push(`  ${tool.tool}: ${tool.calls} calls${failStr}`);
      }
    }

    if (result.tools.slowestTools && result.tools.slowestTools.length > 0) {
      lines.push('');
      lines.push('Slowest (avg):');
      for (const tool of result.tools.slowestTools.slice(0, limit)) {
        lines.push(`  ${tool.tool}: ${formatDuration(tool.avgDuration_ms)} avg`);
      }
    }

    if (result.tools.failingTools && result.tools.failingTools.length > 0) {
      lines.push('');
      lines.push('Failing Tools:');
      for (const tool of result.tools.failingTools.slice(0, limit)) {
        lines.push(`  ${tool.tool}: ${tool.failureRate}% failure rate (${tool.failures} failures)`);
      }
    }

    if (result.tools.failedCalls && result.tools.failedCalls.length > 0) {
      lines.push('');
      lines.push('Failed Tool Calls:');
      for (const fc of result.tools.failedCalls.slice(0, limit * 2)) {
        const jobStr = fc.jobName ? ` (${fc.jobName})` : '';
        const codeStr = fc.errorCode ? `[${fc.errorCode}] ` : '';
        const errorMsg = fc.errorMessage || 'Unknown error';
        lines.push(`  ${fc.tool}${jobStr}: ${codeStr}"${raw ? errorMsg : truncate(errorMsg, 60)}"`);
      }
    }
    lines.push('');
  }

  // Tree summary
  lines.push('─'.repeat(40));
  lines.push('Job Tree');
  lines.push('─'.repeat(40));

  function printTree(node: any, indent: string = '') {
    const name = node.jobName || node.id.slice(0, 10) + '...';
    const statusIcon = node.status === 'COMPLETED' ? '✓' : node.status === 'FAILED' ? '✗' : '○';
    lines.push(`${indent}${statusIcon} ${name}`);
    for (const child of node.children || []) {
      printTree(child, indent + '  ');
    }
  }

  const tree = Array.isArray(result.tree) ? result.tree : [result.tree];
  for (const node of tree) {
    printTree(node);
  }

  return lines.join('\n');
}

// --- Help Text ---

const HELP_EPILOGUE = `
Drill-down helpers:
  yarn inspect-job-run <request-id>    Full details for one execution
  yarn inspect-job <job-def-id>        History of a job definition
  scripts/memory/inspect-situation.ts  Memory/recognition details

Common workflows:
  # Debug a failed workstream
  yarn inspect-workstream <id> --status=failed --show-errors --format=summary

  # Trace dispatch chain
  yarn inspect-workstream <id> --show-dispatch

  # Check token costs
  yarn inspect-workstream <id> --show-metrics
`;

// --- Main ---

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .usage('Usage: $0 <workstream-id> [options]')
    .demandCommand(1, 'You must provide a workstream ID')
    .option('limit', {
      type: 'string',
      describe: 'Max requests to fetch (default: all)'
    })
    .option('page-size', {
      type: 'string',
      describe: 'Page size for GraphQL pagination (default: 200)'
    })
    .option('status', {
      type: 'string',
      choices: ['failed', 'pending', 'completed', 'all'] as const,
      default: 'all',
      describe: 'Filter by job status'
    })
    .option('job-name', {
      type: 'string',
      describe: 'Filter by job name pattern (regex)'
    })
    .option('depth', {
      type: 'number',
      describe: 'Max hierarchy depth (0 = root only)'
    })
    .option('since', {
      type: 'string',
      describe: 'Only requests after timestamp (ISO or Unix)'
    })
    .option('show-errors', {
      type: 'boolean',
      default: false,
      describe: 'Include error aggregation section'
    })
    .option('show-dispatch', {
      type: 'boolean',
      default: false,
      describe: 'Include dispatch chain/reasons'
    })
    .option('show-git', {
      type: 'boolean',
      default: false,
      describe: 'Include git operations summary'
    })
    .option('show-metrics', {
      type: 'boolean',
      default: false,
      describe: 'Include token usage and invariant stats'
    })
    .option('show-telemetry', {
      type: 'boolean',
      default: false,
      describe: 'Fetch full worker telemetry for each job'
    })
    .option('show-timing', {
      type: 'boolean',
      default: false,
      describe: 'Include phase duration analysis'
    })
    .option('show-tools', {
      type: 'boolean',
      default: false,
      describe: 'Include tool usage analytics'
    })
    .option('show-all', {
      type: 'boolean',
      default: false,
      describe: 'Enable all --show-* options'
    })
    .option('format', {
      type: 'string',
      choices: ['json', 'summary'] as const,
      default: 'json',
      describe: 'Output format'
    })
    .option('raw', {
      type: 'boolean',
      default: false,
      describe: 'Output full data without truncation (all errors, all tools, etc.)'
    })
    .option('top-n', {
      type: 'number',
      default: 5,
      describe: 'Max items to show in summary lists (errors, tools, jobs)'
    })
    .epilogue(HELP_EPILOGUE)
    .help()
    .parserConfiguration({
      'parse-numbers': false,
      'parse-positional-numbers': false
    })
    .parse();

  const workstreamId = String(argv._[0]);
  const rawLimit = argv.limit ? Number(argv.limit) : undefined;
  const requestLimit = rawLimit && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  const rawPageSize = argv['page-size'] ? Number(argv['page-size']) : 200;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? rawPageSize : 200;

  // Build filters
  const filters: FilterOptions = {
    status: argv.status as FilterOptions['status'],
    maxDepth: argv.depth,
  };

  if (argv['job-name']) {
    try {
      filters.jobNamePattern = new RegExp(argv['job-name'], 'i');
    } catch {
      console.error(`Invalid regex pattern: ${argv['job-name']}`);
      process.exit(1);
    }
  }

  if (argv.since) {
    const sinceVal = argv.since;
    const parsed = /^\d+$/.test(sinceVal)
      ? new Date(Number(sinceVal) * 1000)
      : new Date(sinceVal);
    if (isNaN(parsed.getTime())) {
      console.error(`Invalid timestamp: ${sinceVal}`);
      process.exit(1);
    }
    filters.since = parsed;
  }

  const showAll = argv['show-all'];
  const showErrors = showAll || argv['show-errors'];
  const showDispatch = showAll || argv['show-dispatch'];
  const showGit = showAll || argv['show-git'];
  const showMetrics = showAll || argv['show-metrics'];
  const showTelemetry = showAll || argv['show-telemetry'];
  const showTiming = showAll || argv['show-timing'];
  const showTools = showAll || argv['show-tools'];
  const outputFormat = argv.format as 'json' | 'summary';
  const rawOutput = argv.raw;
  const topN = rawOutput ? Infinity : (argv['top-n'] || 5);

  console.error(`\n🔍 Inspecting workstream: ${workstreamId}`);
  console.error(`Ponder API: ${PONDER_GRAPHQL_URL}`);
  console.error(`Pagination: pageSize=${pageSize}${requestLimit ? ` limit=${requestLimit}` : ''}`);
  if (filters.status !== 'all') console.error(`Filter: status=${filters.status}`);
  if (filters.jobNamePattern) console.error(`Filter: job-name=${filters.jobNamePattern}`);
  if (filters.maxDepth !== undefined) console.error(`Filter: depth=${filters.maxDepth}`);
  if (filters.since) console.error(`Filter: since=${filters.since.toISOString()}`);
  console.error('');

  const client = new GraphQLClient(PONDER_GRAPHQL_URL);

  try {
    // 1. Fetch all requests in the workstream
    console.error('Fetching requests...');
    const requests = await fetchPaged<Request>(
      async (limit, offset) => {
        const res = await client.request<{ requests: { items: Request[] } }>(WORKSTREAM_QUERY, {
          workstreamId,
          limit,
          offset
        });
        return res.requests.items;
      },
      pageSize,
      requestLimit
    );

    if (requests.length === 0) {
      console.error('❌ No requests found for this workstream ID.');
      process.exit(1);
    }

    // 2. Fetch job definitions
    const uniqueJobDefIds = [...new Set(requests.map(r => r.jobDefinitionId).filter(Boolean))];
    console.error(`Fetching ${uniqueJobDefIds.length} job definitions for ${requests.length} requests...`);

    const jobDefinitions: Array<{ id: string; name: string; lastStatus: string; lastInteraction: string; sourceJobDefinitionId: string }> = [];
    const jobDefChunks = chunkArray(uniqueJobDefIds, pageSize);
    for (const chunk of jobDefChunks) {
      const res = await client.request<{ jobDefinitions: { items: typeof jobDefinitions } }>(
        JOB_DEFINITIONS_QUERY,
        { jobDefIds: chunk, limit: chunk.length }
      );
      jobDefinitions.push(...res.jobDefinitions.items);
    }
    console.error(`✅ Found ${jobDefinitions.length} unique jobs with ${requests.length} total job runs`);

    const requestIds = requests.map(r => r.id);

    // 3. Fetch deliveries and artifacts
    console.error('Fetching deliveries and artifacts...');
    const requestIdChunks = chunkArray(requestIds, pageSize);
    const deliveries: Delivery[] = [];
    const artifacts: Artifact[] = [];

    for (const chunk of requestIdChunks) {
      const [chunkDeliveries, chunkArtifacts] = await Promise.all([
        fetchPaged<Delivery>(async (limit, offset) => {
          const res = await client.request<{ deliverys: { items: Delivery[] } }>(DELIVERIES_QUERY, {
            requestIds: chunk, limit, offset
          });
          return res.deliverys.items;
        }, pageSize),
        fetchPaged<Artifact>(async (limit, offset) => {
          const res = await client.request<{ artifacts: { items: Artifact[] } }>(ARTIFACTS_QUERY, {
            requestIds: chunk, limit, offset
          });
          return res.artifacts.items;
        }, pageSize)
      ]);
      deliveries.push(...chunkDeliveries);
      artifacts.push(...chunkArtifacts);
    }
    console.error(`✅ Found ${deliveries.length} deliveries and ${artifacts.length} artifacts`);

    // 4. Build maps
    const deliveryMap = new Map<string, Delivery>();
    deliveries.forEach(d => deliveryMap.set(d.requestId, d));

    const artifactMap = new Map<string, Artifact[]>();
    artifacts.forEach(a => {
      if (!artifactMap.has(a.requestId)) artifactMap.set(a.requestId, []);
      artifactMap.get(a.requestId)!.push(a);
    });

    const requestMap = new Map<string, Request>();
    requests.forEach(r => requestMap.set(r.id, r));

    // 5. Fetch delivery content and build nodes
    console.error('\nResolving node details...');

    const nodeMap = new Map<string, WorkstreamNode>();
    const deliveryContents = new Map<string, any>();
    const allErrors: ErrorSummary[] = [];
    const allGitOps: GitOperationSummary[] = [];
    const allTokenMetrics: TokenMetrics[] = [];
    const allInvariantMetrics: InvariantMetrics[] = [];
    const allTimingMetrics: TimingMetrics[] = [];
    const allToolMetrics: ToolMetrics[] = [];
    const allFailedToolCalls: FailedToolCall[] = [];
    const dispatchInfos: DispatchInfo[] = [];

    for (const req of requests) {
      const delivery = deliveryMap.get(req.id);
      const reqArtifacts = artifactMap.get(req.id) || [];
      const depth = computeDepth(requestMap as Map<string, { sourceRequestId?: string }>, req.id, workstreamId);

      let status: WorkstreamNode['status'] = req.delivered ? 'COMPLETED' : 'PENDING';
      let summary: string | undefined;
      let error: string | undefined;
      let actualFinalStatus: string | undefined;
      let deliveryContent: any = null;

      // Fetch delivery content
      if (req.delivered && delivery?.ipfsHash) {
        deliveryContent = await fetchIpfsContent(delivery.ipfsHash, req.id);
        deliveryContents.set(req.id, deliveryContent);

        if (deliveryContent) {
          if (deliveryContent.status) {
            actualFinalStatus = deliveryContent.status;
            const finalStatusValue = deliveryContent.status.toUpperCase();
            if (finalStatusValue === 'COMPLETED') {
              status = 'COMPLETED';
            } else if (finalStatusValue === 'FAILED') {
              status = 'FAILED';
              error = deliveryContent.statusMessage || deliveryContent.errorMessage || deliveryContent.error || 'Job failed';
            } else if (finalStatusValue === 'WAITING' || finalStatusValue === 'DELEGATING') {
              status = 'PENDING';
            }
          } else if (deliveryContent.error || deliveryContent.errorMessage) {
            status = 'FAILED';
            error = deliveryContent.errorMessage || deliveryContent.error || 'Unknown error';
          }

          if (deliveryContent.structuredSummary) {
            summary = truncate(deliveryContent.structuredSummary, 300);
          } else if (deliveryContent.output) {
            summary = truncate(deliveryContent.output, 200);
          }

          // Extract metrics if requested
          if (showMetrics) {
            const tokenMetrics = extractTokenMetrics(req.id, req.jobName, deliveryContent);
            if (tokenMetrics) allTokenMetrics.push(tokenMetrics);

            const invMetrics = extractInvariantMetrics(req.id, req.jobName, deliveryContent);
            if (invMetrics) allInvariantMetrics.push(invMetrics);
          }

          // Extract errors from delivery content (fallback when no telemetry)
          if (showErrors && error) {
            allErrors.push({
              requestId: req.id,
              jobName: req.jobName,
              phase: 'delivery',
              error,
              timestamp: delivery?.blockTimestamp
                ? new Date(Number(delivery.blockTimestamp) * 1000).toISOString()
                : new Date().toISOString(),
            });
          }
        }
      }

      // Build dispatch info if requested
      if (showDispatch) {
        let additionalContext: any = null;

        // Fetch request IPFS content to get full additionalContext with auto-dispatch flags
        // (Ponder's additionalContext field doesn't contain verificationRequired, cycle, loopRecovery, etc.)
        if (req.ipfsHash) {
          const requestContent = await fetchIpfsContent(req.ipfsHash);
          if (requestContent?.additionalContext) {
            additionalContext = requestContent.additionalContext;
          }
        }

        // Fallback to Ponder's additionalContext if IPFS fetch fails
        if (!additionalContext && req.additionalContext) {
          try {
            additionalContext = JSON.parse(req.additionalContext);
          } catch {
            // Invalid JSON
          }
        }

        dispatchInfos.push({
          requestId: req.id,
          jobDefinitionId: req.jobDefinitionId,
          jobName: req.jobName,
          sourceRequestId: req.sourceRequestId,
          sourceJobDefinitionId: req.sourceJobDefinitionId,
          dispatchType: detectDispatchType(additionalContext),
          dispatchMessage: parseDispatchMessage(additionalContext),
          depth,
        });
      }

      // Extract telemetry from delivery content (primary source - like frontend does)
      // Worker embeds workerTelemetry in delivery payload, which is more reliable than
      // WORKER_TELEMETRY artifacts (which go to Supabase, not Ponder)
      let telemetryExtracted = false;
      if ((showErrors || showGit || showTelemetry || showTiming || showTools) && deliveryContent?.workerTelemetry) {
        const telemetry = deliveryContent.workerTelemetry;
        if (telemetry.events && Array.isArray(telemetry.events)) {
          telemetryExtracted = true;
          if (showErrors) {
            allErrors.push(...extractErrorsFromTelemetry(telemetry));
          }
          if (showGit) {
            const gitOps = extractGitOpsFromTelemetry(telemetry);
            if (gitOps) allGitOps.push(gitOps);
          }
          if (showTiming) {
            const timing = extractTimingMetrics(req.id, req.jobName, telemetry);
            if (timing) allTimingMetrics.push(timing);
          }
          if (showTools) {
            const toolMetrics = extractToolMetricsFromTelemetry(telemetry);
            if (toolMetrics) allToolMetrics.push(toolMetrics);
          }
        }
      }

      // Extract failed tool calls from agent telemetry (deliveryContent.telemetry)
      // This has full tool call details including result.meta.ok for logical failures
      if (showTools && deliveryContent?.telemetry?.toolCalls) {
        const failed = extractFailedToolCalls(req.id, req.jobName, deliveryContent.telemetry);
        allFailedToolCalls.push(...failed);
      }

      // Fallback: Fetch telemetry from WORKER_TELEMETRY artifact (when available in Ponder)
      if ((showErrors || showGit || showTelemetry) && req.delivered && !telemetryExtracted) {
        const telemetry = await fetchWorkerTelemetryArtifact(client, req.id);
        if (telemetry) {
          if (showErrors) {
            allErrors.push(...extractErrorsFromTelemetry(telemetry));
          }
          if (showGit) {
            const gitOps = extractGitOpsFromTelemetry(telemetry);
            if (gitOps) allGitOps.push(gitOps);
          }
        }
      }

      // Extract git info from git/branch artifacts (fallback when no telemetry)
      if (showGit) {
        const gitBranchArtifacts = reqArtifacts.filter(a => a.topic === 'git/branch');
        for (const artifact of gitBranchArtifacts) {
          const artifactContent = await fetchIpfsContent(artifact.cid);
          if (artifactContent) {
            // Parse nested content field (artifact stores branch info as JSON string in content)
            let branchContent = artifactContent;
            if (typeof artifactContent.content === 'string') {
              try {
                branchContent = JSON.parse(artifactContent.content);
              } catch {
                // Use outer content if parsing fails
              }
            }

            allGitOps.push({
              requestId: req.id,
              branchName: branchContent.headBranch || branchContent.branchName || branchContent.branch,
              baseBranch: branchContent.baseBranch,
              branchUrl: branchContent.branchUrl || branchContent.url,
              commitHash: branchContent.commitHash || branchContent.commit,
              filesChanged: branchContent.filesChanged,
              pushed: branchContent.pushed ?? true,
              hasConflicts: branchContent.hasConflicts ?? false,
              conflictingFiles: branchContent.conflictingFiles,
            });
          }
        }
      }

      // Apply filters
      if (!shouldIncludeRequest(req, status, depth, filters)) {
        continue;
      }

      nodeMap.set(req.id, {
        id: req.id,
        jobName: req.jobName,
        jobDefinitionId: req.jobDefinitionId,
        status,
        timestamp: new Date(Number(req.blockTimestamp) * 1000).toISOString(),
        summary,
        error,
        children: [],
        artifacts: reqArtifacts.map(a => ({ name: a.name, topic: a.topic, type: a.type })),
        _debug: {
          delivered: req.delivered,
          hasDelivery: !!delivery,
          finalStatus: actualFinalStatus
        }
      });
    }

    // 6. Assemble tree
    const rootNodes: WorkstreamNode[] = [];

    for (const req of requests) {
      const node = nodeMap.get(req.id);
      if (!node) continue; // Filtered out

      if (req.id === workstreamId || !req.sourceRequestId) {
        rootNodes.push(node);
      } else {
        const parent = nodeMap.get(req.sourceRequestId);
        if (parent) {
          parent.children.push(node);
        } else {
          rootNodes.push(node);
        }
      }
    }

    // 7. Build job execution summary
    const jobRunsByDefinition = new Map<string, Request[]>();
    requests.forEach(req => {
      if (!req.jobDefinitionId) return;
      if (!jobRunsByDefinition.has(req.jobDefinitionId)) {
        jobRunsByDefinition.set(req.jobDefinitionId, []);
      }
      jobRunsByDefinition.get(req.jobDefinitionId)!.push(req);
    });

    const jobExecutionSummary = jobDefinitions.map(jobDef => ({
      id: jobDef.id,
      name: jobDef.name,
      lastStatus: jobDef.lastStatus,
      executionCount: jobRunsByDefinition.get(jobDef.id)?.length || 0,
      runs: jobRunsByDefinition.get(jobDef.id)?.map(r => ({
        requestId: r.id,
        delivered: r.delivered,
        timestamp: new Date(Number(r.blockTimestamp) * 1000).toISOString()
      })) || []
    }));

    // 8. Count failed runs
    let failedRuns = 0;
    for (const node of Array.from(nodeMap.values())) {
      if (node.status === 'FAILED') failedRuns++;
    }

    // 9. Build result
    const result: any = {
      workstreamId,
      stats: {
        uniqueJobs: jobDefinitions.length,
        totalJobRuns: requests.length,
        completedRuns: requests.filter(r => r.delivered).length,
        pendingRuns: requests.filter(r => !r.delivered).length,
        failedRuns,
        totalArtifacts: artifacts.length,
        jobsInWaiting: jobDefinitions.filter(j => j.lastStatus === 'WAITING').length,
        jobsCompleted: jobDefinitions.filter(j => j.lastStatus === 'COMPLETED').length
      },
      jobs: jobExecutionSummary,
      tree: rootNodes.length === 1 ? rootNodes[0] : rootNodes
    };

    // Add optional sections
    if (showErrors && allErrors.length > 0) {
      const byPhase: Record<string, number> = {};
      for (const err of allErrors) {
        byPhase[err.phase] = (byPhase[err.phase] || 0) + 1;
      }

      result.errors = {
        total: allErrors.length,
        byPhase,
        topErrors: aggregateErrorsByPattern(allErrors, 10),
      };
    }

    if (showDispatch && dispatchInfos.length > 0) {
      // Add child count to each dispatch info
      const childCounts = new Map<string, number>();
      for (const d of dispatchInfos) {
        if (d.sourceRequestId) {
          childCounts.set(d.sourceRequestId, (childCounts.get(d.sourceRequestId) || 0) + 1);
        }
      }

      result.dispatchChain = dispatchInfos.map(d => ({
        requestId: d.requestId,
        jobName: d.jobName,
        depth: d.depth,
        dispatchedBy: d.sourceRequestId,
        dispatchType: d.dispatchType,
        dispatchReason: d.dispatchMessage,
        childCount: childCounts.get(d.requestId) || 0,
        status: nodeMap.get(d.requestId)?.status || 'UNKNOWN',
      }));
    }

    if (showGit && allGitOps.length > 0) {
      const conflicts = allGitOps
        .filter(g => g.hasConflicts)
        .map(g => ({
          requestId: g.requestId,
          branch: g.branchName || 'unknown',
          files: g.conflictingFiles || [],
        }));

      result.gitSummary = {
        totalBranches: allGitOps.length,
        pushedBranches: allGitOps.filter(g => g.pushed).length,
        conflicts,
        branches: allGitOps.map(g => ({
          requestId: g.requestId,
          jobName: nodeMap.get(g.requestId)?.jobName,
          branchName: g.branchName || 'unknown',
          branchUrl: g.branchUrl,
          pushed: g.pushed,
        })),
      };
    }

    if (showMetrics) {
      const totalTokens = allTokenMetrics.reduce((sum, m) => sum + (m.totalTokens || 0), 0);

      const totalMeasured = allInvariantMetrics.reduce((sum, m) => sum + m.measuredInvariants, 0);
      const totalPassed = allInvariantMetrics.reduce((sum, m) => sum + m.passedInvariants, 0);
      const totalFailed = allInvariantMetrics.reduce((sum, m) => sum + m.failedInvariants, 0);
      const unmeasuredJobs = allInvariantMetrics
        .filter(m => m.unmeasuredIds.length > 0)
        .map(m => ({
          requestId: m.requestId,
          jobName: m.jobName,
          unmeasuredIds: m.unmeasuredIds,
        }));

      // Aggregate tool calls from telemetry
      const toolCallTotals: Record<string, { calls: number; failures: number }> = {};
      let totalToolCalls = 0;
      let totalToolFailures = 0;

      for (const content of Array.from(deliveryContents.values())) {
        if (content?.telemetry?.toolCalls) {
          for (const tc of content.telemetry.toolCalls) {
            totalToolCalls++;
            if (!tc.success) totalToolFailures++;

            if (!toolCallTotals[tc.tool]) {
              toolCallTotals[tc.tool] = { calls: 0, failures: 0 };
            }
            toolCallTotals[tc.tool].calls++;
            if (!tc.success) toolCallTotals[tc.tool].failures++;
          }
        }
      }

      result.metrics = {
        tokenUsage: {
          total: totalTokens,
          byJob: allTokenMetrics,
        },
        invariants: {
          totalMeasured,
          totalPassed,
          totalFailed,
          unmeasuredJobs,
        },
        toolCalls: {
          total: totalToolCalls,
          failures: totalToolFailures,
          byTool: toolCallTotals,
        },
      };
    }

    if (showTiming && allTimingMetrics.length > 0) {
      result.timing = aggregateTimingMetrics(allTimingMetrics);
    }

    if (showTools && allToolMetrics.length > 0) {
      result.tools = aggregateToolMetrics(allToolMetrics);

      // Add failed tool call details
      if (allFailedToolCalls.length > 0) {
        result.tools.failedCalls = allFailedToolCalls;
      }
    }

    // 10. Output
    console.error('\n✅ Workstream graph built successfully\n');

    if (outputFormat === 'summary') {
      console.log(formatSummaryOutput(result, { topN, raw: rawOutput }));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }

  } catch (error) {
    console.error('\n❌ Error inspecting workstream:', error);
    process.exit(1);
  }
}

main();
