import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { getSupabase } from './shared/supabase.js';

/**
 * Input schema for minting a venture.
 */
export const ventureMintParams = z.object({
  name: z.string().min(1).describe('Venture name'),
  slug: z.string().optional().describe('URL-friendly slug (auto-generated if not provided)'),
  description: z.string().optional().describe('Venture description'),
  ownerAddress: z.string().min(1).describe('Ethereum address of the venture owner'),
  blueprint: z.string().describe('Blueprint JSON string with invariants array'),
  rootWorkstreamId: z.string().optional().describe('Workstream ID for the venture'),
  rootJobInstanceId: z.string().optional().describe('Optional root job instance ID'),
  status: z.enum(['active', 'paused', 'archived']).optional().default('active').describe('Venture status'),
  tokenAddress: z.string().optional().describe('Token contract address on Base'),
  tokenSymbol: z.string().optional().describe('Token symbol (e.g., GROWTH)'),
  tokenName: z.string().optional().describe('Token display name'),
  stakingContractAddress: z.string().optional().describe('Staking contract address'),
  tokenLaunchPlatform: z.string().optional().describe('Token launch platform (e.g., doppler)'),
  tokenMetadata: z.string().optional().describe('Platform-specific metadata JSON string (e.g., poolId, curves, safeAddress)'),
  governanceAddress: z.string().optional().describe('Governance contract address'),
  poolAddress: z.string().optional().describe('Liquidity pool address'),
});

export type VentureMintParams = z.infer<typeof ventureMintParams>;

export const ventureMintSchema = {
  description: `Create a new venture with a blueprint defining its invariants.

A venture is a persistent project entity that owns workstreams and services. Each venture has:
- A blueprint containing invariants (success criteria)
- An owner address (Ethereum address)
- Optional workstream and job instance associations
- Optional token fields for venture-specific tokens (launched via Doppler or other platforms)

PREREQUISITES:
- Have a valid blueprint with invariants array
- Know the owner's Ethereum address

Parameters:
- name: Venture name (required)
- ownerAddress: Ethereum address of the owner (required)
- blueprint: JSON string with invariants array (required)
- slug: URL-friendly identifier (auto-generated from name if not provided)
- description: Venture description
- rootWorkstreamId: Associated workstream ID
- rootJobInstanceId: Associated root job instance
- status: 'active', 'paused', or 'archived'
- tokenAddress: Token contract address on Base
- tokenSymbol: Token symbol (e.g., GROWTH)
- tokenName: Token display name
- stakingContractAddress: Staking contract address
- tokenLaunchPlatform: Launch platform (e.g., doppler)
- tokenMetadata: Platform-specific metadata JSON string
- governanceAddress: Governance contract address
- poolAddress: Liquidity pool address

Returns: { venture: { id, name, slug, ... } }`,
  inputSchema: ventureMintParams.shape,
};

/**
 * Mint (create) a new venture.
 * Delegates to the script function which handles all Supabase operations.
 */
export async function ventureMint(args: unknown) {
  try {
    const parsed = ventureMintParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message }
          })
        }]
      };
    }

    const {
      name,
      slug,
      description,
      ownerAddress,
      blueprint,
      rootWorkstreamId,
      rootJobInstanceId,
      status,
      tokenAddress,
      tokenSymbol,
      tokenName,
      stakingContractAddress,
      tokenLaunchPlatform,
      tokenMetadata,
      governanceAddress,
      poolAddress,
    } = parsed.data;

    // Parse blueprint JSON
    const blueprintObj = typeof blueprint === 'string' ? JSON.parse(blueprint) : blueprint;
    if (!blueprintObj.invariants || !Array.isArray(blueprintObj.invariants)) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: 'Blueprint must contain an "invariants" array' }
          })
        }]
      };
    }

    // Generate slug if not provided
    const ventureSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const supabase = await getSupabase();
    const { data: venture, error } = await supabase
      .from('ventures')
      .insert({
        name,
        slug: ventureSlug,
        description: description || null,
        owner_address: ownerAddress,
        blueprint: blueprintObj,
        root_workstream_id: rootWorkstreamId || null,
        root_job_instance_id: rootJobInstanceId || null,
        status: status || 'active',
        ...(tokenAddress && { token_address: tokenAddress }),
        ...(tokenSymbol && { token_symbol: tokenSymbol }),
        ...(tokenName && { token_name: tokenName }),
        ...(stakingContractAddress && { staking_contract_address: stakingContractAddress }),
        ...(tokenLaunchPlatform && { token_launch_platform: tokenLaunchPlatform }),
        ...(tokenMetadata && { token_metadata: JSON.parse(tokenMetadata) }),
        ...(governanceAddress && { governance_address: governanceAddress }),
        ...(poolAddress && { pool_address: poolAddress }),
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create venture: ${error.message}`);

    mcpLogger.info({ ventureId: venture.id, name }, 'Created new venture');

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: { venture },
          meta: { ok: true }
        })
      }]
    };

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.error({ error: message }, 'venture_mint failed');
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message }
        })
      }]
    };
  }
}
