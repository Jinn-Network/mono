/**
 * IPFS metadata fetching and enrichment
 */

import { workerLogger } from '../../logging/index.js';
import type { IpfsMetadata } from '../types.js';
import { config } from '../../config/index.js';

function buildIpfsHashCandidates(ipfsHash: string): string[] {
  const hash = ipfsHash.toLowerCase();

  // Some request payloads are indexed as dag-pb (f01701220...) but stored as raw (f01551220...).
  // Try raw first for this case to avoid consistent gateway 500s on protobuf decode.
  if (hash.startsWith('f01701220') && hash.length > 9) {
    const digest = hash.slice(9);
    return [`f01551220${digest}`, hash];
  }

  if (hash.startsWith('f01551220') && hash.length > 9) {
    const digest = hash.slice(9);
    return [hash, `f01701220${digest}`];
  }

  return [hash];
}

/**
 * Fetch IPFS metadata from gateway
 */
export async function fetchIpfsMetadata(ipfsHash?: string): Promise<IpfsMetadata | null> {
  if (!ipfsHash) return null;
  try {
    const hash = String(ipfsHash).replace(/^0x/, '').toLowerCase();
    const hashCandidates = buildIpfsHashCandidates(hash);
    // Use configured IPFS gateway or fallback to Autonolas
    const gatewayBase = config.services.ipfsGatewayUrl || 'https://gateway.autonolas.tech/ipfs/';
    const timeoutMs = config.services.ipfsFetchTimeoutMs ?? 7000;
    let json: any = null;

    for (let i = 0; i < hashCandidates.length; i += 1) {
      const candidate = hashCandidates[i];
      const url = gatewayBase.endsWith('/') ? `${gatewayBase}${candidate}` : `${gatewayBase}/${candidate}`;

      workerLogger.info(
        { url, hash, candidate, timeout: timeoutMs, attempt: i + 1, maxAttempts: hashCandidates.length },
        'Fetching IPFS metadata'
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        workerLogger.info(
          { status: res.status, statusText: res.statusText, candidate, attempt: i + 1 },
          'IPFS fetch response'
        );

        if (!res.ok) {
          workerLogger.warn(
            { status: res.status, statusText: res.statusText, url, candidate, attempt: i + 1 },
            'IPFS fetch returned non-OK status'
          );
          continue;
        }

        json = await res.json();
        if (candidate !== hash) {
          workerLogger.info({ requestedHash: hash, resolvedHash: candidate }, 'Resolved request metadata via CID codec fallback');
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }

    if (!json) {
      return null;
    }

    // Blueprint is at root level (new architecture)
    // Fall back to additionalContext.blueprint for backward compatibility
    // Fall back to prompt for legacy jobs
    const blueprint = json?.blueprint
      ? String(json.blueprint)
      : (json?.additionalContext?.blueprint
        ? String(json.additionalContext.blueprint)
        : (json?.prompt || json?.input || undefined));

    const enabledTools = Array.isArray(json?.enabledTools) ? json.enabledTools : undefined;
    const tools = Array.isArray(json?.tools) ? json.tools : undefined;
    const sourceRequestId = json?.sourceRequestId ? String(json.sourceRequestId) : undefined;
    const sourceJobDefinitionId = json?.sourceJobDefinitionId ? String(json.sourceJobDefinitionId) : undefined;
    const workstreamId = json?.workstreamId ? String(json.workstreamId) : undefined;
    const additionalContext = json?.additionalContext || undefined;
    const jobName = json?.jobName ? String(json.jobName) : undefined;
    const jobDefinitionId = json?.jobDefinitionId ? String(json.jobDefinitionId) : undefined;
    const codeMetadata = json?.codeMetadata && typeof json.codeMetadata === 'object'
      ? (json.codeMetadata as any)
      : undefined;
    const model = json?.model ? String(json.model) : undefined;
    const dependencies = Array.isArray(json?.dependencies)
      ? json.dependencies
      : (Array.isArray(json?.additionalContext?.dependencies)
        ? json.additionalContext.dependencies
        : undefined);
    const lineage = json?.lineage && typeof json.lineage === 'object'
      ? {
        dispatcherRequestId: json.lineage.dispatcherRequestId ? String(json.lineage.dispatcherRequestId) : undefined,
        dispatcherJobDefinitionId: json.lineage.dispatcherJobDefinitionId ? String(json.lineage.dispatcherJobDefinitionId) : undefined,
        parentDispatcherRequestId: json.lineage.parentDispatcherRequestId ? String(json.lineage.parentDispatcherRequestId) : undefined,
        dispatcherBranchName: json.lineage.dispatcherBranchName ? String(json.lineage.dispatcherBranchName) : undefined,
        dispatcherBaseBranch: json.lineage.dispatcherBaseBranch ? String(json.lineage.dispatcherBaseBranch) : undefined,
      }
      : undefined;

    // Venture ID for venture lineage propagation
    const ventureId = json?.ventureId ? String(json.ventureId) : undefined;

    // Template ID for tracking x402 template executions
    const templateId = json?.templateId ? String(json.templateId) : undefined;

    // OutputSpec for structured result extraction (passthrough from x402 gateway)
    const outputSpec = json?.outputSpec && typeof json.outputSpec === 'object'
      ? json.outputSpec
      : undefined;

    // Cyclic flag for continuous operation
    const cyclic = json?.cyclic === true;

    return {
      blueprint,
      enabledTools,
      tools,
      sourceRequestId,
      sourceJobDefinitionId,
      workstreamId,
      additionalContext,
      jobName,
      jobDefinitionId,
      codeMetadata,
      model,
      dependencies,
      ventureId,
      lineage,
      templateId,
      outputSpec,
      cyclic,
    };
  } catch (e: any) {
    workerLogger.warn({ error: e?.message || String(e) }, 'Failed to fetch IPFS metadata; proceeding without it');
    return null;
  }
}
