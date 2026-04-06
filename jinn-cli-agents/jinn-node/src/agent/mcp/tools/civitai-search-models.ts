import { z } from 'zod';
import { composeSinglePageResponse, decodeCursor } from './shared/context-management.js';

// Unified input: single query string with smart type inference
const civitaiSearchModelsBase = z.object({
  query: z.string().min(1).describe('Single input. If the value equals a known type (e.g., "checkpoint", "lora"), the tool browses by that type; otherwise it performs full-text search.'),
  limit: z.number().int().min(1).max(100).optional().describe('Number of models to return (1-100, default: 20)'),
  // Cursor encodes { page } for types-only mode, { cursor } for query mode
  cursor: z.string().optional().describe('Cursor for pagination'),
});

export const civitaiSearchModelsParams = civitaiSearchModelsBase;

export type CivitaiSearchModelsParams = z.infer<typeof civitaiSearchModelsParams>;

export const civitaiSearchModelsSchema = {
  description: 'Search Civitai models for image generation using a single input. If the query equals a known type (e.g., "checkpoint", "lora"), the tool browses that category; otherwise it performs text search. Results include recommendedAir.urn for use with civitai_generate_image. For generation, use checkpoint models as base and LoRAs as enhancements. Model families (SD1/SDXL) must match between base and enhancement models.',
  inputSchema: civitaiSearchModelsBase.shape,
};

type CivitaiModel = any; // Keep flexible, we normalize below

function inferTypesFromTerm(term?: string): Array<'Checkpoint'|'LORA'|'TextualInversion'|'Hypernetwork'|'AestheticGradient'|'Controlnet'|'Poses'> | undefined {
  if (!term) return undefined;
  const t = term.trim().toLowerCase();
  const map: Record<string, any> = {
    'checkpoint': ['Checkpoint'], 'checkpoints': ['Checkpoint'], 'model': ['Checkpoint'], 'models': ['Checkpoint'],
    'lora': ['LORA'], 'loras': ['LORA'],
    'textualinversion': ['TextualInversion'], 'textual inversion': ['TextualInversion'], 'ti': ['TextualInversion'],
    'hypernetwork': ['Hypernetwork'], 'hypernetworks': ['Hypernetwork'],
    'controlnet': ['Controlnet'], 'controlnets': ['Controlnet'],
    'poses': ['Poses'], 'pose': ['Poses'],
  };
  return map[t] as any;
}

function buildQuery(params: { query?: string; types?: Array<'Checkpoint'|'LORA'|'TextualInversion'|'Hypernetwork'|'AestheticGradient'|'Controlnet'|'Poses'>; limit?: number; page?: number; cursorVal?: string }) : string {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  const browseMode = Array.isArray(params.types) && params.types.length > 0;
  if (!browseMode) {
    if (params.cursorVal) q.set('cursor', String(params.cursorVal));
    if (params.query) q.set('query', params.query);
  } else {
    q.set('page', String(params.page || 1));
    // Default to Most Downloaded for types-only browse
    q.set('sort', 'Most Downloaded');
    q.set('period', 'AllTime');
    if (params.types && params.types.length) q.set('types', params.types.join(','));
  }
  return q.toString();
}

function normalizeModel(m: CivitaiModel) {
  const firstVersion = Array.isArray(m?.modelVersions) ? m.modelVersions[0] : undefined;
  const primaryFile = Array.isArray(firstVersion?.files) ? firstVersion.files.find((f: any) => f?.primary) || firstVersion.files[0] : undefined;
  const previewImage = Array.isArray(firstVersion?.images) ? firstVersion.images[0]?.url : undefined;
  // Map base model to AIR family and construct a recommended AIR URN for checkpoints
  function mapBaseModelToAirFamily(baseModel?: string): string | undefined {
    if (!baseModel) return undefined;
    const v = String(baseModel).toLowerCase();
    if (v.includes('sdxl')) return 'sdxl';
    if (v.includes('sd 2.1') || v.includes('sd2.1') || v === '2.1' || v === 'sd21') return 'sd2';
    if (v.includes('sd 1.5') || v.includes('sd1.5') || v === '1.5' || v === 'sd15') return 'sd1';
    if (v.includes('flux')) return 'flux';
    return undefined;
  }
  const airFamily = mapBaseModelToAirFamily(firstVersion?.baseModel);
  const modelType = String(m?.type).toLowerCase();
  
  // Map model types to AIR network types
  function mapModelTypeToAirType(type: string): string | undefined {
    const typeMap: Record<string, string> = {
      'checkpoint': 'checkpoint',
      'lora': 'lora', 
      'textualinversion': 'textual_inversion',
      'hypernetwork': 'hypernetwork',
      'lycoris': 'lycoris',
      'locon': 'locon'
    };
    return typeMap[type] || undefined;
  }
  
  const airType = mapModelTypeToAirType(modelType);
  const canGenerate = modelType === 'checkpoint';
  const isAdditionalNetwork = ['lora', 'textualinversion', 'hypernetwork', 'lycoris', 'locon'].includes(modelType);
  
  const recommendedAirUrn = airType && airFamily && m?.id && firstVersion?.id
    ? `urn:air:${airFamily}:${airType}:civitai:${m.id}@${firstVersion.id}`
    : undefined;
  return {
    id: m?.id,
    name: m?.name,
    type: m?.type,
    tags: Array.isArray(m?.tags) ? m.tags.map((t: any) => typeof t === 'string' ? t : t?.name).filter(Boolean) : [],
    creator: {
      username: m?.creator?.username,
      image: m?.creator?.image,
    },
    stats: m?.stats ? {
      downloadCount: m.stats.downloadCount,
      favoriteCount: m.stats.favoriteCount,
      ratingCount: m.stats.ratingCount,
      rating: m.stats.rating,
    } : undefined,
    primaryVersion: firstVersion ? {
      id: firstVersion.id,
      name: firstVersion.name,
      baseModel: firstVersion.baseModel,
      trainedWords: firstVersion.trainedWords,
      files: firstVersion.files,
      images: firstVersion.images,
    } : undefined,
    recommendedAir: recommendedAirUrn ? { family: airFamily, urn: recommendedAirUrn, type: airType } : undefined,
    capabilities: {
      canGenerate,
      isAdditionalNetwork,
      supportsGeneration: m?.supportsGeneration === true
    },
    links: {
      modelUrl: m?.id ? `https://civitai.com/models/${m.id}` : undefined,
      downloadUrl: primaryFile?.downloadUrl,
      previewImageUrl: previewImage,
    },
  };
}

export async function civitaiSearchModels(params: CivitaiSearchModelsParams) {
  try {
    const parsed = civitaiSearchModelsParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ data: [], meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message } }) }]
      };
    }
    const input = parsed.data;
    // If query looks like a known type, switch to types-only browse
    const inferredTypes = inferTypesFromTerm(input.query);

    const limit = input.limit ?? 20;
    // Resolve pagination strategy
    const browseMode = Array.isArray(inferredTypes) && inferredTypes.length > 0;
    const queryMode = !browseMode;
    let page = 1;
    let cursorVal: string | undefined;
    if (queryMode) {
      const decodedC = decodeCursor<{ cursor: string }>(input.cursor);
      cursorVal = decodedC?.cursor;
    } else {
      const decodedP = decodeCursor<{ page: number }>(input.cursor);
      page = decodedP?.page || 1;
    }

    const qs = buildQuery({
      query: queryMode ? input.query : undefined,
      types: browseMode ? inferredTypes : undefined,
      page,
      limit,
      cursorVal
    });
    const url = `https://civitai.com/api/v1/models?${qs}`;

    const res = await fetch(url);
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
    const json: any = await res.json();
    const items: any[] = Array.isArray(json?.items) ? json.items : (Array.isArray(json?.data) ? json.data : json);
    // Map and keep any model that yields a valid AIR URN (Option B)
    const allModels = (Array.isArray(items) ? items : []).map(normalizeModel);
    const models = allModels.filter(model => model.recommendedAir?.urn);

    // Determine next cursor from API metadata only
    let nextCursor: string | undefined;
    let hasMore = false;
    
    const nextCursorRaw = json?.metadata?.nextCursor ?? json?.nextCursor;
    if (nextCursorRaw != null) {
      hasMore = true;
      nextCursor = Buffer.from(JSON.stringify({ v: 1, k: { cursor: String(nextCursorRaw) } }), 'utf8').toString('base64');
    } else {
      hasMore = false;
      nextCursor = undefined;
    }

    const pageResponse = composeSinglePageResponse(models, {
      requestedMeta: { cursor: cursorVal, limit, url },
      pageTokenBudget: 15_000,
    });

    // Override with API-provided cursor
    pageResponse.meta.next_cursor = nextCursor;
    pageResponse.meta.has_more = hasMore;

    // Minimal warnings
    const warnings: string[] = Array.isArray(pageResponse.meta.warnings) ? [...(pageResponse.meta.warnings as string[])] : [];
    if (models.length > 0 && !nextCursorRaw) warnings.push('API returned null cursor despite having results.');
    if (queryMode && nextCursorRaw) warnings.push('Query mode uses cursor pagination; API may be inconsistent.');
    if (warnings.length) (pageResponse.meta as any).warnings = warnings;

    // Add summary of returned model types for better UX
    const modelTypeSummary = models.reduce((acc: Record<string, number>, model) => {
      const type = model.type?.toLowerCase() || 'unknown';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    
    (pageResponse.meta as any).model_types_returned = modelTypeSummary;

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ data: pageResponse.data, meta: { ok: true, ...pageResponse.meta } }) }]
    };
  } catch (e: any) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ data: [], meta: { ok: false, code: 'UNEXPECTED_ERROR', message: e?.message || String(e) } }) }]
    };
  }
}


