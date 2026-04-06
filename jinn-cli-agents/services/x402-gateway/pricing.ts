/**
 * Pricing: Compute template price from historical runs
 * 
 * Strategy:
 * 1. Query historical deliveries for the template's canonical job definition
 * 2. Calculate average deliveryRate from recent runs
 * 3. Add fixed compute margin (for LLM costs not captured in deliveryRate)
 * 4. Return price in wei
 * 
 * Budget cap:
 * - Callers can specify a budget cap in the execute request
 * - If estimated cost > cap, execution is refused
 * - Budget is propagated to additionalContext for worker awareness
 */

// Fixed compute margin to add on top of deliveryRate (in wei)
// This covers LLM inference costs not captured in on-chain delivery rate
// 0.0001 ETH = ~$0.30 at $3000/ETH
const COMPUTE_MARGIN_WEI = BigInt('100000000000000'); // 0.0001 ETH

// Minimum price for templates without historical data (in wei)
// 0.0005 ETH = ~$1.50 at $3000/ETH
const MIN_PRICE_WEI = BigInt('500000000000000'); // 0.0005 ETH

// Maximum historical runs to consider for pricing
const MAX_HISTORICAL_RUNS = 10;

interface DeliveryRecord {
  deliveryRate: string | bigint;
  blockTimestamp: string | bigint;
}

/**
 * Compute price for a template based on historical delivery rates.
 * 
 * @param ponderUrl - Ponder GraphQL endpoint
 * @param canonicalJobDefinitionId - Job definition ID to query history for
 * @returns Price in wei as string
 */
export async function computeTemplatePrice(
  ponderUrl: string,
  canonicalJobDefinitionId?: string | null
): Promise<string> {
  if (!canonicalJobDefinitionId) {
    // No historical data, use minimum price
    return MIN_PRICE_WEI.toString();
  }

  try {
    // Query recent deliveries for this job definition
    const query = `
      query ($jobDefId: String!, $limit: Int!) {
        deliveries(
          where: { sourceJobDefinitionId: $jobDefId }
          orderBy: "blockTimestamp"
          orderDirection: "desc"
          limit: $limit
        ) {
          items {
            deliveryRate
            blockTimestamp
          }
        }
      }
    `;

    const res = await fetch(ponderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { jobDefId: canonicalJobDefinitionId, limit: MAX_HISTORICAL_RUNS },
      }),
    });

    const data = await res.json() as { 
      data?: { deliveries?: { items?: DeliveryRecord[] } } 
    };

    const deliveries = data?.data?.deliveries?.items || [];

    if (deliveries.length === 0) {
      // No historical data, use minimum price
      return MIN_PRICE_WEI.toString();
    }

    // Calculate average delivery rate
    const totalRate = deliveries.reduce((sum, d) => {
      return sum + BigInt(d.deliveryRate || 0);
    }, BigInt(0));

    const avgRate = totalRate / BigInt(deliveries.length);

    // Add compute margin
    const price = avgRate + COMPUTE_MARGIN_WEI;

    // Ensure minimum price
    return (price < MIN_PRICE_WEI ? MIN_PRICE_WEI : price).toString();

  } catch (error) {
    console.error('Failed to compute template price:', error);
    // On error, use minimum price
    return MIN_PRICE_WEI.toString();
  }
}

/**
 * Validate caller budget against estimated cost.
 * 
 * @param callerBudget - Caller's budget cap in wei (string)
 * @param estimatedCost - Estimated cost in wei (string)
 * @returns Object with valid flag and message
 */
export function validateBudget(
  callerBudget: string | undefined,
  estimatedCost: string
): { valid: boolean; message?: string } {
  if (!callerBudget) {
    // No budget cap specified, allow execution
    return { valid: true };
  }

  try {
    const budget = BigInt(callerBudget);
    const cost = BigInt(estimatedCost);

    if (cost > budget) {
      return {
        valid: false,
        message: `Estimated cost (${formatWei(cost)}) exceeds budget cap (${formatWei(budget)})`,
      };
    }

    return { valid: true };
  } catch {
    return {
      valid: false,
      message: 'Invalid budget format (must be wei string)',
    };
  }
}

/**
 * Format wei amount to human-readable string.
 */
export function formatWei(wei: bigint | string): string {
  const w = BigInt(wei);
  
  // ETH (>= 0.001 ETH)
  if (w >= BigInt('1000000000000000')) {
    const eth = Number(w) / 1e18;
    return `${eth.toFixed(4)} ETH`;
  }
  
  // Gwei (>= 1 gwei)
  if (w >= BigInt('1000000000')) {
    const gwei = Number(w) / 1e9;
    return `${gwei.toFixed(2)} gwei`;
  }
  
  return `${w} wei`;
}

/**
 * Update template price in database based on historical runs.
 * Called periodically or after job completion.
 * 
 * @param supabase - Supabase client
 * @param ponderUrl - Ponder GraphQL endpoint
 * @param templateId - Template ID to update
 */
export async function updateTemplatePricing(
  supabase: any,
  ponderUrl: string,
  templateId: string
): Promise<void> {
  // Fetch template to get canonical job definition ID
  const { data: template, error: templateError } = await supabase
    .from('job_templates')
    .select('canonical_job_definition_id')
    .eq('id', templateId)
    .maybeSingle();

  if (templateError || !template) {
    console.error('Failed to fetch template for pricing update:', templateError);
    return;
  }

  // Compute new price
  const newPrice = await computeTemplatePrice(ponderUrl, template.canonical_job_definition_id);

  // Update template
  const { error: updateError } = await supabase
    .from('job_templates')
    .update({ x402_price: newPrice })
    .eq('id', templateId);

  if (updateError) {
    console.error('Failed to update template price:', updateError);
  }
}

