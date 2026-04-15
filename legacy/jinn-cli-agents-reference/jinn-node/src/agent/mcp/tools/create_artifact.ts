import { z } from 'zod';
import { pushJsonToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import { buildRegistrationFile, formatCreatorId } from '../../../shared/registry/registration.js';
import { signRegistrationFile } from '../../../shared/registry/signing.js';
import type { DocumentType, ArtifactProfile } from '../../../shared/registry/types.js';
import { getServicePrivateKey, getServiceSafeAddress } from '../../../env/operate-profile.js';
import { createHash } from 'crypto';

export const createArtifactParams = z.object({
  name: z.string().min(1),
  topic: z.string().min(1),
  content: z.string().min(1),
  mimeType: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  idempotencyKey: z.string().min(1).optional(),
});

export const createArtifactSchema = {
  description: `Uploads content to IPFS and returns { cid, contentCid, name, topic, contentPreview }.

MANDATORY USE CASES:
- Research findings and analysis results
- Generated code, configurations, schemas
- Multi-step process outputs and summaries
- Data extractions or transformations
- Any substantial deliverable for parent job review

MEMORY CREATION:
When type='MEMORY', this tool creates a reusable knowledge artifact that will be indexed and made available to all future jobs. Use liberally after discovering solutions, workarounds, or strategies that could benefit other executions.

Parameters:
- name: Descriptive name for the artifact
- topic: Category or subject matter
- content: The actual content to store
- mimeType: (optional) MIME type, defaults to 'text/plain'
- type: (optional) Artifact type (e.g., 'MEMORY', 'RESEARCH_REPORT', 'TEMPLATE_OUTPUT' for the workstream's primary deliverable)
- tags: (optional) Array of descriptive tags for discovery (e.g., ['staking', 'bug-fix', 'optimization'])
- idempotencyKey: (optional) Stable key to deduplicate retries within the same request execution

Execution summaries document process; artifacts persist deliverables. Use create_artifact liberally for all substantial work outputs to ensure discoverability via search_artifacts.`,
  inputSchema: createArtifactParams.shape,
};

type ArtifactResult = {
  cid: string;
  name: string;
  topic: string;
  contentPreview: string;
  type?: string;
  tags?: string[];
};

const artifactDedupeCache = new Map<string, ArtifactResult>();

function getRequestScopedIdempotencyKey(input: {
  name: string;
  topic: string;
  content: string;
  mimeType?: string;
  type?: string;
  tags?: string[];
  idempotencyKey?: string;
}): string {
  const requestId = process.env.JINN_CTX_REQUEST_ID || process.env.JINN_CTX_WORKSTREAM_ID || 'unknown_request';
  const stablePart = input.idempotencyKey
    ? input.idempotencyKey.trim()
    : createHash('sha256')
      .update(JSON.stringify({
        name: input.name,
        topic: input.topic,
        content: input.content,
        mimeType: input.mimeType || 'text/plain',
        type: input.type || '',
        tags: input.tags || [],
      }))
      .digest('hex');
  return `${requestId}:${stablePart}`;
}

export async function createArtifact(args: unknown) {
  try {
    const parsed = createArtifactParams.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message } }) }] };
    }
    const { name, topic, content, mimeType, type, tags, idempotencyKey } = parsed.data;

    const dedupeKey = getRequestScopedIdempotencyKey({ name, topic, content, mimeType, type, tags, idempotencyKey });
    const cached = artifactDedupeCache.get(dedupeKey);
    if (cached) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ data: cached, meta: { ok: true, deduped: true } }) }] };
    }

    const contentPreview = content.slice(0, 100);
    const payload = { name, topic, content, mimeType: mimeType || 'text/plain', type, tags } as const;

    // Step 1: Upload raw content to IPFS
    const [, contentCid] = await pushJsonToIpfs(payload);

    // Step 2: Build Registration File wrapping the content
    // Creator is the service address (Safe multisig) — the on-chain identity of the OLAS service
    const workerAddress = getServiceSafeAddress() || '0x0000000000000000000000000000000000000000';
    const documentType: DocumentType = 'adw:Artifact';
    const profile: ArtifactProfile = {
      topic,
      artifactType: type,
      contentPreview,
    };

    const registration = buildRegistrationFile({
      contentHash: contentCid,
      name,
      documentType,
      creator: formatCreatorId(workerAddress),
      description: `${name} — ${topic}`,
      tags,
      storage: [{
        provider: 'ipfs',
        uri: `ipfs://${contentCid}`,
        gateway: 'https://gateway.autonolas.tech/ipfs/',
      }],
      profile,
    });

    // Step 3: Sign the Registration File (Level 1 trust) if private key available
    const privateKey = getServicePrivateKey();
    if (privateKey) {
      try {
        const trust = await signRegistrationFile(registration, privateKey as `0x${string}`);
        registration.trust = trust;
      } catch {
        // Signing is best-effort — proceed without it (Level 0 trust)
      }
    }

    // Step 4: Upload Registration File to IPFS
    const [, registrationCid] = await pushJsonToIpfs(registration);

    // cid now points to the Registration File; contentCid holds the raw content
    const result = { cid: registrationCid, contentCid, name, topic, contentPreview, type, tags, documentType };
    artifactDedupeCache.set(dedupeKey, result);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ data: result, meta: { ok: true } }) }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'EXECUTION_ERROR', message } }) }] };
  }
}
