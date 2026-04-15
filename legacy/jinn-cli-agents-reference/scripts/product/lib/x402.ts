/**
 * x402 Gateway Helper
 * 
 * Calls the x402 gateway API to execute templates.
 */

const X402_GATEWAY_URL = process.env.X402_GATEWAY_URL || 'https://x402-gateway-production.up.railway.app';

/**
 * Flat input schema for blog-growth template.
 * All fields are top-level for simple variable substitution.
 */
interface BlogGrowthInput {
    blogName: string;
    mission: string;
    strategy?: string;
    sources?: string[];
    referrals?: string;
    umamiWebsiteId: string;
    repoUrl: string;
    baseBranch?: string;
    domain?: string;
}

interface ExecuteResult {
    requestId: string;
    jobDefinitionId: string;
    templateId: string;
    statusUrl: string;
    resultUrl: string;
    explorerUrl: string;
}

/**
 * Execute a template via the x402 gateway.
 * 
 * For now, payment verification is not enforced (hackathon v0).
 * In production, caller would need to include x402 payment proof.
 */
export async function executeTemplate(
    templateId: string,
    input: BlogGrowthInput,
    options: { dryRun?: boolean } = {}
): Promise<ExecuteResult> {
    if (options.dryRun) {
        console.log(`[DRY RUN] Would call x402 gateway:`);
        console.log(`[DRY RUN]   POST ${X402_GATEWAY_URL}/templates/${templateId}/execute`);
        console.log(`[DRY RUN]   Input: ${JSON.stringify(input, null, 2)}`);
        return {
            requestId: 'dry-run-request-id',
            jobDefinitionId: 'dry-run-job-def-id',
            templateId,
            statusUrl: `${X402_GATEWAY_URL}/runs/dry-run/status`,
            resultUrl: `${X402_GATEWAY_URL}/runs/dry-run/result`,
            explorerUrl: 'https://explorer.jinn.network/requests/dry-run',
        };
    }

    const url = `${X402_GATEWAY_URL}/templates/${templateId}/execute`;

    console.log(`Calling x402 gateway: POST ${url}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(`x402 gateway error: ${error.error || response.statusText}`);
    }

    const result = await response.json() as ExecuteResult;
    return result;
}

/**
 * Get template details from x402 gateway.
 */
export async function getTemplate(templateId: string): Promise<any> {
    const url = `${X402_GATEWAY_URL}/templates/${templateId}`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Template not found: ${templateId}`);
    }

    return response.json();
}

/**
 * Check run status.
 */
export async function getRunStatus(requestId: string): Promise<{ status: string; jobName?: string }> {
    const url = `${X402_GATEWAY_URL}/runs/${requestId}/status`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Status check failed: ${response.statusText}`);
    }

    return response.json();
}
