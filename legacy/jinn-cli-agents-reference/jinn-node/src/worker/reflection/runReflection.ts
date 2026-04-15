/**
 * Reflection phase: trigger reflection agent, handle failures
 */

import { Agent } from '../../agent/agent.js';
import { workerLogger } from '../../logging/index.js';
import { serializeError } from '../logging/errors.js';
import type { FinalStatus, AgentExecutionResult, IpfsMetadata, UnclaimedRequest, ReflectionResult } from '../types.js';

/**
 * Build reflection prompt based on job status
 */
function buildReflectionPrompt(
  metadata: IpfsMetadata,
  requestId: string,
  finalStatus: FinalStatus,
  result: AgentExecutionResult,
  error?: any
): string {
  const outputPreview = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
  
  // Treat DELEGATING and WAITING as successful/active states, not failures
  if (finalStatus.status === 'COMPLETED' || finalStatus.status === 'DELEGATING' || finalStatus.status === 'WAITING') {
    return `You have just completed a job step. Here is a summary:

**Job:** ${metadata?.jobName || requestId}
**Status:** ${finalStatus.status}
**Message:** ${finalStatus.message}
**Output:** ${outputPreview.substring(0, 500)}${outputPreview.length > 500 ? '...' : ''}
**Telemetry:**
- Duration: ${result.telemetry?.duration || 0}ms
- Tokens: ${result.telemetry?.totalTokens || 0}
- Tools Called: ${result.telemetry?.toolCalls?.length || 0}

**Reflection Task:**
Review the execution. Did you discover any strategies, solutions, workarounds, or insights that would be valuable for future jobs?

If the status is DELEGATING or WAITING, consider reflecting on the decomposition strategy or the delegation process itself.

If yes, you MUST use the \`create_artifact\` tool to save a memory.
Parameters:
- \`type\`: "MEMORY" (required)
- \`name\`: A short, descriptive title for the memory.
- \`topic\`: A category (e.g., "optimization", "bug-fix", "best-practice", "delegation-strategy").
- \`tags\`: An array of string tags. You MUST include tags derived from the Job Name and key technologies used.
- \`content\`: The detailed insight/learning.

Example:
create_artifact({
  name: "Effective Work Decomposition",
  type: "MEMORY",
  topic: "delegation-strategy",
  tags: ["delegation", "planning", "olas"],
  content: "Breaking down the research task into data gathering and analysis steps proved effective..."
})

If nothing notable was learned, simply respond "No significant learnings."`;
  } else {
    return `A job has failed. Here is a summary:

**Job:** ${metadata?.jobName || requestId}
**Status:** ${finalStatus.status}
**Error:** ${error?.message || 'Unknown error'}
**Output (if any):** ${outputPreview ? outputPreview.substring(0, 500) : 'No output'}${outputPreview && outputPreview.length > 500 ? '...' : ''}
**Telemetry:**
- Duration: ${result.telemetry?.duration || 0}ms
- Tokens: ${result.telemetry?.totalTokens || 0}
- Tools Called: ${result.telemetry?.toolCalls?.length || 0}

**Reflection Task:**
Review the failure. Were there any lessons learned, edge cases discovered, or patterns that future jobs should avoid?

If yes, you MUST use the \`create_artifact\` tool to save a memory.
Parameters:
- \`type\`: "MEMORY" (required)
- \`name\`: A short, descriptive title for the memory.
- \`topic\`: "failure-analysis"
- \`tags\`: An array of string tags. You MUST include "failure" and tags derived from the error (e.g., "timeout", "validation-error").
- \`content\`: The detailed failure analysis and prevention strategy.

Example:
create_artifact({
  name: "Timeout Handling Strategy",
  type: "MEMORY",
  topic: "failure-analysis",
  tags: ["failure", "timeout", "network"],
  content: "..."
})

If nothing notable was learned, simply respond "No significant learnings."`;
  }
}

/**
 * Run reflection phase if status warrants it
 * Returns null if reflection is skipped or fails
 */
export async function runReflection(
  request: UnclaimedRequest,
  metadata: IpfsMetadata,
  finalStatus: FinalStatus | null,
  result: AgentExecutionResult,
  error?: any
): Promise<ReflectionResult | null> {
  // Only run reflection if we have a final status
  if (!finalStatus) {
    return null;
  }

  try {
    const reflectionAgent = new Agent(
      'gemini-2.5-flash', // Always use flash for faster reflection
      ['create_artifact'],
      {
        jobId: `${request.id}-reflection`,
        jobDefinitionId: metadata?.jobDefinitionId || null,
        jobName: metadata?.jobName || 'job',
        phase: 'reflection',
        projectRunId: null,
        sourceEventId: null,
        projectDefinitionId: null,
      },
      null, // No codeWorkspace for reflection agents
    );

    const prompt = buildReflectionPrompt(metadata, request.id, finalStatus, result, error);
    const reflectionResult = await reflectionAgent.run(prompt);

    workerLogger.info({ requestId: request.id }, 'Reflection step completed');

    return {
      output: reflectionResult.output || '',
      telemetry: reflectionResult.telemetry || {},
    };
  } catch (reflectionError: any) {
    workerLogger.warn(
      { requestId: request.id, error: serializeError(reflectionError) },
      'Reflection step failed (non-critical)'
    );
    return null;
  }
}
