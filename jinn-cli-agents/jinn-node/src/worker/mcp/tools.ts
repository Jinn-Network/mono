/**
 * MCP tools: helper utilities for MCP tool calls
 */

import { setJobContext, clearJobContext, snapshotJobContext, restoreJobContext } from '../metadata/jobContext.js';

/**
 * Execute MCP tool call with job context
 */
export async function withJobContext<T>(
  context: {
    requestId?: string;
    mechAddress?: string;
    jobDefinitionId?: string;
    baseBranch?: string;
    parentRequestId?: string;
    branchName?: string;
    workstreamId?: string;
    ventureId?: string;
  },
  fn: () => Promise<T>
): Promise<T> {
  const prevContext = snapshotJobContext();

  try {
    setJobContext(context);
    return await fn();
  } finally {
    restoreJobContext(prevContext);
  }
}

