/**
 * Shared utilities for workstream inspection
 *
 * Provides types and functions for extracting telemetry, errors, git operations,
 * and dispatch information from workstream data.
 */

import { GraphQLClient, gql } from 'graphql-request';

// Re-export types from worker modules (local path within package)
export type { WorkerTelemetryLog, WorkerTelemetryEvent, ToolMetrics } from '../worker/worker_telemetry.js';

import type { WorkerTelemetryLog, ToolMetrics } from '../worker/worker_telemetry.js';

// --- Interfaces ---

export interface ErrorSummary {
  requestId: string;
  jobName?: string;
  phase: string;
  error: string;
  timestamp: string;
}

export interface GitOperationSummary {
  requestId: string;
  branchName?: string;
  baseBranch?: string;
  branchUrl?: string;
  commitHash?: string;
  filesChanged?: number;
  pushed: boolean;
  hasConflicts: boolean;
  conflictingFiles?: string[];
}

export interface DispatchInfo {
  requestId: string;
  jobDefinitionId?: string;
  jobName?: string;
  sourceRequestId?: string;
  sourceJobDefinitionId?: string;
  dispatchType: DispatchType;
  dispatchMessage?: string;
  depth: number;
}

export type DispatchType =
  | 'manual'
  | 'verification'
  | 'continuation'
  | 'cycle'
  | 'loop_recovery'
  | 'timeout_recovery'
  | 'parent';

export interface TokenMetrics {
  requestId: string;
  jobName?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
}

export interface InvariantMetrics {
  requestId: string;
  jobName?: string;
  totalInvariants: number;
  measuredInvariants: number;
  passedInvariants: number;
  failedInvariants: number;
  unmeasuredIds: string[];
}

export interface TimingMetrics {
  requestId: string;
  jobName?: string;
  totalDuration_ms: number;
  byPhase: Record<string, number>;
}

export interface AggregatedTimingMetrics {
  totalDuration_ms: number;
  avgJobDuration_ms: number;
  byPhase: Array<{
    phase: string;
    totalDuration_ms: number;
    avgDuration_ms: number;
    percentage: number;
  }>;
  slowestJobs: Array<{
    requestId: string;
    jobName?: string;
    totalDuration_ms: number;
    slowestPhase: string;
  }>;
}

export interface AggregatedToolMetrics {
  totalCalls: number;
  totalFailures: number;
  failureRate: number;
  byTool: Array<{
    tool: string;
    calls: number;
    failures: number;
    failureRate: number;
    avgDuration_ms: number;
    totalDuration_ms: number;
  }>;
  slowestTools: Array<{
    tool: string;
    avgDuration_ms: number;
  }>;
  failingTools: Array<{
    tool: string;
    failureRate: number;
    failures: number;
  }>;
}

export interface FailedToolCall {
  requestId: string;
  jobName?: string;
  tool: string;
  errorCode?: string;
  errorMessage?: string;
  executionFailed: boolean;
}

// --- IPFS Helpers ---

const IPFS_GATEWAY_URL = process.env.IPFS_GATEWAY_URL || 'https://gateway.autonolas.tech/ipfs/';

export async function fetchIpfsContent(cid: string, requestIdForDelivery?: string): Promise<any> {
  let url = `${IPFS_GATEWAY_URL}${cid}`;

  // Delivery directory reconstruction for f01551220 CIDs
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

// --- GraphQL Queries ---

const WORKER_TELEMETRY_ARTIFACT_QUERY = gql`
  query GetWorkerTelemetryArtifact($requestId: String!) {
    artifacts(
      where: { requestId: $requestId, topic: "WORKER_TELEMETRY" }
      limit: 1
    ) {
      items {
        id
        cid
        topic
      }
    }
  }
`;

// --- Telemetry Extraction ---

/**
 * Fetch worker telemetry artifact for a request
 */
export async function fetchWorkerTelemetryArtifact(
  client: GraphQLClient,
  requestId: string
): Promise<WorkerTelemetryLog | null> {
  try {
    const result = await client.request<{ artifacts: { items: Array<{ cid: string }> } }>(
      WORKER_TELEMETRY_ARTIFACT_QUERY,
      { requestId }
    );

    if (result.artifacts.items.length === 0) return null;

    const cid = result.artifacts.items[0].cid;
    const content = await fetchIpfsContent(cid);

    if (!content || typeof content !== 'object') return null;
    if (content.version !== 'worker-telemetry-v1') return null;

    return content as WorkerTelemetryLog;
  } catch {
    return null;
  }
}

/**
 * Extract errors from worker telemetry
 */
export function extractErrorsFromTelemetry(
  telemetry: WorkerTelemetryLog
): ErrorSummary[] {
  const errors: ErrorSummary[] = [];

  for (const event of telemetry.events) {
    if (event.event === 'error' && event.error) {
      errors.push({
        requestId: telemetry.requestId,
        jobName: telemetry.jobName,
        phase: event.phase,
        error: event.error,
        timestamp: event.timestamp,
      });
    }
  }

  return errors;
}

/**
 * Extract git operations from worker telemetry
 */
export function extractGitOpsFromTelemetry(
  telemetry: WorkerTelemetryLog
): GitOperationSummary | null {
  const gitOps: GitOperationSummary = {
    requestId: telemetry.requestId,
    pushed: false,
    hasConflicts: false,
  };

  let foundGitOps = false;

  for (const event of telemetry.events) {
    if (event.phase !== 'git_operations') continue;
    foundGitOps = true;

    const meta = event.metadata as Record<string, any> | undefined;
    if (!meta) continue;

    switch (event.event) {
      case 'branch_checkout':
        gitOps.branchName = meta.branchName;
        gitOps.baseBranch = meta.baseBranch;
        break;

      case 'auto_commit':
        gitOps.commitHash = meta.commitHash;
        gitOps.filesChanged = meta.filesChanged;
        break;

      case 'push':
        gitOps.pushed = meta.success === true;
        gitOps.branchUrl = meta.branchUrl;
        // Also extract branchName from push event if not already set
        if (!gitOps.branchName && meta.branchName) {
          gitOps.branchName = meta.branchName;
        }
        break;

      case 'branch_artifact_created':
        gitOps.branchUrl = meta.branchUrl;
        break;

      case 'merge_conflict':
        gitOps.hasConflicts = true;
        gitOps.conflictingFiles = meta.files || meta.conflictingFiles || [];
        break;
    }
  }

  return foundGitOps ? gitOps : null;
}

// --- Dispatch Detection ---

/**
 * Detect dispatch type from additionalContext
 */
export function detectDispatchType(additionalContext: any): DispatchType {
  if (!additionalContext) return 'manual';

  // Check for verification dispatch
  if (additionalContext.verificationRequired === true) {
    return 'verification';
  }

  // Check for cycle dispatch
  if (additionalContext.cycle?.isCycleRun === true) {
    return 'cycle';
  }

  // Check for loop recovery
  if (typeof additionalContext.loopRecovery?.attempt === 'number') {
    return 'loop_recovery';
  }

  // Check for timeout recovery
  if (typeof additionalContext.timeoutRecovery?.attempt === 'number') {
    return 'timeout_recovery';
  }

  // Check for continuation (from message type)
  if (additionalContext.message?.type === 'continuation') {
    return 'continuation';
  }

  // Check for parent dispatch (from child completion)
  if (additionalContext.message?.from && additionalContext.message?.to) {
    return 'parent';
  }

  return 'manual';
}

/**
 * Parse dispatch message from additionalContext
 */
export function parseDispatchMessage(additionalContext: any): string | undefined {
  if (!additionalContext) return undefined;

  // Direct message field
  if (typeof additionalContext.message === 'string') {
    return additionalContext.message;
  }

  // Message object with text
  if (additionalContext.message?.text) {
    return additionalContext.message.text;
  }

  // Message object with type
  if (additionalContext.message?.type) {
    const type = additionalContext.message.type;

    if (type === 'continuation') {
      return 'Continuation dispatch';
    }

    if (additionalContext.message.from && additionalContext.message.to) {
      return `Child ${additionalContext.message.from.slice(0, 10)}... completed`;
    }

    return `Dispatch type: ${type}`;
  }

  // Verification context
  if (additionalContext.verificationRequired) {
    const attempt = additionalContext.verificationAttempt || 1;
    return `Verification run #${attempt}`;
  }

  // Cycle context
  if (additionalContext.cycle?.isCycleRun) {
    const cycleNum = additionalContext.cycle.cycleNumber || 1;
    return `Cycle #${cycleNum}`;
  }

  // Recovery context
  if (additionalContext.loopRecovery?.attempt) {
    return `Loop recovery attempt #${additionalContext.loopRecovery.attempt}`;
  }

  if (additionalContext.timeoutRecovery?.attempt) {
    return `Timeout recovery attempt #${additionalContext.timeoutRecovery.attempt}`;
  }

  return undefined;
}

// --- Metrics Extraction ---

/**
 * Extract token metrics from delivery content
 */
export function extractTokenMetrics(
  requestId: string,
  jobName: string | undefined,
  deliveryContent: any
): TokenMetrics | null {
  if (!deliveryContent?.telemetry) return null;

  const telemetry = deliveryContent.telemetry;

  return {
    requestId,
    jobName,
    model: deliveryContent.model,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    totalTokens: telemetry.totalTokens || 0,
  };
}

/**
 * Extract invariant metrics from delivery content
 */
export function extractInvariantMetrics(
  requestId: string,
  jobName: string | undefined,
  deliveryContent: any
): InvariantMetrics | null {
  const coverage = deliveryContent?.measurementCoverage;
  const blueprint = deliveryContent?.blueprint;

  if (!coverage && !blueprint) return null;

  // Parse blueprint invariants
  let totalInvariants = 0;
  const allInvariantIds: string[] = [];

  if (blueprint?.invariants) {
    try {
      const invariants = typeof blueprint.invariants === 'string'
        ? JSON.parse(blueprint.invariants)
        : blueprint.invariants;

      if (Array.isArray(invariants)) {
        totalInvariants = invariants.length;
        allInvariantIds.push(...invariants.map((inv: any) => inv.id).filter(Boolean));
      }
    } catch {
      // Blueprint parsing failed
    }
  }

  // Parse measurement coverage
  let measuredInvariants = 0;
  let passedInvariants = 0;
  let failedInvariants = 0;
  const measuredIds: string[] = [];

  if (coverage) {
    if (Array.isArray(coverage.measurements)) {
      measuredInvariants = coverage.measurements.length;
      for (const m of coverage.measurements) {
        measuredIds.push(m.invariantId);
        if (m.passed) {
          passedInvariants++;
        } else {
          failedInvariants++;
        }
      }
    }
  }

  // Calculate unmeasured
  const measuredSet = new Set(measuredIds);
  const unmeasuredIds = allInvariantIds.filter(id => !measuredSet.has(id));

  return {
    requestId,
    jobName,
    totalInvariants,
    measuredInvariants,
    passedInvariants,
    failedInvariants,
    unmeasuredIds,
  };
}

// --- Timing Metrics Extraction ---

/**
 * Extract timing metrics from worker telemetry
 */
export function extractTimingMetrics(
  requestId: string,
  jobName: string | undefined,
  telemetry: WorkerTelemetryLog
): TimingMetrics | null {
  if (!telemetry.events || telemetry.events.length === 0) return null;

  const byPhase: Record<string, number> = {};

  for (const event of telemetry.events) {
    if (event.event === 'phase_end' && event.duration_ms) {
      byPhase[event.phase] = (byPhase[event.phase] || 0) + event.duration_ms;
    }
  }

  return {
    requestId,
    jobName,
    totalDuration_ms: telemetry.totalDuration_ms || 0,
    byPhase,
  };
}

/**
 * Extract tool metrics from worker telemetry summary
 */
export function extractToolMetricsFromTelemetry(
  telemetry: WorkerTelemetryLog
): ToolMetrics | null {
  return telemetry.summary?.toolMetrics || null;
}

/**
 * Extract failed tool calls from agent telemetry
 * Checks BOTH execution failures (success=false) AND logical failures (meta.ok=false)
 */
export function extractFailedToolCalls(
  requestId: string,
  jobName: string | undefined,
  telemetry: { toolCalls?: Array<{ tool: string; success: boolean; error?: string; result?: any }> }
): FailedToolCall[] {
  if (!telemetry?.toolCalls) return [];

  const failed: FailedToolCall[] = [];

  for (const tc of telemetry.toolCalls) {
    // Case 1: Execution failure (success: false)
    if (!tc.success) {
      failed.push({
        requestId,
        jobName,
        tool: tc.tool,
        errorCode: tc.result?.meta?.code,
        errorMessage: tc.error || tc.result?.meta?.message || 'Execution failed',
        executionFailed: true,
      });
      continue;
    }

    // Case 2: Logical failure (success: true but meta.ok: false)
    const meta = tc.result?.meta;
    if (meta && meta.ok === false) {
      failed.push({
        requestId,
        jobName,
        tool: tc.tool,
        errorCode: meta.code,
        errorMessage: meta.message,
        executionFailed: false,
      });
    }
  }

  return failed;
}

/**
 * Aggregate timing metrics across multiple jobs
 */
export function aggregateTimingMetrics(
  metrics: TimingMetrics[],
  topN: number = 5
): AggregatedTimingMetrics {
  if (metrics.length === 0) {
    return {
      totalDuration_ms: 0,
      avgJobDuration_ms: 0,
      byPhase: [],
      slowestJobs: [],
    };
  }

  const totalDuration = metrics.reduce((sum, m) => sum + m.totalDuration_ms, 0);
  const avgJobDuration = Math.round(totalDuration / metrics.length);

  // Aggregate by phase
  const phaseAggregates: Record<string, { total: number; count: number }> = {};
  for (const m of metrics) {
    for (const [phase, duration] of Object.entries(m.byPhase)) {
      if (!phaseAggregates[phase]) {
        phaseAggregates[phase] = { total: 0, count: 0 };
      }
      phaseAggregates[phase].total += duration;
      phaseAggregates[phase].count++;
    }
  }

  const byPhase = Object.entries(phaseAggregates)
    .map(([phase, agg]) => ({
      phase,
      totalDuration_ms: agg.total,
      avgDuration_ms: Math.round(agg.total / agg.count),
      percentage: totalDuration > 0 ? Math.round((agg.total / totalDuration) * 100) : 0,
    }))
    .sort((a, b) => b.totalDuration_ms - a.totalDuration_ms);

  // Find slowest jobs
  const slowestJobs = [...metrics]
    .sort((a, b) => b.totalDuration_ms - a.totalDuration_ms)
    .slice(0, topN)
    .map(m => {
      const slowestPhase = Object.entries(m.byPhase)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
      return {
        requestId: m.requestId,
        jobName: m.jobName,
        totalDuration_ms: m.totalDuration_ms,
        slowestPhase,
      };
    });

  return {
    totalDuration_ms: totalDuration,
    avgJobDuration_ms: avgJobDuration,
    byPhase,
    slowestJobs,
  };
}

/**
 * Aggregate tool metrics across multiple telemetry records
 */
export function aggregateToolMetrics(
  toolMetricsArray: Array<ToolMetrics>,
  topN: number = 10
): AggregatedToolMetrics {
  if (toolMetricsArray.length === 0) {
    return {
      totalCalls: 0,
      totalFailures: 0,
      failureRate: 0,
      byTool: [],
      slowestTools: [],
      failingTools: [],
    };
  }

  const aggregatedByTool: Record<string, {
    calls: number;
    failures: number;
    totalDuration_ms: number;
  }> = {};

  let totalCalls = 0;
  let totalFailures = 0;

  for (const tm of toolMetricsArray) {
    totalCalls += tm.totalCalls;
    totalFailures += tm.failureCount;

    for (const [tool, stats] of Object.entries(tm.byTool)) {
      if (!aggregatedByTool[tool]) {
        aggregatedByTool[tool] = { calls: 0, failures: 0, totalDuration_ms: 0 };
      }
      aggregatedByTool[tool].calls += stats.calls;
      aggregatedByTool[tool].failures += stats.failures;
      aggregatedByTool[tool].totalDuration_ms += stats.totalDuration_ms;
    }
  }

  const byTool = Object.entries(aggregatedByTool)
    .map(([tool, stats]) => ({
      tool,
      calls: stats.calls,
      failures: stats.failures,
      failureRate: stats.calls > 0 ? Math.round((stats.failures / stats.calls) * 1000) / 10 : 0,
      avgDuration_ms: stats.calls > 0 ? Math.round(stats.totalDuration_ms / stats.calls) : 0,
      totalDuration_ms: stats.totalDuration_ms,
    }))
    .sort((a, b) => b.calls - a.calls);

  const slowestTools = [...byTool]
    .filter(t => t.calls >= 3) // Only include tools with enough samples
    .sort((a, b) => b.avgDuration_ms - a.avgDuration_ms)
    .slice(0, topN)
    .map(t => ({ tool: t.tool, avgDuration_ms: t.avgDuration_ms }));

  const failingTools = byTool
    .filter(t => t.failures > 0)
    .sort((a, b) => b.failureRate - a.failureRate)
    .slice(0, topN)
    .map(t => ({ tool: t.tool, failureRate: t.failureRate, failures: t.failures }));

  return {
    totalCalls,
    totalFailures,
    failureRate: totalCalls > 0 ? Math.round((totalFailures / totalCalls) * 1000) / 10 : 0,
    byTool,
    slowestTools,
    failingTools,
  };
}

// --- Error Pattern Normalization ---

/**
 * Normalize error message for grouping similar errors
 * Removes UUIDs, timestamps, file paths, and other variable content
 */
export function normalizeErrorPattern(error: string): string {
  return error
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    // Remove hex hashes (0x...)
    .replace(/0x[0-9a-f]{8,}/gi, '<HASH>')
    // Remove timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '<TIMESTAMP>')
    // Remove file paths
    .replace(/\/[^\s:]+\.(ts|js|json|md)/g, '<PATH>')
    // Remove line/column numbers
    .replace(/:\d+:\d+/g, ':<LINE>')
    // Remove numeric values in common patterns
    .replace(/timeout after \d+/gi, 'timeout after <N>')
    .replace(/attempt \d+/gi, 'attempt <N>')
    .replace(/\d+ ms/g, '<N> ms')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Aggregate errors by normalized pattern
 */
export function aggregateErrorsByPattern(
  errors: ErrorSummary[],
  topN: number = 10
): Array<{ pattern: string; count: number; phase: string; requests: string[] }> {
  const patternMap = new Map<string, {
    phase: string;
    requests: Set<string>;
    originalError: string;
  }>();

  for (const error of errors) {
    const pattern = normalizeErrorPattern(error.error);

    if (!patternMap.has(pattern)) {
      patternMap.set(pattern, {
        phase: error.phase,
        requests: new Set(),
        originalError: error.error,
      });
    }

    patternMap.get(pattern)!.requests.add(error.requestId);
  }

  // Convert to array and sort by count
  const results = Array.from(patternMap.entries())
    .map(([pattern, data]) => ({
      pattern,
      count: data.requests.size,
      phase: data.phase,
      requests: Array.from(data.requests),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  return results;
}

// --- Depth Calculation ---

/**
 * Compute depth of a request in the hierarchy
 * Root is depth 0, direct children are depth 1, etc.
 */
export function computeDepth(
  requestMap: Map<string, { sourceRequestId?: string }>,
  requestId: string,
  rootId: string,
  maxDepth: number = 100
): number {
  if (requestId === rootId) return 0;

  let depth = 0;
  let currentId: string | undefined = requestId;
  const visited = new Set<string>();

  while (currentId && depth < maxDepth) {
    if (visited.has(currentId)) break; // Cycle detection
    visited.add(currentId);

    const request = requestMap.get(currentId);
    if (!request) break;

    if (!request.sourceRequestId) break;
    if (request.sourceRequestId === rootId) return depth + 1;

    currentId = request.sourceRequestId;
    depth++;
  }

  return depth;
}
