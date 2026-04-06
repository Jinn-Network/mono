/**
 * Shared utilities for MCP inspection tools
 *
 * Re-exports types and functions from scripts/shared/workstream-utils.ts
 * with MCP-compatible adaptations (no console output, configurable timeouts)
 */

// Re-export all types from workstream-utils (local package path)
export type {
  ErrorSummary,
  GitOperationSummary,
  DispatchInfo,
  DispatchType,
  TokenMetrics,
  InvariantMetrics,
  TimingMetrics,
  AggregatedTimingMetrics,
  AggregatedToolMetrics,
  FailedToolCall,
  WorkerTelemetryLog,
  WorkerTelemetryEvent,
  ToolMetrics,
} from '../../../../shared/workstream-utils.js';

// Re-export pure functions that don't have side effects
export {
  extractErrorsFromTelemetry,
  extractGitOpsFromTelemetry,
  extractTimingMetrics,
  extractTokenMetrics,
  extractInvariantMetrics,
  extractFailedToolCalls,
  extractToolMetricsFromTelemetry,
  detectDispatchType,
  parseDispatchMessage,
  normalizeErrorPattern,
  aggregateErrorsByPattern,
  aggregateTimingMetrics,
  aggregateToolMetrics,
  computeDepth,
} from '../../../../shared/workstream-utils.js';

import { mcpLogger } from '../../../../logging/index.js';

// --- MCP-adapted IPFS fetch ---

const IPFS_GATEWAY_URL = config.services.ipfsGatewayUrl;
const DEFAULT_TIMEOUT_MS = 7000;

/**
 * Fetch IPFS content with MCP-compatible error handling (no console output)
 */
export async function fetchIpfsContentMcp(
  cid: string,
  requestIdForDelivery?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<any> {
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
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      mcpLogger.debug({ url, status: response.status }, 'IPFS fetch failed');
      return null;
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (e: any) {
    mcpLogger.debug({ url, error: e?.message }, 'IPFS fetch error');
    return null;
  }
}

// --- MCP Response Helpers ---

export interface McpResponse<T = any> {
  content: Array<{ type: 'text'; text: string }>;
}

export interface McpResponseMeta {
  ok: boolean;
  code?: string;
  message?: string;
  warnings?: string[];
  has_more?: boolean;
  next_cursor?: string;
}

/**
 * Build a successful MCP response
 */
export function mcpSuccess<T>(data: T, meta?: Partial<McpResponseMeta>): McpResponse<T> {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        data,
        meta: { ok: true, ...meta }
      })
    }]
  };
}

/**
 * Build an error MCP response
 */
export function mcpError(
  code: string,
  message: string,
  data: any = null
): McpResponse {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        data,
        meta: { ok: false, code, message }
      })
    }]
  };
}

/**
 * Build a validation error response
 */
export function mcpValidationError(message: string): McpResponse {
  return mcpError('VALIDATION_ERROR', message);
}

/**
 * Build a not found error response
 */
export function mcpNotFound(entityType: string, id: string): McpResponse {
  return mcpError('NOT_FOUND', `${entityType} not found: ${id}`);
}

/**
 * Build an execution error response
 */
export function mcpExecutionError(message: string): McpResponse {
  return mcpError('EXECUTION_ERROR', message);
}

// --- GraphQL Helper ---

import { config } from '../../../../config/index.js';

/**
 * Execute a GraphQL query against Ponder
 */
export async function queryPonder<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<{ data: T | null; error?: string }> {
  const url = config.services.ponderUrl;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      return { data: null, error: `GraphQL request failed: ${res.status}` };
    }

    const json = await res.json();

    if (json.errors && json.errors.length > 0) {
      return { data: null, error: json.errors[0].message };
    }

    return { data: json.data as T };
  } catch (e: any) {
    return { data: null, error: e?.message || String(e) };
  }
}
