import { graphQLRequest } from '../../../../http/client.js';
import { mcpLogger } from '../../../../logging/index.js';
import { config } from '../../../../config/index.js';

export interface JobHierarchyItem {
    jobId: string;
    name: string;
    level: number;
    sourceJobDefinitionId: string | null;
    status: 'active' | 'completed' | 'failed' | 'unknown';
    requestIds: string[];
    branchName?: string;
    baseBranch?: string;
    artifactRefs: {
        id: string;
        name: string;
        topic: string;
        cid: string;
    }[];
    messageRefs: {
        id: string;
        content: string;
        from: string | null;
        blockTimestamp: string;
    }[];
}

interface BatchedJobData {
    jobDefinitions: Array<{
        id: string;
        name: string;
        blueprint?: string;
        sourceJobDefinitionId?: string;
        lastStatus?: string;
    }>;
    requests: Array<{
        id: string;
        delivered: boolean;
        blockTimestamp: string;
        jobDefinitionId?: string;
    }>;
    artifacts: Array<{
        id: string;
        name: string;
        topic: string;
        cid: string;
        sourceJobDefinitionId?: string;
        contentPreview?: string;
    }>;
    childJobs: Array<{
        id: string;
        sourceJobDefinitionId?: string;
    }>;
    messages: Array<{
        id: string;
        content: string;
        sourceJobDefinitionId?: string;
        to?: string;
        blockTimestamp: string;
    }>;
}

async function fetchBatchedJobData(jobIds: string[], PONDER_GRAPHQL_URL: string): Promise<BatchedJobData> {

    const batchQuery = `
        query GetBatchedJobData($jobIds: [String!]!) {
            jobDefinitions(where: { id_in: $jobIds }, limit: 1000) {
                items {
                    id
                    name
                    blueprint
                    sourceJobDefinitionId
                    lastStatus
                }
            }
            requests(where: { jobDefinitionId_in: $jobIds }, limit: 1000) {
                items {
                    id
                    delivered
                    blockTimestamp
                    jobDefinitionId
                }
            }
            artifacts(where: { sourceJobDefinitionId_in: $jobIds }, limit: 1000) {
                items {
                    id
                    name
                    topic
                    cid
                    sourceJobDefinitionId
                    contentPreview
                }
            }
            childJobs: jobDefinitions(where: { sourceJobDefinitionId_in: $jobIds }, limit: 1000) {
                items {
                    id
                    sourceJobDefinitionId
                }
            }
            messages(where: { to_in: $jobIds }, limit: 1000) {
                items {
                    id
                    content
                    sourceJobDefinitionId
                    to
                    blockTimestamp
                }
            }
        }
    `;

    const result = await graphQLRequest<{
        jobDefinitions: {
            items: Array<{
                id: string;
                name: string;
                blueprint?: string;
                sourceJobDefinitionId?: string;
                lastStatus?: string;
            }>
        };
        requests: {
            items: Array<{
                id: string;
                delivered: boolean;
                blockTimestamp: string;
                jobDefinitionId?: string;
            }>
        };
        artifacts: {
            items: Array<{
                id: string;
                name: string;
                topic: string;
                cid: string;
                sourceJobDefinitionId?: string;
                contentPreview?: string;
            }>
        };
        childJobs: {
            items: Array<{
                id: string;
                sourceJobDefinitionId?: string;
            }>
        };
        messages: {
            items: Array<{
                id: string;
                content: string;
                sourceJobDefinitionId?: string;
                to?: string;
                blockTimestamp: string;
            }>
        };
    }>({
        url: PONDER_GRAPHQL_URL,
        query: batchQuery,
        variables: { jobIds },
        maxRetries: 1,
        context: { operation: 'fetchBatchedJobData', jobCount: jobIds.length }
    });

    return {
        jobDefinitions: result.jobDefinitions?.items || [],
        requests: result.requests?.items || [],
        artifacts: result.artifacts?.items || [],
        childJobs: result.childJobs?.items || [],
        messages: result.messages?.items || []
    };
}

export async function fetchJobHierarchy(rootJobId: string, maxDepth: number = 3): Promise<{
    hierarchy: JobHierarchyItem[];
    errors: Array<{ jobId: string, level: number, error: string }>;
}> {
    const PONDER_GRAPHQL_URL = config.services.ponderUrl;
    const visited = new Set<string>();
    const hierarchy: JobHierarchyItem[] = [];
    const errors: Array<{ jobId: string, level: number, error: string }> = [];

    // Process jobs level by level using batched queries
    let currentLevel = [{ jobId: rootJobId, level: 0, sourceId: null as string | null }];

    while (currentLevel.length > 0 && currentLevel[0].level <= maxDepth) {
        // Filter out already visited jobs
        const newJobs = currentLevel.filter(job => !visited.has(job.jobId));
        if (newJobs.length === 0) break;

        // Mark as visited
        newJobs.forEach(job => visited.add(job.jobId));

        const jobIds = newJobs.map(job => job.jobId);

        try {
            // Fetch all data for current level in a single batched query
            const batchData = await fetchBatchedJobData(jobIds, PONDER_GRAPHQL_URL);

            // Create lookup maps for efficient processing
            const jobDefMap = new Map(batchData.jobDefinitions.map(job => [job.id, job]));
            const requestsByJob = new Map<string, typeof batchData.requests>();
            const artifactsByJob = new Map<string, typeof batchData.artifacts>();
            const childrenByJob = new Map<string, typeof batchData.childJobs>();
            const messagesByJob = new Map<string, typeof batchData.messages>();

            // Group related data by job ID
            batchData.requests.forEach(req => {
                if (req.jobDefinitionId) {
                    const existing = requestsByJob.get(req.jobDefinitionId) || [];
                    existing.push(req);
                    requestsByJob.set(req.jobDefinitionId, existing);
                }
            });

            batchData.artifacts.forEach(artifact => {
                if (artifact.sourceJobDefinitionId) {
                    const existing = artifactsByJob.get(artifact.sourceJobDefinitionId) || [];
                    existing.push(artifact);
                    artifactsByJob.set(artifact.sourceJobDefinitionId, existing);
                }
            });

            batchData.childJobs.forEach(child => {
                if (child.sourceJobDefinitionId) {
                    const existing = childrenByJob.get(child.sourceJobDefinitionId) || [];
                    existing.push(child);
                    childrenByJob.set(child.sourceJobDefinitionId, existing);
                }
            });

            batchData.messages.forEach(msg => {
                if (msg.to) {
                    const existing = messagesByJob.get(msg.to) || [];
                    existing.push(msg);
                    messagesByJob.set(msg.to, existing);
                }
            });

            // Process each job in current level
            const nextLevel: Array<{ jobId: string, level: number, sourceId: string | null }> = [];

            for (const { jobId, level, sourceId } of newJobs) {
                const job = jobDefMap.get(jobId);
                if (!job) {
                    errors.push({ jobId, level, error: 'Job definition not found' });
                    continue;
                }

                const requests = requestsByJob.get(jobId) || [];
                const artifacts = artifactsByJob.get(jobId) || [];
                const children = childrenByJob.get(jobId) || [];
                const messages = messagesByJob.get(jobId) || [];

                // Use lastStatus from Ponder (already accurate from delivery payloads)
                const rawStatus = job.lastStatus?.toUpperCase();
                let status: 'active' | 'completed' | 'failed' | 'unknown' = 'unknown';

                if (rawStatus === 'COMPLETED') {
                    status = 'completed';
                } else if (rawStatus === 'FAILED') {
                    status = 'failed';
                } else if (rawStatus === 'DELEGATING' || rawStatus === 'WAITING' || rawStatus === 'PENDING') {
                    status = 'active';
                } else if (rawStatus) {
                    // Unknown status string from Ponder
                    mcpLogger.warn({
                        tool: 'job_context_utils',
                        jobId,
                        rawStatus
                    }, `Unrecognized lastStatus value: ${rawStatus}`);
                }

                // Extract branch info from GIT_BRANCH artifact if present
                let branchName: string | undefined;
                let baseBranch: string | undefined;

                const gitBranchArtifact = artifacts.find(
                    a => a.topic === 'git/branch' || a.name?.includes('GIT_BRANCH')
                );

                if (gitBranchArtifact) {
                    // Try to parse from contentPreview (format: "Branch: <branch> based on <base> ...")
                    const contentPreview = gitBranchArtifact.contentPreview || '';
                    const branchMatch = contentPreview.match(/Branch:\s*([^\s]+)\s+based\s+on\s+([^\s\n]+)/i);

                    if (branchMatch) {
                        branchName = branchMatch[1];
                        baseBranch = branchMatch[2];
                    } else {
                        // Try simple pattern match check
                        const simpleMatch = contentPreview.match(/job\/[a-f0-9-]+(?:-[a-z0-9-]+)?/i);
                        if (simpleMatch) {
                            branchName = simpleMatch[0];
                        }
                    }
                }

                // Add to hierarchy
                hierarchy.push({
                    jobId,
                    name: job.name || 'Unnamed Job',
                    level,
                    sourceJobDefinitionId: sourceId,
                    status,
                    requestIds: requests.map(r => r.id),
                    branchName,
                    baseBranch,
                    artifactRefs: artifacts.map(a => ({
                        id: a.id,
                        name: a.name,
                        topic: a.topic,
                        cid: a.cid
                    })),
                    messageRefs: messages.map(m => ({
                        id: m.id,
                        content: m.content,
                        from: m.sourceJobDefinitionId || null,
                        blockTimestamp: m.blockTimestamp
                    }))
                });

                // Add children to next level (if not exceeding max depth)
                if (level < maxDepth) {
                    children.forEach(child => {
                        nextLevel.push({
                            jobId: child.id,
                            level: level + 1,
                            sourceId: jobId
                        });
                    });
                }
            }

            currentLevel = nextLevel;

        } catch (error) {
            // Log batch error and mark all jobs in current level as failed
            newJobs.forEach(job => {
                errors.push({
                    jobId: job.jobId,
                    level: job.level,
                    error: `Batch fetch failed: ${error instanceof Error ? error.message : String(error)}`
                });
            });
            break;
        }
    }

    // Log errors using proper MCP logger
    if (errors.length > 0) {
        mcpLogger.warn({
            tool: 'job_context_utils',
            rootJobId,
            maxDepth,
            errorCount: errors.length,
            errors
        }, `Job hierarchy traversal encountered ${errors.length} errors`);
    }

    // Sort by level first, then by name for consistent ordering
    const sortedHierarchy = hierarchy.sort((a, b) => {
        if (a.level !== b.level) {
            return a.level - b.level;
        }
        return a.name.localeCompare(b.name);
    });

    return { hierarchy: sortedHierarchy, errors };
}

/**
 * Get job context data for dispatch purposes (simplified, no pagination)
 */
export async function getJobContextForDispatch(jobId: string, maxDepth: number = 3): Promise<{
    hierarchy: JobHierarchyItem[];
    summary: {
        totalJobs: number;
        completedJobs: number;
        activeJobs: number;
        totalArtifacts: number;
        hasErrors: boolean;
    };
} | null> {
    try {
        const { hierarchy, errors } = await fetchJobHierarchy(jobId, maxDepth);

        const summary = {
            totalJobs: hierarchy.length,
            completedJobs: hierarchy.filter(j => j.status === 'completed').length,
            activeJobs: hierarchy.filter(j => j.status === 'active').length,
            totalArtifacts: hierarchy.reduce((sum, j) => sum + j.artifactRefs.length, 0),
            hasErrors: errors.length > 0
        };

        return { hierarchy, summary };
    } catch (error) {
        mcpLogger.error({
            tool: 'job_context_utils',
            jobId,
            error: error instanceof Error ? error.message : String(error)
        }, 'Failed to fetch job context for dispatch');
        return null;
    }
}