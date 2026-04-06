/**
 * GitHub provisioning for x402 gateway
 * Creates blog repos from the jinn-blog template
 */

import { createFromTemplate } from '../../../scripts/shared/github.js';

const TEMPLATE_OWNER = 'Jinn-Network';
const TEMPLATE_REPO = 'jinn-blog';

export interface GitHubProvisionResult {
  repoUrl: string;
  sshUrl: string;
  htmlUrl: string;
  fullName: string;
}

/**
 * Create a new repo from the blog template for a customer
 */
export async function provisionGitHubRepo(
  customerSlug: string
): Promise<GitHubProvisionResult> {
  const result = await createFromTemplate(customerSlug, TEMPLATE_OWNER, TEMPLATE_REPO, {
    description: `Blog for ${customerSlug}`
  });

  return {
    repoUrl: result.repoUrl,
    sshUrl: result.sshUrl,
    htmlUrl: result.htmlUrl,
    fullName: result.fullName,
  };
}
