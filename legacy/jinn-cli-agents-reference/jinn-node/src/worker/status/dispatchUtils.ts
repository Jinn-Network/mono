/**
 * Helpers for detecting delegation tool usage in telemetry
 */

const DISPATCH_TOOL_NAMES = new Set(['dispatch_new_job', 'dispatch_existing_job']);

function getToolCalls(telemetry: any): any[] {
  if (!telemetry) {
    return [];
  }
  if (Array.isArray(telemetry.toolCalls)) {
    return telemetry.toolCalls;
  }
  if (Array.isArray(telemetry.tool_calls)) {
    return telemetry.tool_calls;
  }
  return [];
}

export function countSuccessfulDispatchCalls(telemetry: any): number {
  const toolCalls = getToolCalls(telemetry);
  // Track unique job definition IDs to avoid counting retries
  const uniqueJobDefs = new Set<string>();
  
  toolCalls.forEach(call => {
    if (!call || !call.success) {
      return;
    }

    // Check if the tool execution result was actually successful (application level)
    // MCP tools return meta.ok in the result
    const metaOk = call.result?.meta?.ok;
    // If meta.ok exists and is false, this was a failed dispatch (even if tool execution succeeded)
    if (metaOk === false) {
      return;
    }

    const toolName = typeof call.tool === 'string' ? call.tool : '';
    if (toolName && DISPATCH_TOOL_NAMES.has(toolName)) {
      // Extract job definition ID from result
      const jobDefId = call.result?.data?.jobDefinitionId || 
                       call.result?.data?.id ||
                       call.result?.jobDefinitionId;
      if (jobDefId) {
        uniqueJobDefs.add(jobDefId);
      }
      // Do NOT count unknown IDs as successful dispatches
    }
  });
  
  return uniqueJobDefs.size;
}

export function didDispatchChild(telemetry: any): boolean {
  return countSuccessfulDispatchCalls(telemetry) > 0;
}

