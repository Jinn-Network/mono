/**
 * JobContextProvider - Provides job hierarchy and artifact context
 *
 * This provider fetches child job data from Ponder using a single query,
 * replacing the dual-source approach (completedChildRuns + hierarchy)
 * that was prone to duplicates and phantom entries.
 */

import type {
  ContextProvider,
  BuildContext,
  BlueprintContext,
  BlueprintBuilderConfig,
  HierarchyContext,
  ChildJobInfo,
  ArtifactInfo,
  AdditionalContext,
} from '../../types.js';
import { workerLogger } from '../../../../logging/index.js';
import { serializeError } from '../../../logging/errors.js';
import { config } from '../../../../config/index.js';
import { graphQLRequest } from '../../../../http/client.js';
import { fetchAllChildren, type ChildJobData } from './fetchChildren.js';
import { isChildIntegrated, batchFetchBranches } from '../../../git/integration.js';

/**
 * JobContextProvider extracts hierarchy and artifact information
 */
export class JobContextProvider implements ContextProvider {
  name = 'job-context';

  enabled(config: BlueprintBuilderConfig): boolean {
    return config.enableJobContext;
  }

  async provide(ctx: BuildContext): Promise<Partial<BlueprintContext>> {
    const result: Partial<BlueprintContext> = {};
    const jobDefinitionId = ctx.metadata?.jobDefinitionId;

    // Fetch children from Ponder using single authoritative query
    if (jobDefinitionId) {
      const hierarchy = await this.fetchHierarchy(jobDefinitionId);
      if (hierarchy) {
        result.hierarchy = hierarchy;
      }
    }

    // Extract artifacts from additionalContext (kept for backward compatibility)
    const additionalContext = ctx.metadata?.additionalContext;
    if (additionalContext) {
      const artifacts = this.extractArtifacts(additionalContext);
      if (artifacts.length > 0) {
        result.artifacts = artifacts;
      }
    }

    return result;
  }

  /**
   * Fetch hierarchy information from Ponder using single query.
   * This replaces the dual-source merge of completedChildRuns + hierarchy.
   */
  private async fetchHierarchy(parentJobDefId: string): Promise<HierarchyContext | undefined> {
    const childrenData = await fetchAllChildren(parentJobDefId);

    if (childrenData.length === 0) {
      return undefined;
    }

    // Fetch delivery hashes for completed children so we can pull their summaries
    const deliveryHashes = await this.fetchChildDeliveryHashes(childrenData.map((c) => c.jobDefinitionId));

    const repoRoot = process.env.CODE_METADATA_REPO_ROOT;
    const parentBranch = process.env.CODE_METADATA_BRANCH_NAME || 'main';

    // Batch fetch all child branches + parent for efficiency
    if (repoRoot) {
      const branchNames = childrenData.map((c) => c.branchName).filter(Boolean) as string[];
      if (branchNames.length > 0) {
        batchFetchBranches(branchNames, parentBranch);
      }
    }

    // Map Ponder data to ChildJobInfo with integration check
    const children: ChildJobInfo[] = [];

    for (const child of childrenData) {
      // Check if child's work is already integrated into parent
      const isIntegrated = child.branchName
        ? isChildIntegrated(child.branchName, parentBranch)
        : true; // No branch = integrated (nothing to merge)

      if (isIntegrated) {
        workerLogger.info(
          { branchName: child.branchName, jobDefinitionId: child.jobDefinitionId },
          'Child already integrated (commits in parent or branch deleted)'
        );
      }

      let summary: string | undefined;

      // Only attempt to fetch summaries for completed children
      if (child.status === 'COMPLETED') {
        const deliveryHash = deliveryHashes.get(child.jobDefinitionId);

        if (deliveryHash) {
          try {
            const payload = await this.fetchDeliverySummary(deliveryHash, child.jobDefinitionId);
            summary = payload;
          } catch (error: any) {
            workerLogger.warn(
              { childJobDefinitionId: child.jobDefinitionId, error: serializeError(error) },
              'Failed to fetch child delivery summary'
            );
          }
        }
      }

      children.push({
        // Note: We're using jobDefinitionId as the identifier now,
        // since that's what Ponder query returns. The ChildJobInfo type
        // uses requestId, but for our purposes the job def ID works.
        requestId: child.jobDefinitionId,
        jobName: child.jobName,
        status: child.status,
        summary,
        branchName: child.branchName,
        baseBranch: child.baseBranch,
        isIntegrated,
      });
    }

    const childrenWithSummaries = children.filter((c) => !!c.summary).length;
    if (childrenWithSummaries > 0) {
      workerLogger.info(
        {
          parentJobDefId,
          totalChildren: children.length,
          childrenWithSummaries,
        },
        'Attached child delivery summaries to hierarchy'
      );
    }

    return {
      totalJobs: children.length,
      completedJobs: children.filter((c) => c.status === 'COMPLETED').length,
      activeJobs: children.filter((c) => c.status === 'ACTIVE').length,
      children,
    };
  }

  /**
   * Extract artifacts from additionalContext
   * (kept for backward compatibility until artifact fetching is consolidated)
   */
  private extractArtifacts(additionalContext: AdditionalContext): ArtifactInfo[] {
    const artifacts: ArtifactInfo[] = [];
    const hierarchyJobs = additionalContext.hierarchy;

    if (!Array.isArray(hierarchyJobs)) {
      return artifacts;
    }

    // Collect artifacts from all jobs in the hierarchy
    for (const job of hierarchyJobs) {
      if (Array.isArray(job.artifactRefs)) {
        for (const artifact of job.artifactRefs) {
          artifacts.push({
            name: artifact.name || artifact.topic || 'unnamed',
            cid: artifact.cid,
            type: artifact.type || artifact.topic,
          });
        }
      }
    }

    return artifacts;
  }

  /**
   * Fetch deliveryIpfsHash for child job definitions (latest delivered request per jobDef).
   */
  private async fetchChildDeliveryHashes(childJobDefIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!childJobDefIds || childJobDefIds.length === 0) return map;

    try {
      const data = await graphQLRequest<{
        requests: {
          items: Array<{
            id: string;
            jobDefinitionId?: string;
            deliveryIpfsHash?: string;
            blockTimestamp?: string;
          }>;
        };
      }>({
        url: config.services.ponderUrl,
        query: `
          query GetChildDeliveries($jobDefIds: [String!]!) {
            requests(
              where: { jobDefinitionId_in: $jobDefIds, delivered: true }
              orderBy: "blockTimestamp"
              orderDirection: "desc"
              limit: 200
            ) {
              items {
                id
                jobDefinitionId
                deliveryIpfsHash
                blockTimestamp
              }
            }
          }
        `,
        variables: { jobDefIds: childJobDefIds },
        context: { operation: 'fetchChildDeliveries', jobDefIds: childJobDefIds.slice(0, 10) },
      });

      const items = data?.requests?.items || [];
      for (const item of items) {
        if (!item.jobDefinitionId || !item.deliveryIpfsHash) continue;
        // First delivered item per jobDef (sorted desc) wins
        if (!map.has(item.jobDefinitionId)) {
          map.set(item.jobDefinitionId, item.deliveryIpfsHash);
        }
      }
    } catch (error: any) {
      workerLogger.warn(
        { error: serializeError(error), jobDefIds: childJobDefIds.slice(0, 10) },
        'Failed to fetch child delivery hashes'
      );
    }

    return map;
  }

  /**
   * Fetch delivery payload and extract a concise summary.
   */
  private async fetchDeliverySummary(deliveryHash: string, requestId: string): Promise<string | undefined> {
    const payload = await fetchDeliveryPayload(deliveryHash, requestId);
    if (!payload) return undefined;

    if (payload.structuredSummary && typeof payload.structuredSummary === 'string') {
      return payload.structuredSummary;
    }

    if (payload.output && typeof payload.output === 'string') {
      const maxLen = 1000;
      if (payload.output.length <= maxLen) return payload.output;
      return `${payload.output.slice(0, maxLen)}...`;
    }

    return undefined;
  }
}

/**
 * Fetch and parse delivery payload from IPFS (adapted from progressCheckpoint).
 */
async function fetchDeliveryPayload(
  deliveryHash: string,
  requestId: string
): Promise<{ structuredSummary?: string; output?: string } | null> {
  const gatewayBase = (config.services.ipfsGatewayUrl || 'https://gateway.autonolas.tech/ipfs/').replace(/\/+$/, '');

  const dirCid = reconstructDeliveryCid(deliveryHash);
  if (!dirCid) {
    workerLogger.warn({ requestId, deliveryHash }, 'Could not reconstruct directory CID for delivery');
    return null;
  }

  const url = `${gatewayBase}/${dirCid}/${requestId}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        workerLogger.warn({ requestId, url, status: response.status }, 'Failed to fetch delivery payload from IPFS');
        return null;
      }

      const data = await response.json();
      return data;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error: any) {
    workerLogger.warn({ requestId, url, error: serializeError(error) }, 'Error fetching delivery payload');
    return null;
  }
}

/**
 * Reconstruct directory CID from raw delivery hash.
 */
function reconstructDeliveryCid(deliveryHash: string): string | null {
  try {
    const digestHex = String(deliveryHash).replace(/^f01551220/i, '');
    const digestBytes: number[] = [];
    for (let i = 0; i < digestHex.length; i += 2) {
      digestBytes.push(parseInt(digestHex.slice(i, i + 2), 16));
    }
    const cidBytes = [0x01, 0x70, 0x12, 0x20, ...digestBytes];
    const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bitBuffer = 0;
    let bitCount = 0;
    let out = '';
    for (const b of cidBytes) {
      bitBuffer = (bitBuffer << 8) | (b & 0xff);
      bitCount += 8;
      while (bitCount >= 5) {
        const idx = (bitBuffer >> (bitCount - 5)) & 0x1f;
        bitCount -= 5;
        out += base32Alphabet[idx];
      }
    }
    if (bitCount > 0) {
      const idx = (bitBuffer << (5 - bitCount)) & 0x1f;
      out += base32Alphabet[idx];
    }
    return 'b' + out;
  } catch (e) {
    workerLogger.warn({ deliveryHash, error: serializeError(e) }, 'Failed to reconstruct delivery CID');
    return null;
  }
}
