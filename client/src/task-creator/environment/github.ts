// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod/v3';
import type { VerifiedInputPublicationFacts } from './policy.js';

/** Injectable boundary; tests supply a deterministic in-memory implementation. */
export type GitHubFetch = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type GitHubRepositoryPublicationCheckRequest = {
  repo: string;
  baseCommit: string;
};

export interface GitHubRepositoryChecker {
  check(input: GitHubRepositoryPublicationCheckRequest): Promise<VerifiedInputPublicationFacts>;
}

const CheckRequestSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();
const RepositoryMetadataSchema = z.object({
  visibility: z.enum(['public', 'private']),
  private: z.boolean(),
}).passthrough();
const LicenseEvidenceSchema = z.object({
  license: z.object({ spdx_id: z.string().min(1).nullable() }).nullable(),
}).passthrough();

/**
 * Reads only public GitHub metadata and the licence endpoint at the requested
 * base commit. The returned evidence is bound to the canonical GitHub input
 * locator so a decision for one repository cannot be reused for another.
 */
export function createGitHubRepoPublicationChecker(input: {
  fetchImpl: GitHubFetch;
  token?: string;
}): GitHubRepositoryChecker {
  const headers = {
    Accept: 'application/vnd.github+json',
    ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
  };

  return {
    async check(rawRequest: GitHubRepositoryPublicationCheckRequest): Promise<VerifiedInputPublicationFacts> {
      const request = CheckRequestSchema.parse(rawRequest);
      const repositoryUrl = `https://api.github.com/repos/${request.repo}`;
      const metadata = RepositoryMetadataSchema.safeParse(await fetchJson(input.fetchImpl, repositoryUrl, headers, 'repository metadata'));
      if (!metadata.success || metadata.data.private === (metadata.data.visibility === 'public')) {
        throw new Error('malformed GitHub repository metadata response');
      }

      const evidenceRef = `${repositoryUrl}/license?ref=${request.baseCommit}`;
      const license = LicenseEvidenceSchema.safeParse(await fetchJson(input.fetchImpl, evidenceRef, headers, 'license evidence'));
      if (!license.success) throw new Error('malformed GitHub license evidence response');

      return {
        inputRef: `git+https://github.com/${request.repo}.git#${request.baseCommit}`,
        locator: `github:${request.repo}`,
        visibility: metadata.data.visibility,
        licenseSpdxId: license.data.license?.spdx_id ?? null,
        evidenceRef,
      };
    },
  };
}

async function fetchJson(
  fetchImpl: GitHubFetch,
  url: string,
  headers: Record<string, string>,
  resource: string,
): Promise<unknown> {
  let response: Awaited<ReturnType<GitHubFetch>>;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new Error(`GitHub ${resource} request failed: ${message(error)}`);
  }
  if (!response || response.ok !== true) {
    throw new Error(`GitHub ${resource} request failed (status ${String(response?.status)})`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`malformed GitHub ${resource} response: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
