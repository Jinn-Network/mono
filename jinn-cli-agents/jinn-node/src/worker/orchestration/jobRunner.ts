/**
 * Job runner: orchestrates a single job execution through all phases
 * 
 * This module orchestrates the complete job lifecycle:
 * - Fetch metadata/IPFS payload
 * - Run recognition phase
 * - Execute agent
 * - Run reflection
 * - Infer final status
 * - Git operations (branch, commit, push, PR)
 * - Delivery/telemetry storage
 * - Parent dispatch decisions
 */

import { workerLogger } from '../../logging/index.js';
import { execFileSync } from 'child_process';
import { assertValidBranchName } from '../../shared/git-validation.js';
import { WorkerTelemetryService } from '../worker_telemetry.js';
import { serializeError } from '../logging/errors.js';
import { snapshotEnvironment, restoreEnvironment } from './env.js';
import { fetchIpfsMetadata } from '../metadata/fetchIpfsMetadata.js';
import { ensureRepoCloned } from '../git/repoManager.js';
import { ensureGitignore, ensureBeadsInit, commitRepoSetup } from '../git/repoSetup.js';
import { checkoutJobBranch, syncWithBranch } from '../git/branch.js';
import { pushJobBranch } from '../git/push.js';
import { generateBranchUrl, formatSummaryForPr, createBranchArtifact } from '../git/pr.js';
import { autoCommitIfNeeded, deriveCommitMessage, extractExecutionSummary } from '../git/autoCommit.js';
import { runRecognitionPhase } from '../recognition/runRecognition.js';
// Recognition augmentation now handled by BlueprintBuilder's RecognitionProvider
import { runAgentForRequest, consolidateArtifacts, parseTelemetry, extractOutput, mergeTelemetry, extractArtifactsFromError } from '../execution/index.js';
import { computeMeasurementCoverage, type MeasurementCoverage } from '../execution/measurementCoverage.js';
import { runReflection } from '../reflection/runReflection.js';
import { inferJobStatus, dispatchParentIfNeeded, dispatchForLoopRecovery, dispatchForTimeoutRecovery, extractSemanticFailure } from '../status/index.js';
import { storeOnchainReport } from '../delivery/report.js';
import { deliverViaSafeTransaction } from '../delivery/transaction.js';
import { createSituationArtifactForRequest } from '../situation_artifact.js';
import { createArtifact as apiCreateArtifact } from '../control_api_client.js';
import { safeParseToolResponse } from '../tool_utils.js';
import { getJinnWorkspaceDir, extractRepoName, getRepoRoot, normalizeSshUrl } from '../../shared/repo_utils.js';
import { assertValidJinnJobEnvMap } from '../../shared/job-env.js';
import { extractMemoryArtifacts } from '../reflection/memoryArtifacts.js';
import { DEFAULT_WORKER_MODEL, normalizeGeminiModel, validateModelAllowed } from '../../shared/gemini-models.js';
import type { UnclaimedRequest, IpfsMetadata, AgentExecutionResult, FinalStatus, ExecutionSummaryDetails, RecognitionPhaseResult, ReflectionResult, AdditionalContext } from '../types.js';
import { getDependencyBranchInfo } from '../mech_worker.js';
import { config } from '../../config/index.js';
import { checkGeminiQuotaAvailability, isGeminiQuotaError, markCredentialExhausted } from '../llm/geminiQuota.js';

const DEFAULT_BASE_BRANCH = config.git.defaultBaseBranch;
const MAX_GEMINI_EXECUTION_ATTEMPTS = 3;

/**
 * Process a single job request
 * 
 * This is the main orchestration function that runs a job through all phases.
 * It handles all error cases and ensures proper cleanup.
 */
export async function processOnce(
  target: UnclaimedRequest,
  workerAddress: string
): Promise<void> {
  let result: AgentExecutionResult = { output: '', telemetry: {} };
  let error: any = null;
  let metadata: IpfsMetadata | null = null;
  let recognition: RecognitionPhaseResult | null = null;
  let reflection: ReflectionResult | null = null;
  let finalStatus: FinalStatus | null = null;
  let measurementCoverage: MeasurementCoverage | null = null;
  let executionSummary: ExecutionSummaryDetails | null = null;
  let initializationFailed = false;

  const envSnapshot = snapshotEnvironment();
  const telemetry = new WorkerTelemetryService(target.id);
  const contextPhasesEnabled = config.blueprint.enableContextPhases;

  try {
    // Initialize: fetch metadata and set up repo
    telemetry.startPhase('initialization');
    try {
      metadata = await fetchIpfsMetadata(target.ipfsHash!);
      if (!metadata) {
        throw new Error(
          `Cannot execute job: IPFS metadata fetch failed for hash ${target.ipfsHash}. ` +
          `Without metadata, the worker has no prompt or configuration. Skipping.`
        );
      }
      // Use model from job metadata if available, otherwise fall back to default
      const normalized = normalizeGeminiModel(metadata.model, DEFAULT_WORKER_MODEL);
      if (normalized.changed) {
        workerLogger.info({ requested: normalized.requested, normalized: normalized.normalized }, 'Normalized Gemini model');
      }

      // Check for deprecated models and fallback to default
      const modelValidation = validateModelAllowed(normalized.normalized);
      if (!modelValidation.ok) {
        workerLogger.warn(
          { deprecatedModel: normalized.normalized, fallback: DEFAULT_WORKER_MODEL, reason: modelValidation.reason },
          'Deprecated model detected, falling back to default'
        );
        metadata.model = DEFAULT_WORKER_MODEL;
      } else {
        metadata.model = normalized.normalized;
      }

      telemetry.logCheckpoint('initialization', 'metadata_fetched', {
        hasJobName: !!metadata?.jobName,
        hasBlueprint: !!metadata?.blueprint,
        hasCodeMetadata: !!metadata?.codeMetadata,
      });

      const resolvedWorkstreamId = metadata?.workstreamId || target.workstreamId || target.id;
      if (metadata) {
        metadata.workstreamId = resolvedWorkstreamId;
      }

      workerLogger.info({
        jobName: metadata?.jobName,
        requestId: target.id,
        workstreamId: resolvedWorkstreamId
      }, 'Processing request');

      // Inject environment variables from additionalContext.env.
      // Invalid keys/values fail fast to avoid processing tampered payloads.
      if (metadata?.additionalContext?.env) {
        const validatedEnv = assertValidJinnJobEnvMap(
          metadata.additionalContext.env,
          'metadata.additionalContext.env',
        );

        for (const [key, value] of Object.entries(validatedEnv)) {
          process.env[key] = value;
          workerLogger.info({ key }, 'Injected job environment variable from additionalContext.env');
        }

        // Store injected vars as JSON for child job inheritance via dispatch_new_job.
        if (Object.keys(validatedEnv).length > 0) {
          process.env.JINN_CTX_INHERITED_ENV = JSON.stringify(validatedEnv);
        } else {
          delete process.env.JINN_CTX_INHERITED_ENV;
        }
      }

      // Bootstrap workspace from additionalContext.workspaceRepo (root jobs only)
      // If workspaceRepo is provided AND no codeMetadata exists, clone the specified repo
      // Children inherit codeMetadata from parent, so this only applies to root launches
      if (metadata?.additionalContext?.workspaceRepo?.url && !metadata.codeMetadata) {
        const { url: repoUrl, branch } = metadata.additionalContext.workspaceRepo;
        const repoName = extractRepoName(repoUrl);
        if (repoName) {
          const workspaceDir = config.git.workspaceDir;
          const repoRoot = `${workspaceDir}/${repoName}`;

          workerLogger.info({ repoUrl, repoRoot, branch }, 'Bootstrapping workspace from additionalContext.workspaceRepo');

          const cloneResult = await ensureRepoCloned(repoUrl, repoRoot);
          process.env.CODE_METADATA_REPO_ROOT = repoRoot;

          telemetry.logCheckpoint('initialization', 'workspace_repo_bootstrap', {
            repoUrl,
            repoRoot,
            branch: branch || 'default',
            wasAlreadyCloned: cloneResult.wasAlreadyCloned,
          });
        }
      }

      // Handle code metadata if present (artifact-only jobs may not have it)
      if (metadata?.codeMetadata) {
        process.env.JINN_CTX_BASE_BRANCH = metadata.codeMetadata.branch?.name ||
          metadata.codeMetadata.baseBranch ||
          DEFAULT_BASE_BRANCH;

        const rawRemoteUrl = metadata.codeMetadata?.repo?.remoteUrl;
        const remoteUrl = rawRemoteUrl ? normalizeSshUrl(rawRemoteUrl) : undefined;
        if (remoteUrl) {
          if (remoteUrl !== rawRemoteUrl) {
            metadata.codeMetadata.repo = {
              ...(metadata.codeMetadata.repo || {}),
              remoteUrl,
            };
          }

          let repoRoot = process.env.CODE_METADATA_REPO_ROOT;

          if (repoRoot) {
            workerLogger.info({ repoRoot, remoteUrl }, 'Using existing CODE_METADATA_REPO_ROOT');
          } else {
            const repoName = extractRepoName(remoteUrl);
            if (repoName) {
              const workspaceDir = config.git.workspaceDir;
              repoRoot = `${workspaceDir}/${repoName}`;
              process.env.CODE_METADATA_REPO_ROOT = repoRoot;
              workerLogger.info({ repoRoot, remoteUrl }, 'Set CODE_METADATA_REPO_ROOT for job');
            }
          }

          if (repoRoot) {
            const cloneResult = await ensureRepoCloned(remoteUrl, repoRoot);
            telemetry.logCheckpoint('initialization', 'repo_clone', {
              remoteUrl,
              targetPath: repoRoot,
              wasAlreadyCloned: cloneResult.wasAlreadyCloned,
              fetchPerformed: cloneResult.fetchPerformed,
            });
          }
        }

        const checkoutResult = await checkoutJobBranch(metadata.codeMetadata);
        telemetry.logCheckpoint('initialization', 'branch_checkout', {
          branchName: checkoutResult.branchName,
          wasNewlyCreated: checkoutResult.wasNewlyCreated,
          checkoutMethod: checkoutResult.checkoutMethod,
          baseBranch: metadata.codeMetadata.baseBranch || DEFAULT_BASE_BRANCH,
          ...(checkoutResult.stashedChanges ? { stashedChanges: checkoutResult.stashedChanges } : {}),
        });

        // If uncommitted changes were stashed, store them in additionalContext so the agent is informed
        // This helps the agent understand that some files from a previous failed job were set aside
        if (checkoutResult.stashedChanges && checkoutResult.stashedChanges.length > 0) {
          if (!metadata.additionalContext) {
            metadata.additionalContext = {} as AdditionalContext;
          }
          metadata.additionalContext.stashedChanges = checkoutResult.stashedChanges;

          workerLogger.warn({
            requestId: target.id,
            stashedFiles: checkoutResult.stashedChanges,
          }, 'Uncommitted changes from previous job were stashed before checkout');
        }

        // Now that we're on the job branch, ensure .gitignore and beads are set up
        // This happens AFTER checkout so .gitignore is committed to the job branch
        // (not main), preventing divergent commits when child branches don't inherit from main
        const setupRepoRoot = getRepoRoot(metadata.codeMetadata);
        if (setupRepoRoot) {
          ensureGitignore(setupRepoRoot);
          if (config.blueprint.enableBeads) {
            await ensureBeadsInit(setupRepoRoot);
          }
          await commitRepoSetup(setupRepoRoot);
        }

        // Merge dependency branches into this job's branch
        // This ensures the child job sees work from its dependencies
        if (target.dependencies && target.dependencies.length > 0) {
          const repoRoot = getRepoRoot(metadata.codeMetadata);
          const mergeConflicts: Array<{ branch: string; files: string[] }> = [];

          for (const depJobDefId of target.dependencies) {
            const branchInfo = await getDependencyBranchInfo(depJobDefId);
            if (branchInfo?.branchName) {
              workerLogger.info({
                requestId: target.id,
                dependencyJobDefId: depJobDefId,
                dependencyBranch: branchInfo.branchName,
              }, 'Syncing with dependency branch');

              const syncResult = await syncWithBranch(repoRoot, branchInfo.branchName);

              telemetry.logCheckpoint('initialization', 'dependency_sync', {
                dependencyJobDefId: depJobDefId,
                sourceBranch: syncResult.sourceBranch,
                synced: syncResult.synced,
                hasConflicts: syncResult.hasConflicts,
                conflictingFiles: syncResult.conflictingFiles,
                ...(syncResult.stashedChanges ? { stashedChanges: syncResult.stashedChanges } : {}),
              });

              // If uncommitted changes were stashed during merge, inform the agent
              if (syncResult.stashedChanges && syncResult.stashedChanges.length > 0) {
                if (!metadata.additionalContext) {
                  metadata.additionalContext = {} as AdditionalContext;
                }
                // Append to existing stashedChanges (may already have entries from checkout stash)
                const existing = metadata.additionalContext.stashedChanges || [];
                metadata.additionalContext.stashedChanges = [...existing, ...syncResult.stashedChanges];

                workerLogger.warn({
                  requestId: target.id,
                  dependencyBranch: branchInfo.branchName,
                  stashedFiles: syncResult.stashedChanges,
                }, 'Uncommitted changes were stashed before dependency merge');
              }

              if (syncResult.hasConflicts) {
                mergeConflicts.push({
                  branch: branchInfo.branchName,
                  files: syncResult.conflictingFiles,
                });

                // Commit the conflicted state so we can continue to next dependency
                // Agent will see conflict markers in committed files and must resolve them
                try {
                  assertValidBranchName(branchInfo.branchName);
                  execFileSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
                  execFileSync('git', ['commit', '-m', `WIP: Merge conflict from ${branchInfo.branchName} - agent must resolve`], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
                  workerLogger.info({
                    requestId: target.id,
                    dependency: branchInfo.branchName
                  }, 'Committed conflicted merge state to allow further dependency syncs');
                } catch (commitError) {
                  workerLogger.warn({
                    requestId: target.id,
                    dependency: branchInfo.branchName,
                    error: serializeError(commitError)
                  }, 'Failed to commit conflicted state - subsequent merges may fail');
                }
              }
            } else {
              workerLogger.debug({
                requestId: target.id,
                dependencyJobDefId: depJobDefId,
              }, 'No branch info for dependency - may be artifact-only job');
            }
          }

          // Store merge conflicts in additionalContext for assertion provider
          if (mergeConflicts.length > 0) {
            if (!metadata.additionalContext) {
              metadata.additionalContext = {} as AdditionalContext;
            }
            metadata.additionalContext.mergeConflicts = mergeConflicts;

            workerLogger.warn({
              requestId: target.id,
              conflictCount: mergeConflicts.length,
              conflicts: mergeConflicts,
            }, 'Dependency branch merge produced conflicts - agent must resolve');
          }
        }
      } else {
        workerLogger.info({ requestId: target.id }, 'No code metadata - artifact-only job');

        // VALIDATION: Warn if coding tools are enabled but no codeMetadata
        // This indicates a likely misconfiguration (e.g., x402-builder dispatching without codeMetadata)
        const CODING_TOOLS = ['write_file', 'replace', 'run_shell_command', 'process_branch'];
        const enabledTools = metadata?.enabledTools || [];
        const codingToolsEnabled = enabledTools.filter((t: string) => CODING_TOOLS.includes(t));

        if (codingToolsEnabled.length > 0) {
          workerLogger.warn({
            requestId: target.id,
            codingToolsEnabled,
            hint: 'Job has coding tools but no codeMetadata. Tools will be unavailable. Did the dispatcher forget to include codeMetadata?',
          }, 'MISCONFIGURATION: Coding tools enabled without codeMetadata');
        }
      }
    } catch (initializationError: any) {
      initializationFailed = true;
      telemetry.logError('initialization', initializationError);
      throw initializationError;
    } finally {
      telemetry.endPhase('initialization');
    }

    // Recognition phase
    telemetry.startPhase('recognition');
    try {
      if (!contextPhasesEnabled) {
        workerLogger.info({ requestId: target.id }, 'Recognition phase skipped (BLUEPRINT_ENABLE_CONTEXT_PHASES=false)');
      } else {
        recognition = await runRecognitionPhase(target.id, metadata, telemetry);
        // Recognition learnings are now handled by BlueprintBuilder's LearningInvariantProvider
        // Do NOT augment metadata.blueprint here - it must remain valid JSON for BlueprintBuilder
        metadata.recognition = recognition;
      }
    } catch (recognitionError: any) {
      telemetry.logError('recognition', recognitionError);
      workerLogger.warn({ requestId: target.id, error: serializeError(recognitionError) }, 'Recognition phase failed (continuing without learnings)');
    } finally {
      telemetry.endPhase('recognition');
    }

    // Agent execution
    telemetry.startPhase('agent_execution', {
      model: metadata?.model || DEFAULT_WORKER_MODEL,
    });
    try {
      for (let executionAttempt = 0; executionAttempt < MAX_GEMINI_EXECUTION_ATTEMPTS; executionAttempt += 1) {
        const quotaResult = await checkGeminiQuotaAvailability({
          reason: executionAttempt === 0 ? 'pre_execution' : 'execution_retry',
          requestId: target.id,
          jobName: metadata?.jobName,
          model: metadata?.model,
        });

        if (!quotaResult.available) {
          const retryAfterSeconds = quotaResult.retryAfterMs && quotaResult.retryAfterMs > 0
            ? Math.ceil(quotaResult.retryAfterMs / 1000)
            : null;
          const retryAfterMessage = retryAfterSeconds
            ? ` Retry after about ${retryAfterSeconds}s.`
            : '';
          throw new Error(`Gemini quota unavailable before execution.${retryAfterMessage}`);
        }

        try {
          result = await runAgentForRequest(target, metadata);
          break;
        } catch (agentError: any) {
          if (isGeminiQuotaError(agentError)) {
            // Feed back CLI quota error to credential cooldown so the same
            // credential isn't immediately re-selected on retry.
            if (quotaResult.selectedIndex >= 0) {
              markCredentialExhausted(quotaResult.selectedIndex);
            }
            if (executionAttempt + 1 >= MAX_GEMINI_EXECUTION_ATTEMPTS) {
              throw new Error(`Gemini quota exhausted after ${MAX_GEMINI_EXECUTION_ATTEMPTS} execution attempts`);
            }
            continue;
          }
          throw agentError;
        }
      }
      result = await consolidateArtifacts(result, target.id);

      finalStatus = await inferJobStatus({
        requestId: target.id,
        error: null,
        telemetry: result.telemetry || {},
        delegatedThisRun: result.delegated,
        metadata,
      });

      workerLogger.info({
        jobName: metadata?.jobName,
        requestId: target.id,
        status: finalStatus.status,
        message: finalStatus.message
      }, 'Execution completed - status inferred');

      // NEW: Check for semantic FAILED in agent output
      // If agent says "Status: FAILED" but inferJobStatus returned COMPLETED, override
      if (finalStatus.status === 'COMPLETED' && result.output) {
        const semanticFailed = extractSemanticFailure(result.output as string);
        if (semanticFailed) {
          finalStatus = {
            status: 'FAILED',
            message: semanticFailed.message,
          };
          workerLogger.info({
            requestId: target.id,
            reason: semanticFailed.reason,
            message: semanticFailed.message,
          }, 'Semantic FAILED status detected in agent output - overriding COMPLETED');
        }
      }

      // Compute measurement coverage for delivery payload
      measurementCoverage = computeMeasurementCoverage({
        blueprint: metadata?.blueprint,
        telemetry: result.telemetry || {},
        status: finalStatus.status,
      });
      if (measurementCoverage) {
        workerLogger.info({
          requestId: target.id,
          coverage: measurementCoverage.coveragePercent,
          measured: measurementCoverage.measuredIds,
          unmeasured: measurementCoverage.unmeasuredIds,
          delegated: measurementCoverage.delegated,
        }, 'Measurement coverage computed');
      }

      // Aggregate tool metrics
      if (result?.telemetry?.toolCalls && result.telemetry.toolCalls.length > 0) {
        telemetry.setToolMetrics(result.telemetry.toolCalls);
      }

      telemetry.logCheckpoint('agent_execution', 'completed', {
        outputLength: result?.output?.length || 0,
        inputTokens: result?.telemetry?.inputTokens,
        outputTokens: result?.telemetry?.outputTokens,
        totalTokens: result?.telemetry?.totalTokens,
        toolCalls: result?.telemetry?.toolCalls?.length || 0,
        inferredStatus: finalStatus.status,
      });
    } catch (agentError: any) {
      telemetry.logError('agent_execution', agentError);
      throw agentError;
    } finally {
      telemetry.endPhase('agent_execution');
    }
  } catch (e: any) {
    error = e;

    // Extract status and results from error telemetry if available
    if (e?.telemetry) {
      const parsed = parseTelemetry(result, e);

      const extractedOutput = extractOutput(result, e);
      if (extractedOutput) {
        result.output = result.output || extractedOutput;
      }

      result.telemetry = mergeTelemetry(result, e);

      const errorArtifacts = await extractArtifactsFromError(parsed.telemetry, target.id);
      if (errorArtifacts.length > 0 && !result.artifacts) {
        result.artifacts = errorArtifacts;
      }

      if (!finalStatus) {
        finalStatus = await inferJobStatus({
          requestId: target.id,
          error: e,
          telemetry: parsed.telemetry || result?.telemetry || {},
          delegatedThisRun: result.delegated,
          metadata,
        });
      }

      // Detect loop protection terminations (Gemini CLI or worker-level)
      // These should NOT trigger transport error recovery - they are intentional failures
      const stderrWarnings = parsed.telemetry?.raw?.stderrWarnings || '';
      const outputText = result?.output || '';
      const isLoopProtection =
        stderrWarnings.includes('unproductive loop') ||
        outputText.includes('[PROCESS TERMINATED');

      // If loop protection triggered, ensure FAILED status with helpful message
      if (isLoopProtection && finalStatus) {
        // Extract the loop detection message for a more helpful error
        const loopMatch = stderrWarnings.match(/The assistant is in a clear unproductive loop[^.]*\./);
        const loopMessage = loopMatch
          ? loopMatch[0]
          : 'Agent terminated: unproductive loop detected';

        finalStatus = {
          status: 'FAILED',
          message: loopMessage,
        };

        workerLogger.warn({
          requestId: target.id,
          jobName: metadata?.jobName,
          loopMessage,
        }, 'Job failed due to loop protection - not eligible for transport error recovery');

        // Auto-dispatch for loop recovery (if not at max attempts)
        // Extract full loop message for more context
        const fullLoopMessage = stderrWarnings.match(/The assistant is in a clear unproductive loop[^]*?(?=\n\n|$)/)?.[0] || loopMessage;
        await dispatchForLoopRecovery(metadata, target.id, fullLoopMessage, telemetry);
      }

      // Detect process timeout terminations
      const isTimeout =
        stderrWarnings.includes('Process timeout after') ||
        outputText.includes('[PROCESS TERMINATED: Process timeout');

      // If timeout triggered, ensure FAILED status and dispatch for recovery
      if (isTimeout && finalStatus) {
        const timeoutMessage = 'Agent terminated: process timed out after 15 minutes';

        finalStatus = {
          status: 'FAILED',
          message: timeoutMessage,
        };

        workerLogger.warn({
          requestId: target.id,
          jobName: metadata?.jobName,
          timeoutMessage,
        }, 'Job failed due to process timeout - attempting recovery dispatch');

        // Auto-dispatch for timeout recovery (if not at max attempts)
        await dispatchForTimeoutRecovery(metadata, target.id, timeoutMessage, telemetry);
      }

      // Transport error recovery: only for genuine transport failures, NOT loop protection or timeout
      if (parsed.processExitError && !isLoopProtection && !isTimeout) {
        if (!finalStatus || finalStatus.status === 'FAILED') {
          try {
            finalStatus = await inferJobStatus({
              requestId: target.id,
              error: null,
              telemetry: parsed.telemetry,
              delegatedThisRun: result.delegated,
              metadata,
            });
          } catch (statusInferenceError) {
            workerLogger.warn(
              { requestId: target.id, error: serializeError(statusInferenceError) },
              'Failed to re-infer job status after Gemini transport error',
            );
          }
        }

        const hasAgentOutput = Boolean(result.output && result.output.trim().length > 0);
        const hasToolCalls = Boolean(
          (result.telemetry?.toolCalls && result.telemetry.toolCalls.length > 0) ||
          (parsed.telemetry?.toolCalls && parsed.telemetry.toolCalls.length > 0)
        );
        const hasPartialOutput = Boolean(parsed.telemetry?.raw?.partialOutput);
        const agentActuallyRan = hasAgentOutput || hasToolCalls || hasPartialOutput;

        if (finalStatus?.status === 'COMPLETED' && agentActuallyRan) {
          workerLogger.warn(
            { jobName: metadata?.jobName, requestId: target.id },
            'Gemini CLI transport failed after agent completed; accepting completed result',
          );

          const mergedTelemetry = result.telemetry && Object.keys(result.telemetry).length > 0
            ? result.telemetry
            : (parsed.telemetry ? { ...parsed.telemetry } : {});
          if (!mergedTelemetry.errorType) {
            mergedTelemetry.errorType = 'PROCESS_ERROR';
          }
          const raw = (mergedTelemetry.raw =
            typeof mergedTelemetry.raw === 'object' && mergedTelemetry.raw !== null ? mergedTelemetry.raw : {});
          const warningLines = raw.stderrWarnings ? [raw.stderrWarnings] : [];
          warningLines.push('Gemini CLI: transport failed after agent completed (process exited).');
          raw.stderrWarnings = warningLines.join('\n');
          result.telemetry = mergedTelemetry;

          if (!result.output && typeof parsed.telemetry?.raw?.partialOutput === 'string') {
            result.output = parsed.telemetry.raw.partialOutput;
          }

          error = null;
        } else if (finalStatus?.status === 'COMPLETED' && !agentActuallyRan) {
          const isQuotaError = isGeminiQuotaError(e) || isGeminiQuotaError(stderrWarnings);

          const failureMessage = isQuotaError
            ? 'Agent execution failed: API quota exhausted (daily limit reached)'
            : 'Agent execution failed: transport error with no execution evidence';

          finalStatus = {
            status: 'FAILED',
            message: failureMessage,
          };

          workerLogger.warn(
            { jobName: metadata?.jobName, requestId: target.id, isQuotaError },
            'Gemini CLI transport failed with no agent execution evidence; setting status to FAILED',
          );

        }
      }
    }

    if (error) {
      workerLogger.error({
        jobName: metadata?.jobName,
        requestId: target.id,
        error: serializeError(error),
        finalStatus: finalStatus?.status,
        hasTelemetry: !!e?.telemetry
      }, 'Execution failed');
    }
  }

  // Reflection phase
  telemetry.startPhase('reflection');
  try {
    if (!contextPhasesEnabled) {
      workerLogger.info({ requestId: target.id }, 'Reflection phase skipped (BLUEPRINT_ENABLE_CONTEXT_PHASES=false)');
    } else {
      reflection = await runReflection(target, metadata!, finalStatus, result, error);
      if (reflection) {
        const reflectionArtifacts = extractMemoryArtifacts(reflection);
        const learningsCount = reflection?.telemetry?.toolCalls?.filter(
          (call: any) => call.tool === 'create_artifact' && call.success
        ).length || 0;

        telemetry.logCheckpoint('reflection', 'reflection_complete', {
          hasMemoryArtifacts: reflectionArtifacts.length > 0,
          learningsCount,
        });

        if (reflectionArtifacts.length > 0) {
          const existing = Array.isArray(result.artifacts) ? [...result.artifacts] : [];
          const seen = new Set(existing.map((artifact) => `${artifact.cid}|${artifact.topic}`));
          for (const artifact of reflectionArtifacts) {
            const key = `${artifact.cid}|${artifact.topic}`;
            if (seen.has(key)) continue;
            existing.push(artifact);
            seen.add(key);
          }
          result.artifacts = existing;
        }
      }
    }
  } catch (reflectionError: any) {
    telemetry.logError('reflection', reflectionError);
    workerLogger.warn({ requestId: target.id, error: serializeError(reflectionError) }, 'Reflection step failed (non-critical)');
  } finally {
    telemetry.endPhase('reflection');
  }

  // Situation artifact creation
  telemetry.startPhase('situation_creation');
  let situationCid: string | undefined;
  try {
    await createSituationArtifactForRequest({
      target,
      metadata: metadata!,
      result,
      finalStatus: finalStatus!,
      recognition,
    });

    // Extract CID from artifacts (situation artifact is added to result.artifacts)
    const situationArtifact = Array.isArray(result.artifacts)
      ? result.artifacts.find((a: any) => a.topic === 'SITUATION' || a.type === 'SITUATION')
      : null;
    situationCid = situationArtifact?.cid;

    telemetry.logCheckpoint('situation_creation', 'situation_artifact_created', {
      cid: situationCid,
      hasEmbedding: true, // Embedding is always created in createSituationArtifactForRequest
    });
  } catch (situationError: any) {
    telemetry.logError('situation_creation', situationError);
    workerLogger.warn({ requestId: target.id, error: serializeError(situationError) }, 'Failed to create situation artifact');
  }
  telemetry.endPhase('situation_creation');

  // Restore environment
  restoreEnvironment(envSnapshot);

  // Git operations phase: commit, push, and branch artifact creation
  telemetry.startPhase('git_operations');
  try {
    if (initializationFailed) {
      telemetry.logCheckpoint('git_operations', 'skipped', { reason: 'initialization_failed' });
      return;
    }

    // Prepare commit message if needed
    if (finalStatus?.status === 'COMPLETED') {
      const outputText = typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output ?? '');
      executionSummary = executionSummary ?? extractExecutionSummary(outputText);
    }

    let commitMessageForAutoCommit: string | null = null;
    if (finalStatus?.status === 'COMPLETED' && metadata?.codeMetadata) {
      commitMessageForAutoCommit = deriveCommitMessage(executionSummary, finalStatus, {
        jobId: target.id,
        jobDefinitionId: metadata?.jobDefinitionId,
      });
    }

    // Log push attempt details (both logger and console for test visibility)
    const pushDebugInfo = {
      requestId: target.id,
      finalStatus: finalStatus?.status,
      hasCodeMetadata: !!metadata?.codeMetadata,
      branchName: metadata?.codeMetadata?.branch?.name,
      repoRoot: getRepoRoot(metadata?.codeMetadata),
      codeMetadataRepoRoot: process.env.CODE_METADATA_REPO_ROOT,
    };
    workerLogger.info(pushDebugInfo, 'Git push attempt - checking conditions');

    const branchName = metadata?.codeMetadata?.branch?.name;
    const branchUrl = metadata?.codeMetadata && branchName
      ? generateBranchUrl(metadata.codeMetadata, branchName)
      : null;

    if (branchName) {
      const pushProceedInfo = {
        requestId: target.id,
        branchName,
        repoRoot: getRepoRoot(metadata.codeMetadata),
        hasCommitMessage: !!commitMessageForAutoCommit,
      };
      workerLogger.info(pushProceedInfo, 'Git push conditions met - proceeding with push');

      // Auto-commit if we have changes and a commit message
      if (commitMessageForAutoCommit) {
        const commitResult = await autoCommitIfNeeded(metadata.codeMetadata, commitMessageForAutoCommit);
        if (commitResult) {
          telemetry.logCheckpoint('git_operations', 'auto_commit', {
            commitMessage: commitMessageForAutoCommit,
            repoRoot: getRepoRoot(metadata.codeMetadata),
            commitHash: commitResult.commitHash,
            filesChanged: commitResult.filesChanged,
          });
        }
      }

      // Push branch
      await pushJobBranch(branchName, metadata.codeMetadata);
      telemetry.logCheckpoint('git_operations', 'push', {
        branchName,
        remoteName: 'origin',
        success: true,
        ...(branchUrl ? { branchUrl } : {}),
      });
    } else {
      const pushSkippedInfo = {
        requestId: target.id,
        hasCodeMetadata: !!metadata?.codeMetadata,
        hasBranch: !!metadata?.codeMetadata?.branch,
        branchName: metadata?.codeMetadata?.branch?.name,
      };
      workerLogger.warn(pushSkippedInfo, 'Git push skipped - branch name missing');
      telemetry.logCheckpoint('git_operations', 'push_skipped', {
        reason: 'branch_name_missing',
      });
    }

    // Create branch artifact if completed
    if (finalStatus?.status === 'COMPLETED' && metadata?.codeMetadata) {
      const branchName = metadata.codeMetadata.branch?.name;
      const baseBranch = metadata.codeMetadata.baseBranch || DEFAULT_BASE_BRANCH;

      if (branchName) {
        // Generate branch URL for viewing on GitHub/remote
        if (branchUrl) {
          const summaryBlock = formatSummaryForPr(executionSummary);
          const branchArtifactRecord = await createBranchArtifact({
            requestId: target.id,
            branchUrl,
            branchName,
            baseBranch,
            title: `[Job ${metadata.codeMetadata.jobDefinitionId}] updates`,
            summaryBlock: summaryBlock ?? undefined,
            codeMetadata: metadata.codeMetadata,
          });

          if (branchArtifactRecord) {
            result.artifacts = [...(result.artifacts || []), branchArtifactRecord];
            // Store branch URL for backward compatibility (some code may look for this)
            result.pullRequestUrl = branchUrl;
            telemetry.logCheckpoint('git_operations', 'branch_artifact_created', {
              branchName,
              baseBranch,
              branchUrl,
              cid: branchArtifactRecord.cid,
            });
          }
        }
      }
    }
  } catch (gitError: any) {
    telemetry.logError('git_operations', gitError);
    workerLogger.error({ error: serializeError(gitError) }, 'Git operations failed');
    // Update status if push failed
    if (gitError?.message?.includes('push') || gitError?.message?.includes('Push')) {
      finalStatus = {
        status: 'FAILED',
        message: `Git push failed: ${gitError?.message || serializeError(gitError)}`
      };
    }
    // Do NOT re-throw: git failures should not kill the worker process.
    // The error is logged and status updated above; execution continues to delivery.
  } finally {
    telemetry.endPhase('git_operations');
  }

  // Store report
  telemetry.startPhase('reporting');
  try {
    if (!finalStatus) {
      finalStatus = await inferJobStatus({
        requestId: target.id,
        error,
        telemetry: result?.telemetry || {},
        delegatedThisRun: result.delegated,
        metadata,
      });
    }
    await storeOnchainReport(target, workerAddress, result, finalStatus, error, metadata!);
    telemetry.logCheckpoint('reporting', 'report_stored', { status: finalStatus.status });
  } catch (reportError: any) {
    telemetry.logError('reporting', reportError);
    workerLogger.error({ requestId: target.id, error: serializeError(reportError) }, 'Report storage failed (non-fatal)');
  } finally {
    telemetry.endPhase('reporting');
  }

  // Deliver via Safe
  telemetry.startPhase('delivery');
  try {
    const artifactsForDelivery = Array.isArray(result?.artifacts) ? [...result.artifacts] : [];

    telemetry.logCheckpoint('delivery', 'delivery_started', {
      artifactCount: artifactsForDelivery.length,
      artifactCids: artifactsForDelivery
        .map((artifact) => artifact.cid)
        .filter((cid): cid is string => typeof cid === 'string' && cid.length > 0),
      hasWorkerTelemetry: artifactsForDelivery.some((artifact) => artifact.topic === 'WORKER_TELEMETRY'),
    });

    const workerTelemetrySnapshot = telemetry.getLog();
    workerLogger.info({ requestId: target.id }, '[DEBUG] About to call deliverViaSafeTransaction');
    const delivery = await deliverViaSafeTransaction({
      requestId: target.id,
      request: target,
      result,
      finalStatus: finalStatus!,
      metadata: metadata!,
      recognition,
      reflection,
      workerTelemetry: workerTelemetrySnapshot,
      measurementCoverage,
      artifactsForDelivery,
    });

    workerLogger.info({ requestId: target.id, tx: delivery?.tx_hash, status: delivery?.status }, '[DEBUG] Returned from deliverViaSafeTransaction');

    telemetry.logCheckpoint('delivery', 'delivery_completed', {
      txHash: delivery?.tx_hash,
      status: delivery?.status,
      artifactCount: artifactsForDelivery.length,
    });
    workerLogger.info({ requestId: target.id, tx: delivery?.tx_hash, status: delivery?.status }, 'Delivered via Safe');

    // Dispatch parent if needed (after delivery so Ponder has indexed this job's completion)
    await dispatchParentIfNeeded(finalStatus, metadata!, target.id, result?.output || '', {
      telemetry,
      artifacts: Array.isArray(result?.artifacts) ? result.artifacts : undefined,
    });
  } catch (e: any) {
    const message = e?.message || String(e);

    // Benign idempotency outcome: already delivered
    if (message.includes('Request already delivered')) {
      telemetry.logCheckpoint('delivery', 'delivery_already_completed', {});
      workerLogger.info(
        { requestId: target.id },
        'Delivery skipped: request already delivered on-chain',
      );

      // Still dispatch parent if needed (job completed, even if delivery was idempotent)
      await dispatchParentIfNeeded(finalStatus, metadata!, target.id, result?.output || '', {
        telemetry,
        artifacts: Array.isArray(result?.artifacts) ? result.artifacts : undefined,
      });

      return;
    }

    // Real failure path
    telemetry.logCheckpoint('delivery', 'delivery_failed', {
      message,
    });
    telemetry.logError('delivery', e);
    workerLogger.warn({ requestId: target.id, error: serializeError(e) }, 'Safe delivery failed');

    // Check if the error is due to a RevokeRequest event
    const isRevokeError = message.includes('revoked by the Mech contract');

    if (isRevokeError && metadata?.jobDefinitionId) {
      workerLogger.warn({
        requestId: target.id,
        jobDefinitionId: metadata.jobDefinitionId,
        jobName: metadata.jobName
      }, 'Request was revoked - automatic re-dispatch recommended');

      // Store failure status with revoke context
      try {
        await storeOnchainReport(target, workerAddress, result, {
          status: 'FAILED',
          message: `Delivery revoked by Mech contract. Job should be re-dispatched: ${metadata.jobName || metadata.jobDefinitionId}`,
        }, e, metadata!);
      } catch (reportErr: any) {
        workerLogger.warn({ jobName: metadata?.jobName, requestId: target.id, error: serializeError(reportErr) }, 'Failed to record REVOKE_FAILURE status');
      }
    } else {
      // Standard failure handling
      try {
        await storeOnchainReport(target, workerAddress, result, {
          status: 'FAILED',
          message: `Delivery failed: ${e?.message || String(e)}`,
        }, e, metadata!);
      } catch (reportErr: any) {
        workerLogger.warn({ jobName: metadata?.jobName, requestId: target.id, error: serializeError(reportErr) }, 'Failed to record FAILED status');
      }
    }
  } finally {
    telemetry.endPhase('delivery');
  }

  // Persist final worker telemetry snapshot (includes delivery details)
  telemetry.startPhase('telemetry_persistence');
  try {
    const workerTelemetryLog = telemetry.getLog();
    const { createArtifact: mcpCreateArtifact } = await import('../../agent/mcp/tools/create_artifact.js');
    const telemetryArtifactResponse = await mcpCreateArtifact({
      name: `worker-telemetry-${target.id}`,
      topic: 'WORKER_TELEMETRY',
      content: JSON.stringify(workerTelemetryLog, null, 2),
      type: 'WORKER_TELEMETRY',
    });
    const telemetryArtifactParsed = safeParseToolResponse(telemetryArtifactResponse);
    if (telemetryArtifactParsed.ok && telemetryArtifactParsed.data) {
      const artifactRecord = {
        cid: telemetryArtifactParsed.data.cid,
        name: telemetryArtifactParsed.data.name || `worker-telemetry-${target.id}`,
        topic: 'WORKER_TELEMETRY',
        type: 'WORKER_TELEMETRY',
        contentPreview:
          telemetryArtifactParsed.data.contentPreview
          || `Worker telemetry with ${workerTelemetryLog.events.length} events`,
      };

      // Register artifact with Control API for subgraph/indexing
      try {
        const { createArtifact: apiCreateArtifact } = await import('../control_api_client.js');
        await apiCreateArtifact(target.id, { cid: artifactRecord.cid, topic: artifactRecord.topic, content: null });
      } catch (controlError: any) {
        workerLogger.warn(
          { requestId: target.id, error: serializeError(controlError) },
          'Failed to register worker telemetry artifact (non-critical)',
        );
      }

      const existingArtifacts = Array.isArray(result.artifacts) ? [...result.artifacts] : [];
      existingArtifacts.push(artifactRecord);
      result.artifacts = existingArtifacts;

      telemetry.logCheckpoint('telemetry_persistence', 'artifact_saved', {
        cid: artifactRecord.cid,
        name: artifactRecord.name,
        events: workerTelemetryLog.events.length,
      });
    }
  } catch (telemetryArtifactError: any) {
    telemetry.logError('telemetry_persistence', telemetryArtifactError);
    workerLogger.warn(
      { requestId: target.id, error: serializeError(telemetryArtifactError) },
      'Failed to persist worker telemetry artifact (non-critical)',
    );
  } finally {
    telemetry.endPhase('telemetry_persistence');
  }
}
