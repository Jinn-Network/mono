/**
 * Provisioning orchestrator for x402 gateway
 * Handles $provision sentinel detection and resource provisioning
 */

import { provisionGitHubRepo, type GitHubProvisionResult } from './github.js';
import { provisionRailwayService, setRailwayServiceVariables, type RailwayProvisionResult } from './railway.js';
import { provisionUmamiWebsite, type UmamiProvisionResult } from './umami.js';
import { findCustomer, saveCustomer, slugify, type CustomerRecord } from './customers.js';

export { slugify, findCustomer } from './customers.js';

export interface ProvisioningResult {
  enrichedInput: Record<string, any>;
  customer: CustomerRecord;
  provisioned: {
    github?: GitHubProvisionResult;
    railway?: RailwayProvisionResult;
    umami?: UmamiProvisionResult;
  };
}

/**
 * Detect which fields need provisioning based on $provision default values
 */
export function detectProvisioningNeeded(
  input: Record<string, any>,
  inputSchema: Record<string, any>
): string[] {
  const properties = inputSchema?.properties || {};
  return Object.entries(properties)
    .filter(([field, spec]: [string, any]) => {
      // Field needs provisioning if:
      // 1. Schema has default: "$provision"
      // 2. User didn't provide a value (or provided empty string or literal "$provision")
      const value = input[field];
      const isEmpty = !value || value === '$provision';
      return spec.default === '$provision' && isEmpty;
    })
    .map(([field]) => field);
}

/**
 * Check if provisioning environment variables are configured
 */
export function checkProvisioningEnv(): { configured: boolean; missing: string[] } {
  const required = [
    'GITHUB_TOKEN',
    'RAILWAY_API_TOKEN',
    // Note: No BLOG_RAILWAY_PROJECT_ID - we create per-workstream projects now
    'UMAMI_HOST',
    'UMAMI_USERNAME',
    'UMAMI_PASSWORD',
  ];

  const missing = required.filter((key) => !process.env[key]);
  return {
    configured: missing.length === 0,
    missing,
  };
}

/**
 * Execute provisioning pipeline for required fields
 * Order matters due to dependencies:
 * 1. GitHub -> returns repoUrl (needed by Railway)
 * 2. Railway -> returns domain (needed by Umami)
 * 3. Umami -> returns websiteId
 */
export async function executeProvisioning(
  input: Record<string, any>,
  fieldsToProvision: string[],
  blogName: string
): Promise<ProvisioningResult> {
  const customerSlug = slugify(blogName);
  const now = new Date().toISOString();

  // Initialize customer record
  const customer: Partial<CustomerRecord> = {
    displayName: blogName,
    status: 'provisioning',
    createdAt: now,
  };

  const provisioned: ProvisioningResult['provisioned'] = {};
  const enrichedInput = { ...input };

  try {
    // Phase 1: GitHub (if repoUrl needs provisioning)
    if (fieldsToProvision.includes('repoUrl')) {
      console.log(`[provision] Phase 1: Provisioning GitHub repo for ${customerSlug}...`);
      const result = await provisionGitHubRepo(customerSlug);
      provisioned.github = result;
      customer.repo = result.fullName;
      customer.sshUrl = result.sshUrl;
      enrichedInput.repoUrl = result.fullName;
    }

    // Phase 2: Railway (if domain needs provisioning, requires repoUrl)
    if (fieldsToProvision.includes('domain')) {
      const repoFullName = customer.repo || enrichedInput.repoUrl;
      if (!repoFullName) {
        throw new Error('Railway provisioning requires repoUrl - either provide it or include repoUrl in $provision fields');
      }
      console.log(`[provision] Phase 2: Provisioning Railway service for ${customerSlug}...`);
      const result = await provisionRailwayService(customerSlug, repoFullName);
      provisioned.railway = result;
      customer.railwayServiceId = result.serviceId;
      customer.domain = result.domain;
      enrichedInput.domain = result.domain;
    }

    // Phase 3: Umami (if umamiWebsiteId needs provisioning, requires domain)
    if (fieldsToProvision.includes('umamiWebsiteId')) {
      const domain = customer.domain || enrichedInput.domain;
      if (!domain) {
        throw new Error('Umami provisioning requires domain - either provide it or include domain in $provision fields');
      }
      console.log(`[provision] Phase 3: Provisioning Umami website for ${customerSlug}...`);
      const result = await provisionUmamiWebsite(blogName, domain);
      provisioned.umami = result;
      customer.umamiWebsiteId = result.websiteId;
      enrichedInput.umamiWebsiteId = result.websiteId;
    }

    // Phase 3.5: Configure Railway env vars for Umami tracking
    if (provisioned.railway && provisioned.umami) {
      console.log(`[provision] Phase 3.5: Configuring Umami tracking env vars...`);
      const umamiHost = process.env.UMAMI_HOST;
      if (umamiHost) {
        await setRailwayServiceVariables(
          provisioned.railway.projectId,
          provisioned.railway.serviceId,
          provisioned.railway.environmentId,
          {
            NEXT_PUBLIC_UMAMI_ID: provisioned.umami.websiteId,
            NEXT_PUBLIC_UMAMI_SRC: `https://${umamiHost}/script.js`,
          }
        );
      }
    }

    // Mark as active
    customer.status = 'active';
    console.log(`[provision] All provisioning complete for ${customerSlug}`);

  } catch (error: any) {
    // Save partial result for recovery
    customer.status = 'partial';
    customer.errorMessage = error.message;

    // Determine which phase failed
    if (!provisioned.github && fieldsToProvision.includes('repoUrl')) {
      customer.errorPhase = 'github';
    } else if (!provisioned.railway && fieldsToProvision.includes('domain')) {
      customer.errorPhase = 'railway';
    } else if (!provisioned.umami && fieldsToProvision.includes('umamiWebsiteId')) {
      customer.errorPhase = 'umami';
    }

    // Save partial record for manual recovery
    await saveCustomer(customerSlug, customer as CustomerRecord);
    console.error(`[provision] Provisioning failed at phase ${customer.errorPhase}: ${error.message}`);

    throw error;
  }

  return {
    enrichedInput,
    customer: customer as CustomerRecord,
    provisioned,
  };
}

/**
 * Main entry point: handle provisioning for a template execution
 * Returns the enriched input with provisioned values filled in
 */
export async function handleProvisioning(
  input: Record<string, any>,
  inputSchema: Record<string, any>
): Promise<Record<string, any>> {
  // Detect which fields need provisioning
  const fieldsToProvision = detectProvisioningNeeded(input, inputSchema);

  if (fieldsToProvision.length === 0) {
    // No provisioning needed
    return input;
  }

  console.log(`[provision] Fields to provision: ${fieldsToProvision.join(', ')}`);

  // Check env vars
  const envCheck = checkProvisioningEnv();
  if (!envCheck.configured) {
    throw new Error(
      `Provisioning requested but environment not configured. Missing: ${envCheck.missing.join(', ')}`
    );
  }

  // Get blogName for slug derivation
  const blogName = input.blogName;
  if (!blogName) {
    throw new Error('blogName is required for provisioning (used to derive customer slug)');
  }

  const customerSlug = slugify(blogName);

  // Check if customer already exists (idempotent)
  const existing = await findCustomer(customerSlug);
  if (existing?.status === 'active') {
    console.log(`[provision] Customer ${customerSlug} already provisioned, using existing values`);
    return {
      ...input,
      repoUrl: input.repoUrl || existing.repo,
      domain: input.domain || existing.domain,
      umamiWebsiteId: input.umamiWebsiteId || existing.umamiWebsiteId,
    };
  }

  // Execute provisioning pipeline
  const { enrichedInput, customer } = await executeProvisioning(
    input,
    fieldsToProvision,
    blogName
  );

  // Save customer record
  await saveCustomer(customerSlug, customer);

  return enrichedInput;
}
