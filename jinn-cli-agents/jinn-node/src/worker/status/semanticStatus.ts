/**
 * Semantic status extraction from agent output
 * 
 * Detects when an agent reports a semantic failure (e.g., "Status: FAILED")
 * even though the worker execution completed successfully.
 */

export interface SemanticFailure {
    message: string;
    reason: 'explicit_status_failed' | 'inability_statement';
}

/**
 * Extract semantic failure indicators from agent output.
 * 
 * Returns null if the agent did not report a failure.
 * Returns a SemanticFailure object if the agent explicitly reported FAILED status
 * or stated inability to complete the task.
 */
export function extractSemanticFailure(output: string): SemanticFailure | null {
    if (!output || typeof output !== 'string') {
        return null;
    }

    // Pattern 1: "Status: FAILED" or "**Status:** FAILED" (common in agent output)
    const statusMatch = output.match(/\*?\*?Status\*?\*?:\s*FAILED/i);
    if (statusMatch) {
        // Try to extract reason from output
        const reasonMatch = output.match(/(?:Reason|Explanation|Failure)[:\s]+([^\n]+)/i);
        return {
            message: reasonMatch?.[1]?.trim() || 'Agent reported FAILED status',
            reason: 'explicit_status_failed',
        };
    }

    // Pattern 2: Agent explicitly says it couldn't complete
    // Match: "I cannot complete", "I could not complete", "I am unable to complete"
    const inabilityMatch = output.match(/I (?:cannot|could not|am unable to) complete[^\n]*/i);
    if (inabilityMatch) {
        return {
            message: inabilityMatch[0].trim(),
            reason: 'inability_statement',
        };
    }

    return null;
}
