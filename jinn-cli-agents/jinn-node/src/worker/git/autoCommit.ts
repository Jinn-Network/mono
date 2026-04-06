/**
 * Auto-commit functionality: staging and committing changes with generated messages
 */

import { workerLogger } from '../../logging/index.js';
import { getRepoRoot } from '../../shared/repo_utils.js';
import type { CodeMetadata } from '../../agent/shared/code_metadata.js';
import { GIT_STATUS_TIMEOUT_MS, GIT_COMMIT_TIMEOUT_MS } from '../constants.js';
import { serializeError } from '../logging/errors.js';
import { hasUncommittedChanges, stageAllChanges, getGitStatus } from './workingTree.js';
import type { FinalStatus, ExecutionSummaryDetails } from '../types.js';

/**
 * Derive commit message from execution summary and final status
 */
export function deriveCommitMessage(
  summary: ExecutionSummaryDetails | null,
  finalStatus: FinalStatus | null,
  fallback: { jobId: string; jobDefinitionId?: string | null }
): string {
  const fallbackLabel = fallback.jobDefinitionId
    ? `[Job ${fallback.jobDefinitionId}] auto-commit`
    : `[Request ${fallback.jobId}] auto-commit`;

  // First try to extract from execution summary
  let candidate: string | null = null;
  if (summary) {
    for (const line of summary.lines) {
      const cleaned = line.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim();
      if (cleaned) {
        candidate = cleaned;
        break;
      }
    }
  }

  const statusMessage = finalStatus?.message?.trim();
  const isGenericStatus = statusMessage
    ? statusMessage.toLowerCase() === 'job completed direct work'
    : false;

  let message = candidate
    || (statusMessage && !isGenericStatus ? statusMessage : fallbackLabel);

  message = message.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!message) {
    message = fallbackLabel;
  }
  if (message.length > 72) {
    message = `${message.slice(0, 69).trimEnd()}...`;
  }
  return message;
}

/**
 * Extract execution summary from agent output
 */
export function extractExecutionSummary(output: string): ExecutionSummaryDetails | null {
  if (!output || typeof output !== 'string') return null;

  const normalized = output.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let headingIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    // Strip markdown heading markers (#, ##, ###, etc.) and asterisks, then normalize
    const normalizedHeading = trimmed.replace(/^#+\s*/, '').replace(/\*/g, '').toLowerCase();
    if (normalizedHeading.startsWith('execution summary')) {
      headingIndex = i;
      break;
    }
  }

  if (headingIndex === -1) return null;

  const collected: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      if (collected.length > 0) break;
      continue;
    }

    if (/^FinalStatus:/i.test(trimmed)) break;
    if (/^##+ /.test(trimmed)) break;
    if (/^\*\*[A-Z][^*]*\*\*:/.test(trimmed) && !trimmed.startsWith('-')) break;

    collected.push(trimmed);
  }

  if (collected.length === 0) return null;

  return {
    heading: lines[headingIndex].trim(),
    lines: collected,
    text: [lines[headingIndex].trim(), ...collected].join('\n')
  };
}

/**
 * Format execution summary for PR body
 */
export function formatSummaryForPr(summary: ExecutionSummaryDetails | null): string | null {
  if (!summary) return null;
  const bulletLines = summary.lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const cleaned = line.replace(/^\s*[-*]\s*/, '').trim();
      return `- ${cleaned}`;
    });

  if (bulletLines.length === 0) return null;
  return ['---', '### Execution Summary', ...bulletLines].join('\n');
}

/**
 * Auto-commit pending changes if any exist
 * Returns object with commit info if a commit was made, null if no changes were present
 */
export async function autoCommitIfNeeded(
  codeMetadata: CodeMetadata, 
  commitMessage: string
): Promise<{ commitHash: string; filesChanged: number } | null> {
  if (!commitMessage || !commitMessage.trim()) {
    throw new Error('Cannot auto-commit changes: commit message is empty');
  }

  const repoRoot = getRepoRoot(codeMetadata);
  const { execFileSync } = await import('node:child_process');

  try {
    // Check if there are uncommitted changes
    const hasChanges = await hasUncommittedChanges(codeMetadata);
    if (!hasChanges) {
      workerLogger.debug({ repoRoot }, 'No pending changes detected before push');
      return null;
    }

    // Count files changed before staging
    const statusOutput = await getGitStatus(codeMetadata);
    const filesChanged = statusOutput.split('\n').filter(line => line.trim().length > 0).length;

    workerLogger.info({ repoRoot }, 'Auto-committing pending changes before push');
    
    // Stage all changes
    await stageAllChanges(codeMetadata);
    
    // Commit with message
    execFileSync('git', ['commit', '-m', commitMessage], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: GIT_COMMIT_TIMEOUT_MS,
      env: process.env as Record<string, string>,
    });
    
    // Get commit hash
    const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: GIT_COMMIT_TIMEOUT_MS,
      env: process.env as Record<string, string>,
    }).trim();
    
    workerLogger.info({ repoRoot, commitMessage, commitHash, filesChanged }, 'Auto-commit completed');
    return { commitHash, filesChanged };
  } catch (error: any) {
    workerLogger.error({
      repoRoot,
      error: serializeError(error)
    }, 'Auto-commit failed');
    throw error instanceof Error ? error : new Error(serializeError(error));
  }
}

