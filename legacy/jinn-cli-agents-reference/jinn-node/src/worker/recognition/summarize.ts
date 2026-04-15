/**
 * AI-powered summarization of workstream progress
 * 
 * This module uses a lightweight AI agent to generate a concise, relevant
 * summary of completed work in a workstream, tailored to the current job's objective.
 */

import { workerLogger } from '../../logging/index.js';
import { Agent } from '../../agent/agent.js';
import { serializeError } from '../logging/errors.js';
import type { WorkstreamJob } from './progressCheckpoint.js';

/**
 * Summarize workstream progress using AI (gemini-2.5-flash)
 * 
 * @param workstreamJobs - Array of completed jobs with their summaries
 * @param currentJobObjective - The objective/goal of the current job
 * @param currentJobName - Name of the current job
 * @param requestId - Current request ID (for logging)
 * @returns AI-generated summary markdown, or null on failure
 */
export async function summarizeWorkstreamProgress(
  workstreamJobs: WorkstreamJob[],
  currentJobObjective: string,
  currentJobName: string | undefined,
  requestId: string
): Promise<string | null> {
  if (workstreamJobs.length === 0) {
    return null;
  }

  try {
    workerLogger.info({
      requestId,
      jobCount: workstreamJobs.length,
      jobsWithSummaries: workstreamJobs.filter(j => j.deliverySummary).length,
    }, 'Starting AI summarization of workstream progress');

    // Build the context for the summarization agent
    const jobSummariesText = workstreamJobs
      .map((job, idx) => {
        const jobTitle = job.jobName || `Job ${job.requestId.slice(0, 8)}`;
        const timestamp = new Date(parseInt(job.blockTimestamp) * 1000).toISOString();
        const summary = job.deliverySummary || '(No summary available)';
        
        return `### ${idx + 1}. ${jobTitle}\n**Request ID:** ${job.requestId}\n**Completed:** ${timestamp}\n**Summary:**\n${summary}\n`;
      })
      .join('\n---\n\n');

    const prompt = `You are a progress summarization agent. Your task is to analyze completed work in a venture workstream and create a concise summary of accomplishments that helps the next job avoid duplicating work.

## Current Job Context

**Job Name:** ${currentJobName || 'Unnamed Job'}
**Objective:** ${currentJobObjective}

## Completed Work in Workstream

The following jobs have been completed in this workstream (most recent first):

${jobSummariesText}

---

## Your Task

Create a concise summary (300-500 words) focusing purely on **what has been achieved**. Your goal is to help the next agent understand what work already exists, so they don't duplicate efforts.

1. **Highlight concrete deliverables** - What artifacts, child jobs, or code changes were created?
2. **Note successful approaches** - What strategies or patterns worked well?
3. **Surface relevant outputs** - What from prior work is most relevant to "${currentJobObjective}"?
4. **List available building blocks** - What can the next agent leverage or build upon?

## Output Format

Structure your summary as markdown with these sections:

### Workstream Progress Summary

[Brief overview in 2-3 sentences focusing on what was successfully produced]

### Key Accomplishments

- [Concrete deliverable 1 - e.g., "Created artifact 'Analysis Report' (CID: bafkrei...)"]
- [Concrete deliverable 2 - e.g., "Dispatched child job for data validation (Job ID: 4149b6a8...)"]
- [etc.]

### Relevant Context for Current Job

[Paragraph explaining what outputs from prior work are most relevant to "${currentJobObjective}"]

### Building Blocks Available

- [Artifacts, components, or decisions that can be leveraged - list CIDs, job IDs, file paths]

---

**CRITICAL GUIDANCE:** 
- **Report only facts**: Focus on concrete deliverables (artifacts created, jobs dispatched, code committed). 
- **Omit failure analysis**: If a job failed, skip it or note only what it produced before failing. Do NOT describe errors, tool failures, or why things didn't work.
- **No speculation about state**: Never claim resources are "available", "missing", "working", or "broken". Just list what was created (e.g., "Artifact 'Data' (CID: bafkrei...)" not "Artifact content is missing from IPFS").
- **Examples of GOOD summaries**:
  - "Performed web research and created consolidated data artifact (CID: bafkrei...)"
  - "Dispatched analysis job (Job Def ID: 4149b6a8-4801-4ab2-bfa1-94e730874362)"
  - "Gathered data on 5 DeFi protocols: Uniswap, Aave, Lido, MakerDAO, Curve"
- **Examples of BAD summaries**:
  - "Tool call failed with error X" ❌
  - "Artifact content was not found on IPFS" ❌
  - "Unable to proceed due to missing data" ❌
  - "Persistent CODE_METADATA_REPO_ROOT error blocked progress" ❌

Your summary enables the next agent to verify current state with their own tools, not inherit assumptions from past failures.`;

    const summarizationAgent = new Agent(
      'gemini-2.5-flash',  // Always use flash for summarization
      [],  // No tools needed
      {
        jobId: `${requestId}-progress-summarization`,
        jobDefinitionId: null,
        jobName: currentJobName || 'job',
        phase: 'progress-summarization',
        projectRunId: null,
        sourceEventId: null,
        projectDefinitionId: null,
      },
      null, // No codeWorkspace for summarization agents
    );

    const agentResult = await summarizationAgent.run(prompt);
    
    if (!agentResult?.output) {
      workerLogger.warn({ requestId }, 'Summarization agent produced no output');
      return null;
    }

    const summary = agentResult.output.trim();
    
    workerLogger.info({
      requestId,
      summaryLength: summary.length,
      tokensUsed: agentResult.telemetry?.totalTokens || 0,
    }, 'AI summarization completed successfully');

    return summary;
  } catch (error: any) {
    workerLogger.error({
      requestId,
      error: serializeError(error),
    }, 'Failed to generate AI summary of workstream progress');
    return null;
  }
}

