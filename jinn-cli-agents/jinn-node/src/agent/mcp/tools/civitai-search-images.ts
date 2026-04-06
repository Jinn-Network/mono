import { z } from 'zod';
import { composeSinglePageResponse, decodeCursor } from './shared/context-management.js';

const civitaiSearchImagesBase = z.object({
  // Search and filtering
  username: z.string().min(1).optional().describe('Filter by specific creator username'),
  modelVersionId: z.number().int().positive().optional().describe('Filter by specific model version ID'),
  postId: z.number().int().positive().optional().describe('The ID of a post to get images from'),
  
  // Content filtering
  nsfw: z.enum(['None', 'Soft', 'Mature', 'X']).optional().describe('NSFW content level filter'),
  
  // Sorting and time period
  // Accept any string here; enforce allowed values in tool logic to return structured errors instead of schema failures
  sort: z.string().optional().describe('Sort order for results. Allowed: Most Reactions, Most Comments, Newest'),
  period: z.enum(['AllTime', 'Year', 'Month', 'Week', 'Day']).optional().describe('Time period for popularity metrics'),
  
  // Pagination
  limit: z.number().int().min(1).max(200).optional().describe('Number of images to return (1-200, default: 20)'),
  cursor: z.string().optional().describe('Cursor for pagination'),
  page: z.number().int().min(1).optional().describe('Page number for pagination'),
});

export const civitaiSearchImagesParams = civitaiSearchImagesBase;
export type CivitaiSearchImagesParams = z.infer<typeof civitaiSearchImagesParams>;

export const civitaiSearchImagesSchema = {
  description: 'Search for images on Civitai with filtering and sorting options. This tool can also be used to get image stats, as each returned image includes its own engagement metrics (likes, comments, etc.). Find trending images, popular content, and high-performing posts. Useful for discovering successful prompts, popular styles, and engagement patterns.\n\nSupported filters: postId, username, modelVersionId, nsfw, sort, and period. Allowed sort values (Images endpoint): Most Reactions, Most Comments, Newest. Use modelVersionId (not modelId) to get images from a specific model version - this works reliably even for popular models since it queries a smaller dataset.',
  inputSchema: civitaiSearchImagesBase.shape,
};

type CivitaiImage = {
  id: number;
  url?: string;
  width?: number;
  height?: number;
  hash?: string;
  nsfw?: boolean;
  nsfwLevel?: string;
  createdAt?: string;
  postId?: number;
  username?: string;
  userId?: number;
  stats?: {
    cryCount?: number;
    laughCount?: number;
    likeCount?: number;
    dislikeCount?: number;
    heartCount?: number;
    commentCount?: number;
  };
  meta?: {
    prompt?: string;
    negativePrompt?: string;
    cfgScale?: number;
    steps?: number;
    sampler?: string;
    seed?: number;
    model?: string;
    [key: string]: any;
  };
  tags?: Array<{
    id: number;
    name: string;
    isCategory?: boolean;
  }>;
};

const ALLOWED_IMAGE_SORTS = ['Most Reactions', 'Most Comments', 'Newest'] as const;

function mapSort(val?: string): string | undefined {
  if (!val) return undefined;
  const sortMap: Record<string, string> = {
    'Most Reactions': 'Most Reactions',
    'Most Comments': 'Most Comments',
    'Newest': 'Newest',
  };
  return sortMap[val] || undefined;
}

function buildQuery(params: CivitaiSearchImagesParams & { page?: number; cursorVal?: string }): string {
  const q = new URLSearchParams();
  
  if (params.limit) q.set('limit', String(params.limit));
  
  // Handle pagination - prefer cursor over page for consistency
  if (params.cursorVal) {
    q.set('cursor', params.cursorVal);
  } else if (params.page) {
    q.set('page', String(params.page));
  }
  
  // Search parameters
  if (params.username) q.set('username', params.username);
  if (params.modelVersionId) q.set('modelVersionId', String(params.modelVersionId));
  if (params.postId) q.set('postId', String(params.postId));
  
  // Filtering
  if (params.nsfw) q.set('nsfw', params.nsfw);
  
  // Sorting and time period
  const sort = mapSort(params.sort);
  if (sort) q.set('sort', sort);
  if (params.period) q.set('period', params.period);
  
  return q.toString();
}

function normalizeImage(img: any): CivitaiImage {
  return {
    id: img?.id,
    url: img?.url,
    width: img?.width,
    height: img?.height,
    hash: img?.hash,
    nsfw: img?.nsfw,
    nsfwLevel: img?.nsfwLevel,
    createdAt: img?.createdAt,
    postId: img?.postId,
    username: img?.username,
    userId: img?.userId,
    stats: img?.stats ? {
      cryCount: img.stats.cryCount,
      laughCount: img.stats.laughCount,
      likeCount: img.stats.likeCount,
      dislikeCount: img.stats.dislikeCount,
      heartCount: img.stats.heartCount,
      commentCount: img.stats.commentCount,
    } : undefined,
    meta: img?.meta ? {
      prompt: img.meta.prompt,
      negativePrompt: img.meta.negativePrompt,
      cfgScale: img.meta.cfgScale,
      steps: img.meta.steps,
      sampler: img.meta.sampler,
      seed: img.meta.seed,
      model: img.meta.model,
      ...img.meta
    } : undefined,
    tags: Array.isArray(img?.tags) ? img.tags.map((tag: any) => ({
      id: tag?.id,
      name: tag?.name,
      isCategory: tag?.isCategory,
    })) : undefined,
  };
}

export async function civitaiSearchImages(params: CivitaiSearchImagesParams) {
  try {
    const parsed = civitaiSearchImagesParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ 
          data: [], 
          meta: { 
            ok: false, 
            code: 'VALIDATION_ERROR', 
            message: parsed.error.message 
          } 
        }) }]
      };
    }
    
    const input = parsed.data;
    const limit = input.limit ?? 20;

    // Tool-level validation for sort values (Images endpoint):
    if (input.sort && !ALLOWED_IMAGE_SORTS.includes(input.sort as any)) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          data: [],
          meta: {
            ok: false,
            code: 'UNSUPPORTED_SORT',
            message: 'Sort value is not supported by the Images endpoint. Use one of the allowed values.',
            received: input.sort,
            allowed_sorts: ALLOWED_IMAGE_SORTS,
          }
        }) }]
      };
    }
    
    // Handle cursor decoding
    let page = 1;
    let cursorVal: string | undefined;
    const decoded = decodeCursor<{ cursor?: string; page?: number }>(input.cursor);
    if (decoded?.cursor) {
      cursorVal = decoded.cursor;
    } else if (decoded?.page) {
      page = decoded.page;
    } else if (input.page) {
      page = input.page;
    }
    
    const qs = buildQuery({ ...input, page, cursorVal, limit });
    const url = `https://civitai.com/api/v1/images?${qs}`;
    
    // Add a timeout controller
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30-second timeout

    let json: any;
    let images: CivitaiImage[];

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const errorCode = res.status === 400 ? 'INVALID_CURSOR' : 'HTTP_ERROR';
        const errorMessage = res.status === 400 ? 'Invalid cursor value. This may be due to a malformed cursor from the API.' : undefined;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ 
            data: [], 
            meta: { 
              ok: false, 
              code: errorCode, 
              status: res.status, 
              message: errorMessage,
              url 
            } 
          }) }]
        };
      }
      
      json = await res.json();
      const items: any[] = Array.isArray(json?.items) ? json.items : [];
      images = items.map(normalizeImage);
    } finally {
      clearTimeout(timeoutId);
    }
    
    // Handle cursor-based pagination only
    let nextCursor: string | undefined;
    let hasMore = false;
    
    // Check for cursor-based pagination from API metadata
    const nextCursorRaw = json?.metadata?.nextCursor;
    if (nextCursorRaw != null) {
      hasMore = true;
      nextCursor = Buffer.from(JSON.stringify({ 
        v: 1, 
        k: { cursor: String(nextCursorRaw) } 
      }), 'utf8').toString('base64');
    } else {
      // No more pages if nextCursor is null/undefined
      hasMore = false;
      nextCursor = undefined;
    }
    
    const pageResponse = composeSinglePageResponse(images, {
      requestedMeta: {
        username: input.username,
        modelVersionId: input.modelVersionId,
        postId: input.postId,
        sort: input.sort,
        period: input.period,
        nsfw: input.nsfw,
        cursor: cursorVal,
        limit,
        url,
      },
      pageTokenBudget: 15_000,
      truncationPolicy: {
        'meta.prompt': 500,
        'meta.negativePrompt': 300,
      },
    });
    
    // Override with API-provided cursor
    pageResponse.meta.next_cursor = nextCursor;
    pageResponse.meta.has_more = hasMore;
    
    // Add warnings about API limitations
    const warnings: string[] = [];
    
    // Warn if nextCursor was null but we had results (indicates potential pagination issue)
    if (images.length > 0 && !nextCursorRaw) {
      warnings.push('API returned null cursor despite having results. This may indicate end of results or an API limitation.');
    }
    
    if (warnings.length > 0) {
      (pageResponse.meta as any).warnings = warnings;
    }
    
    // Add summary statistics
    const totalReactions = images.reduce((sum: number, img: CivitaiImage) => {
      const stats = img.stats || {};
      return sum + (stats.likeCount || 0) + (stats.heartCount || 0) + 
             (stats.laughCount || 0) + (stats.cryCount || 0);
    }, 0);
    
    const totalComments = images.reduce((sum: number, img: CivitaiImage) => 
      sum + (img.stats?.commentCount || 0), 0);
    
    (pageResponse.meta as any).summary = {
      total_images: images.length,
      total_reactions: totalReactions,
      total_comments: totalComments,
    };
    
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ 
        data: pageResponse.data, 
        meta: { ok: true, ...pageResponse.meta } 
      }) }]
    };
    
  } catch (e: any) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ 
        data: [], 
        meta: { 
          ok: false, 
          code: 'UNEXPECTED_ERROR', 
          message: e?.name === 'AbortError' ? 'Request timed out after 30 seconds' : (e?.message || String(e))
        } 
      }) }]
    };
  }
}