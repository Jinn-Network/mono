/**
 * CoordinationInvariantProvider - Generates dynamic invariants for parent-child coordination
 *
 * This provider consolidates child work handling and merge conflict resolution:
 * - Completed child jobs with branches to review
 * - Failed children requiring remediation
 * - Merge conflicts from dependency branches
 * 
 * Domain: coordination - Parent-child workflow and git operations
 */

import type {
    InvariantProvider,
    BuildContext,
    BlueprintContext,
    BlueprintBuilderConfig,
    Invariant,
    ChildJobInfo,
} from '../../types.js';
import { workerLogger } from '../../../../logging/index.js';
import { extractMissionInvariantIds } from '../../utils/invariantIds.js';

interface MergeConflict {
    branch: string;
    files: string[];
}

/**
 * CoordinationInvariantProvider generates invariants for parent-child coordination
 */
export class CoordinationInvariantProvider implements InvariantProvider {
    name = 'coordination';

    enabled(config: BlueprintBuilderConfig): boolean {
        return config.enableContextAssertions;
    }

    async provide(
        ctx: BuildContext,
        builtContext: BlueprintContext
    ): Promise<Invariant[]> {
        const invariants: Invariant[] = [];

        // Add child work invariants
        invariants.push(...this.getChildWorkInvariants(ctx, builtContext));

        // Add merge conflict invariants
        invariants.push(...this.getMergeConflictInvariants(ctx));

        // Add unmeasured invariant guidance (on re-runs only)
        const unmeasuredInvariant = this.getUnmeasuredInvariant(ctx, builtContext);
        if (unmeasuredInvariant) {
            invariants.push(unmeasuredInvariant);
        }

        return invariants;
    }

    private getChildWorkInvariants(
        ctx: BuildContext,
        builtContext: BlueprintContext
    ): Invariant[] {
        const hierarchy = builtContext.hierarchy;

        if (!hierarchy || !hierarchy.children || hierarchy.children.length === 0) {
            return [];
        }

        const invariants: Invariant[] = [];

        const completedChildren = hierarchy.children.filter(
            (child) => child.status === 'COMPLETED'
        );
        const failedChildren = hierarchy.children.filter(
            (child) => child.status === 'FAILED'
        );

        if (failedChildren.length > 0) {
            invariants.push(this.createFailedChildrenInvariant(failedChildren));
        } else {
            const isVerification = ctx.metadata?.additionalContext?.verificationRequired === true;
            if (!isVerification) {
                invariants.push(this.createParentRoleInvariant());
            }
        }

        const unintegratedChildren = completedChildren.filter(
            (c) => c.branchName && !c.isIntegrated
        );

        const integratedChildren = completedChildren.filter(
            (c) => c.branchName && c.isIntegrated === true
        );

        if (integratedChildren.length > 0) {
            workerLogger.info({
                excludedCount: integratedChildren.length,
                excludedChildren: integratedChildren.map(c => ({
                    jobName: c.jobName,
                    branchName: c.branchName,
                    requestId: c.requestId.slice(0, 10),
                })),
            }, 'Excluding integrated children from invariants');
        }

        const childrenWithoutBranches = completedChildren.filter(
            (c) => !c.branchName
        );

        if (unintegratedChildren.length > 0) {
            invariants.push(this.createBranchReviewInvariant(unintegratedChildren));
        }

        if (childrenWithoutBranches.length > 0) {
            invariants.push(this.createArtifactChildrenInvariant(childrenWithoutBranches));
        }

        return invariants;
    }

    private getMergeConflictInvariants(ctx: BuildContext): Invariant[] {
        const mergeConflicts = ctx.metadata.additionalContext?.mergeConflicts as MergeConflict[] | undefined;

        if (!mergeConflicts || mergeConflicts.length === 0) {
            return [];
        }

        const totalFiles = mergeConflicts.reduce((sum, c) => sum + c.files.length, 0);
        const branchList = mergeConflicts.map((c) => `'${c.branch}'`).join(', ');

        return [{
            id: 'COORD-MERGE-CONFLICTS',
            type: 'BOOLEAN',
            condition: `You must resolve ${totalFiles} merge conflict marker(s) from dependency branch(es): ${branchList}. All conflict markers (<<<<<<< / ======= / >>>>>>>) must be resolved and changes must be included in the WIP commit(s).`,
            assessment: 'Verify all conflict markers are removed from files and changes are committed.',
            examples: {
                do: ['Open each conflicting file, resolve markers, then git add and git commit --amend'],
                dont: ['Proceed with your task while conflict markers remain in code'],
            },
        }];
    }

    private createFailedChildrenInvariant(failedChildren: ChildJobInfo[]): Invariant {
        const failedNames = failedChildren
            .map((c) => c.jobName || c.requestId.slice(0, 8))
            .join(', ');

        return {
            id: 'COORD-FAILED-CHILDREN',
            type: 'BOOLEAN',
            condition: `You must remediate ${failedChildren.length} failed child job(s): ${failedNames}. You must retry with corrected blueprints or document why they are superseded.`,
            assessment: 'Verify all failed children are either successfully retried with improved blueprints or documented as superseded.',
            examples: {
                do: ['Review failed child summaries, then dispatch_new_job with improved blueprints to retry'],
                dont: ['Ignore failed children and mark job COMPLETED'],
            },
        };
    }

    private createBranchReviewInvariant(children: ChildJobInfo[]): Invariant {
        const branchDetails = children.map((c) => {
            const name = c.jobName || c.requestId.slice(0, 8);
            return `- ${c.branchName} (${name})`;
        }).join('\\n');

        return {
            id: 'COORD-BRANCH-REVIEW',
            type: 'BOOLEAN',
            condition: `You integrate ${children.length} child branch(es) before starting new work`,
            assessment: 'All child branches are either merged into current branch or rejected with documented rationale. No unintegrated child branches remain.',
            examples: {
                do: ['Review each child branch diff, merge good work, reject with explanation if needed'],
                dont: ['Start new implementation while child branches await integration'],
            },
        };
    }

    private createArtifactChildrenInvariant(children: ChildJobInfo[]): Invariant {
        const childList = children.map((c) => {
            const name = c.jobName || c.requestId.slice(0, 8);
            return `- ${name}`;
        }).join('\\n');

        return {
            id: 'COORD-ARTIFACT-CHILDREN',
            type: 'BOOLEAN',
            condition: `You must review ${children.length} completed child job(s) that produced artifacts (no branches to merge). You must check their outputs in context.hierarchy.children and build upon their work.`,
            assessment: 'Verify child job outputs have been reviewed and incorporated into the current work.',
            examples: {
                do: ['Check context.hierarchy.children for child job details and build upon their outputs'],
                dont: ['Re-do work children already completed'],
            },
        };
    }

    private createParentRoleInvariant(): Invariant {
        return {
            id: 'COORD-PARENT-ROLE',
            type: 'BOOLEAN',
            condition: 'You must prioritize reviewing child branches with process_branch and merging them over implementing work yourself.',
            assessment: 'Verify child branches are reviewed and integrated before starting new implementation work.',
            examples: {
                do: [`Call process_branch({ action: 'compare' }) to review each child's diff, then merge or reject`],
                dont: ['Ignore child branches and start fresh implementation'],
            },
        };
    }

    /**
     * Generate COORD-UNMEASURED invariant on re-runs when some mission invariants lack measurements.
     *
     * Only activates when:
     * - The blueprint has mission invariants (JOB/GOAL/OUT/STRAT prefixed)
     * - Prior measurements exist (indicating a re-run, not first execution)
     * - Some mission invariants remain unmeasured
     *
     * Suppressed when all invariants are unmeasured AND active child jobs exist
     * (indicating delegation - children will measure their own scope).
     */
    private getUnmeasuredInvariant(
        ctx: BuildContext,
        builtContext: BlueprintContext
    ): Invariant | null {
        const missionIds = extractMissionInvariantIds(ctx.metadata?.blueprint);
        if (missionIds.length === 0) return null;

        const measurements = builtContext.measurements;
        // Only activate on re-runs (when at least one measurement exists from prior execution)
        if (!measurements || measurements.length === 0) return null;

        const measuredIds = new Set(measurements.map(m => m.invariantId));
        const unmeasuredIds = missionIds.filter(id => !measuredIds.has(id));

        if (unmeasuredIds.length === 0) return null;

        // Delegation suppression: if ALL mission invariants are unmeasured and there are
        // active child jobs, the agent likely delegated everything - don't nag.
        const activeJobs = builtContext.hierarchy?.activeJobs || 0;
        if (unmeasuredIds.length === missionIds.length && activeJobs > 0) {
            workerLogger.info({
                unmeasuredCount: unmeasuredIds.length,
                activeJobs,
            }, 'Suppressing COORD-UNMEASURED: all invariants unmeasured with active children (likely delegated)');
            return null;
        }

        return {
            id: 'COORD-UNMEASURED',
            type: 'BOOLEAN',
            condition: `You must create measurements for ${unmeasuredIds.length} unmeasured mission invariant(s): ${unmeasuredIds.join(', ')}. Use create_measurement with the exact invariant IDs listed.`,
            assessment: `Verify all listed invariants have measurements. Currently unmeasured: ${unmeasuredIds.join(', ')}`,
            examples: {
                do: [`Call create_measurement({ invariant_type: 'BOOLEAN', invariant_id: '${unmeasuredIds[0]}', passed: true, context: '...' }) for each unmeasured invariant`],
                dont: ['Skip measurement for invariants you evaluated during execution'],
            },
        };
    }
}
