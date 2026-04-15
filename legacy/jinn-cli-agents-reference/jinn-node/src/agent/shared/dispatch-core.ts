/**
 * Dispatch Core — proxy-only "post to marketplace" logic.
 *
 * Used by agent-initiated dispatch (MCP tools like dispatch_new_job).
 * Always routes through the signing proxy so the agent subprocess
 * never touches private keys.
 *
 * Worker-internal dispatch (e.g. ventureDispatch) should call
 * marketplaceInteract directly — it already holds the keys.
 */

import { buildIpfsPayload, type BuildIpfsPayloadOptions, type BuildIpfsPayloadResult } from './ipfs-payload-builder.js';
import { proxyDispatch } from './signing-proxy-client.js';

export interface DispatchCoreParams extends BuildIpfsPayloadOptions {
  /**
   * Response timeout for marketplace request (seconds). Default 300.
   */
  responseTimeout?: number;

  /**
   * Optional transform applied to ipfsJsonContents[0] before posting.
   * Use this to inject additional context (e.g. ventureContext, outputSpec)
   * without duplicating the build+post flow.
   */
  transformPayload?: (payload: any) => any;
}

export interface DispatchCoreResult {
  /** On-chain request IDs returned by the marketplace */
  requestIds: string[];
  /** The job definition UUID used */
  jobDefinitionId: string;
  /** Raw marketplace result for callers that need extra fields */
  rawResult: any;
  /** IPFS payload build result (includes branchResult, codeMetadata) */
  buildResult: BuildIpfsPayloadResult;
}

/**
 * Build an IPFS payload and post it to the on-chain marketplace via the signing proxy.
 *
 * Requires AGENT_SIGNING_PROXY_URL to be set. Throws if not — there is no
 * fallback to direct credentials. Worker-internal dispatch should call
 * marketplaceInteract directly instead of using this function.
 */
export async function dispatchToMarketplace(params: DispatchCoreParams): Promise<DispatchCoreResult> {
  const { responseTimeout = 300, transformPayload, ...buildOpts } = params;

  if (!process.env.AGENT_SIGNING_PROXY_URL) {
    throw new Error(
      'AGENT_SIGNING_PROXY_URL is not set. ' +
      'dispatch-core is proxy-only — worker-internal dispatch should use marketplaceInteract directly.'
    );
  }

  // 1. Build IPFS payload
  const buildResult = await buildIpfsPayload(buildOpts);
  let { ipfsJsonContents } = buildResult;

  // 2. Apply optional transform (e.g. inject ventureContext)
  if (transformPayload && ipfsJsonContents.length > 0) {
    ipfsJsonContents[0] = transformPayload(ipfsJsonContents[0]);
  }

  // 3. Dispatch through signing proxy — private key never leaves worker process
  const result = await proxyDispatch({
    prompts: [buildOpts.blueprint],
    tools: buildOpts.enabledTools || [],
    ipfsJsonContents,
    postOnly: true,
    responseTimeout,
  });

  // 4. Normalize request IDs
  const rawIds = result?.request_ids ?? result?.requestIds ?? [];
  const requestIds = Array.isArray(rawIds)
    ? rawIds.map((id: any) => String(id))
    : [];

  return {
    requestIds,
    jobDefinitionId: buildOpts.jobDefinitionId,
    rawResult: result,
    buildResult,
  };
}
