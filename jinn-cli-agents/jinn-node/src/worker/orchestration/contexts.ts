/**
 * Construct job-specific context objects (request + metadata)
 */

import type { UnclaimedRequest, IpfsMetadata, JobContext } from '../types.js';

/**
 * Build job context from request and metadata
 */
export function buildJobContext(
  request: UnclaimedRequest,
  metadata: IpfsMetadata,
  workerAddress: string
): JobContext {
  return {
    requestId: request.id,
    request,
    metadata,
    workerAddress,
  };
}




