import { z } from 'zod';
import { composeSinglePageResponse, decodeCursor } from './shared/context-management.js';

// Input schema for querying Zora coins
export const queryCoinsParams = z.object({
  creator: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().describe('Filter by creator address'),
  search: z.string().optional().describe('Search by coin name or symbol'),
  chain_id: z.number().int().positive().default(8453).describe('Chain ID to query (default: 8453 for Base)'),
  cursor: z.string().optional().describe('Pagination cursor for retrieving next page'),
  limit: z.number().int().positive().max(100).default(10).describe('Number of results per page (max 100)')
});

export type QueryCoinsParams = z.infer<typeof queryCoinsParams>;

export const queryCoinsSchema = {
  description: 'Queries Zora content coins with pagination and filtering. Returns coin metadata, creation info, and trading statistics.',
  inputSchema: queryCoinsParams.shape,
};

/**
 * Mock Zora coin data structure
 * In a real implementation, this would come from Zora's API or subgraph
 */
interface ZoraCoin {
  id: string;
  address: string;
  name: string;
  symbol: string;
  description?: string;
  image_url?: string;
  creator: string;
  total_supply: string;
  market_cap_eth?: string;
  volume_24h_eth?: string;
  price_eth?: string;
  holders_count?: number;
  created_at: string;
  chain_id: number;
  metadata_uri?: string;
}

/**
 * Mock function to fetch Zora coins
 * In a real implementation, this would query Zora's subgraph or API
 */
async function fetchZoraCoins(params: {
  creator?: string;
  search?: string;
  chain_id: number;
  offset: number;
  limit: number;
}): Promise<{ coins: ZoraCoin[]; total_count: number }> {
  // Mock data for demonstration
  const mockCoins: ZoraCoin[] = [
    {
      id: '1',
      address: '0x1234567890123456789012345678901234567890',
      name: 'Creative Content Coin',
      symbol: 'CCC',
      description: 'A coin representing creative digital content',
      image_url: 'https://example.com/coin1.png',
      creator: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      total_supply: '1000000000000000000000000', // 1M tokens in wei
      market_cap_eth: '50000000000000000000', // 50 ETH in wei
      volume_24h_eth: '5000000000000000000', // 5 ETH in wei
      price_eth: '50000000000000000', // 0.05 ETH in wei
      holders_count: 125,
      created_at: '2024-01-15T10:30:00Z',
      chain_id: 8453,
      metadata_uri: 'https://metadata.zora.co/coin/1'
    },
    {
      id: '2',
      address: '0x2345678901234567890123456789012345678901',
      name: 'Art Collector Token',
      symbol: 'ACT',
      description: 'Token for digital art collectors',
      creator: '0xbcdefabcdefabcdefabcdefabcdefabcdefabcde',
      total_supply: '500000000000000000000000', // 500K tokens in wei
      market_cap_eth: '25000000000000000000', // 25 ETH in wei
      volume_24h_eth: '2500000000000000000', // 2.5 ETH in wei
      price_eth: '50000000000000000', // 0.05 ETH in wei
      holders_count: 87,
      created_at: '2024-02-01T14:45:00Z',
      chain_id: 8453,
      metadata_uri: 'https://metadata.zora.co/coin/2'
    }
  ];

  // Apply filters
  let filteredCoins = mockCoins.filter(coin => coin.chain_id === params.chain_id);

  if (params.creator) {
    filteredCoins = filteredCoins.filter(coin => 
      coin.creator.toLowerCase() === params.creator!.toLowerCase()
    );
  }

  if (params.search) {
    const searchLower = params.search.toLowerCase();
    filteredCoins = filteredCoins.filter(coin =>
      coin.name.toLowerCase().includes(searchLower) ||
      coin.symbol.toLowerCase().includes(searchLower)
    );
  }

  const total_count = filteredCoins.length;
  const paginatedCoins = filteredCoins.slice(params.offset, params.offset + params.limit);

  return {
    coins: paginatedCoins,
    total_count
  };
}

export async function queryCoins(params: QueryCoinsParams) {
  try {
    // Validate parameters
    const parseResult = queryCoinsParams.safeParse(params);
    if (!parseResult.success) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ 
            ok: false, 
            code: 'VALIDATION_ERROR', 
            message: `Invalid parameters: ${parseResult.error.message}`,
            details: parseResult.error.flatten()
          }, null, 2)
        }]
      };
    }

    const { creator, search, chain_id, cursor, limit } = parseResult.data;

    // Decode cursor for pagination
    const keyset = decodeCursor<{ offset: number }>(cursor) ?? { offset: 0 };

    // Fetch coins from Zora (mock implementation)
    const { coins, total_count } = await fetchZoraCoins({
      creator,
      search,
      chain_id,
      offset: keyset.offset,
      limit: limit + 1 // Fetch one extra to check if there are more
    });

    // Use shared context management for pagination and token budgeting
    const composed = composeSinglePageResponse(coins, {
      startOffset: keyset.offset,
      truncationPolicy: {
        description: 500, // Truncate long descriptions
      },
      requestedMeta: { 
        cursor,
        total_count,
        chain_id,
        filters: {
          creator,
          search
        }
      }
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          coins: composed.data,
          meta: composed.meta
        }, null, 2)
      }]
    };

  } catch (error: any) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          code: 'UNEXPECTED_ERROR',
          message: 'An unexpected error occurred while querying coins',
          error: error.message
        }, null, 2)
      }]
    };
  }
}
