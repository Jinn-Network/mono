/**
 * ProgressCheckpointProvider - Provides progress context from prior runs
 *
 * This provider extracts progress information from the recognition phase result
 * and outputs structured BlueprintContext.progress.
 */

import type {
  ContextProvider,
  BuildContext,
  BlueprintContext,
  BlueprintBuilderConfig,
  ProgressContext,
} from '../../types.js';

/**
 * ProgressCheckpointProvider extracts workstream progress information
 */
export class ProgressCheckpointProvider implements ContextProvider {
  name = 'progress-checkpoint';

  enabled(config: BlueprintBuilderConfig): boolean {
    return config.enableProgressCheckpoint;
  }

  async provide(ctx: BuildContext): Promise<Partial<BlueprintContext>> {
    const recognition = ctx.recognition;

    if (!recognition?.progressCheckpoint) {
      return {};
    }

    const checkpoint = recognition.progressCheckpoint;

    // Extract meaningful progress information
    const progress: ProgressContext = {
      summary: checkpoint.checkpointSummary || '',
    };

    // Try to extract completed phases from the summary or workstream jobs
    const completedPhases = this.extractCompletedPhases(checkpoint);
    if (completedPhases.length > 0) {
      progress.completedPhases = completedPhases;
    }

    // Only return if we have meaningful content
    if (!progress.summary && !progress.completedPhases) {
      return {};
    }

    return { progress };
  }

  /**
   * Try to extract completed phases from checkpoint data
   */
  private extractCompletedPhases(checkpoint: any): string[] {
    const phases: string[] = [];

    // If workstreamJobs exist, extract job names as "completed phases"
    if (Array.isArray(checkpoint.workstreamJobs)) {
      for (const job of checkpoint.workstreamJobs) {
        if (job.jobName) {
          phases.push(job.jobName);
        }
      }
    }

    return phases;
  }
}
