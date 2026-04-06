/**
 * Workstream Creator Job
 *
 * Runs every 3 hours to convert top-voted wishes into Jinn workstream templates.
 * Takes the most upvoted unfulfilled wish with 5+ upvotes and creates a template.
 */

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logging/index.js';
import {
  getRequiredSupabaseUrl,
  getRequiredSupabaseServiceRoleKey,
} from '../../config/index.js';

interface WishlistWish {
  id: string;
  intent: string;
  context: Record<string, unknown>;
  wallet_address: string;
  upvotes: number;
  category: string | null;
}

interface WorkstreamBlueprint {
  id: string;
  name: string;
  description: string;
  tags: string[];
  input_schema: Record<string, unknown>;
  output_spec: Record<string, unknown>;
  enabled_tools_policy: string[];
  x402_price: number;
  safety_tier: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface WorkstreamCreatorResult {
  processed: boolean;
  workstreamId?: string;
  wishId?: string;
  reason?: string;
  error?: string;
}

/**
 * Design a workstream blueprint from a wish intent using Claude
 */
async function designWorkstreamFromIntent(
  anthropic: Anthropic,
  wish: WishlistWish
): Promise<WorkstreamBlueprint> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: `You are a Jinn workstream designer. Given a user intent, design a workstream blueprint that can be executed via the x402 Gateway.

Your output must be valid JSON with the following structure:
{
  "id": "kebab-case-id",
  "name": "Human Readable Name",
  "description": "What this workstream does",
  "tags": ["tag1", "tag2"],
  "input_schema": {
    "type": "object",
    "properties": {
      "param_name": {
        "type": "string",
        "description": "What this parameter is for"
      }
    },
    "required": ["param_name"]
  },
  "output_spec": {
    "type": "object",
    "properties": {
      "result": {
        "type": "string",
        "description": "The output of the workstream"
      }
    }
  },
  "enabled_tools_policy": ["web_search", "read_file", "write_file"],
  "x402_price": 0,
  "safety_tier": "public"
}

Guidelines:
- The id should be descriptive and unique (kebab-case)
- The name should be short and clear
- The description should explain what the workstream accomplishes
- Input schema should define all required parameters
- Output spec should define what the workstream returns
- enabled_tools_policy should list MCP tools needed (common: web_search, read_file, write_file, execute_code, fetch_url)
- safety_tier should be "public" unless shell access is needed (then "private")
- x402_price should be 0 for now (pricing determined later)`,
    messages: [
      {
        role: 'user',
        content: `Design a Jinn workstream for this intent:

Intent: ${wish.intent}
Category: ${wish.category || 'general'}
Context: ${JSON.stringify(wish.context || {})}

Return only valid JSON, no markdown code blocks.`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Expected text response from Claude');
  }

  // Parse the JSON response, handling potential markdown code blocks
  let jsonText = content.text.trim();
  if (jsonText.startsWith('```json')) {
    jsonText = jsonText.slice(7);
  }
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.slice(3);
  }
  if (jsonText.endsWith('```')) {
    jsonText = jsonText.slice(0, -3);
  }
  jsonText = jsonText.trim();

  const workstream = JSON.parse(jsonText) as Partial<WorkstreamBlueprint>;

  // Ensure required fields
  const now = new Date().toISOString();
  return {
    id: workstream.id || `wish-${wish.id.slice(0, 8)}`,
    name: workstream.name || wish.intent.slice(0, 50),
    description: workstream.description || wish.intent,
    tags: workstream.tags || [],
    input_schema: workstream.input_schema || {},
    output_spec: workstream.output_spec || {},
    enabled_tools_policy: workstream.enabled_tools_policy || [],
    x402_price: workstream.x402_price || 0,
    safety_tier: workstream.safety_tier || 'public',
    status: 'visible',
    created_at: now,
    updated_at: now,
  };
}

/**
 * Run the workstream creator job
 *
 * Finds the top unfulfilled wish with 5+ upvotes and creates a workstream template for it.
 */
export async function runWorkstreamCreator(
  supabase: ReturnType<typeof createClient>
): Promise<WorkstreamCreatorResult> {
  logger.info('[WorkstreamCreator] Starting run...');

  // Check if Anthropic API key is available
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('[WorkstreamCreator] ANTHROPIC_API_KEY not set, skipping');
    return { processed: false, reason: 'no_api_key' };
  }

  const anthropic = new Anthropic({ apiKey });

  // 1. Fetch top unfulfilled wish with 5+ upvotes
  const { data: wish, error } = await supabase
    .from('wishlist_wishes')
    .select('*')
    .eq('status', 'pending')
    .gte('upvotes', 5)
    .order('upvotes', { ascending: false })
    .limit(1)
    .single();

  if (error || !wish) {
    logger.info('[WorkstreamCreator] No wishes ready for conversion');
    return { processed: false, reason: 'no_eligible_wishes' };
  }

  logger.info(
    { wishId: wish.id, upvotes: wish.upvotes, intent: wish.intent.slice(0, 100) },
    '[WorkstreamCreator] Found eligible wish'
  );

  // 2. Mark as processing
  const { error: updateErr } = await supabase
    .from('wishlist_wishes')
    .update({ status: 'processing' })
    .eq('id', wish.id);

  if (updateErr) {
    logger.error({ error: updateErr.message }, '[WorkstreamCreator] Failed to mark wish as processing');
    return { processed: false, reason: 'update_failed', error: updateErr.message };
  }

  try {
    // 3. Use Claude to design workstream blueprint from intent
    const workstream = await designWorkstreamFromIntent(anthropic, wish as WishlistWish);

    logger.info(
      { workstreamId: workstream.id, name: workstream.name },
      '[WorkstreamCreator] Designed workstream'
    );

    // 4. Insert into job_templates (workstream catalog)
    const { error: insertError } = await supabase.from('job_templates').insert({
      id: workstream.id,
      name: workstream.name,
      description: workstream.description,
      tags: workstream.tags,
      input_schema: workstream.input_schema,
      output_spec: workstream.output_spec,
      enabled_tools_policy: workstream.enabled_tools_policy,
      x402_price: workstream.x402_price,
      safety_tier: workstream.safety_tier,
      status: workstream.status,
    });

    if (insertError) {
      // If duplicate ID, generate a unique one
      if (insertError.code === '23505') {
        const uniqueId = `${workstream.id}-${Date.now()}`;
        const { error: retryError } = await supabase.from('job_templates').insert({
          ...workstream,
          id: uniqueId,
        });
        if (retryError) throw retryError;
        workstream.id = uniqueId;
      } else {
        throw insertError;
      }
    }

    // 5. Mark wish as fulfilled
    const { error: fulfillError } = await supabase
      .from('wishlist_wishes')
      .update({
        status: 'fulfilled',
        fulfilled_by: workstream.id,
        fulfilled_at: new Date().toISOString(),
      })
      .eq('id', wish.id);

    if (fulfillError) {
      logger.error({ error: fulfillError.message }, '[WorkstreamCreator] Failed to mark wish as fulfilled');
    }

    // 6. Award 50 points to the wish creator
    await supabase.from('wishlist_points').insert({
      wallet_address: wish.wallet_address,
      reason: 'fulfilled',
      points: 50,
      wish_id: wish.id,
    });

    // 7. Update wallet total points
    const { data: wallet } = await supabase
      .from('wishlist_wallets')
      .select('total_points')
      .eq('address', wish.wallet_address)
      .single();

    if (wallet) {
      await supabase
        .from('wishlist_wallets')
        .update({ total_points: (wallet.total_points || 0) + 50 })
        .eq('address', wish.wallet_address);
    }

    logger.info(
      { workstreamId: workstream.id, wishId: wish.id },
      '[WorkstreamCreator] Successfully created workstream from wish'
    );

    return {
      processed: true,
      workstreamId: workstream.id,
      wishId: wish.id,
    };
  } catch (err) {
    // Rollback status on failure
    await supabase
      .from('wishlist_wishes')
      .update({ status: 'pending' })
      .eq('id', wish.id);

    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMessage, wishId: wish.id }, '[WorkstreamCreator] Failed to create workstream');

    return {
      processed: false,
      reason: 'creation_failed',
      error: errorMessage,
    };
  }
}

/**
 * Start the workstream creator scheduler
 *
 * Runs immediately on startup, then every 3 hours.
 */
export function startWorkstreamCreator(supabase: ReturnType<typeof createClient>): void {
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
  const enabled = process.env.WORKSTREAM_CREATOR_ENABLED !== 'false';

  if (!enabled) {
    logger.info('[WorkstreamCreator] Disabled via WORKSTREAM_CREATOR_ENABLED=false');
    return;
  }

  logger.info('[WorkstreamCreator] Scheduled (runs every 3 hours)');

  // Run once on startup
  runWorkstreamCreator(supabase).catch((err) => {
    logger.error({ error: err.message }, '[WorkstreamCreator] Startup run failed');
  });

  // Schedule to run every 3 hours
  setInterval(() => {
    runWorkstreamCreator(supabase).catch((err) => {
      logger.error({ error: err.message }, '[WorkstreamCreator] Scheduled run failed');
    });
  }, THREE_HOURS_MS);
}
