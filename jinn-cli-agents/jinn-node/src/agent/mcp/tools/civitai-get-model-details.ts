import { z } from 'zod';
import { composeSinglePageResponse, decodeCursor } from './shared/context-management.js';

const TOP_LEVEL_FIELDS = [
  'id', 'name', 'type', 'description', 'tags', 'creator', 'stats', 'links', 'versions',
] as const;

const VERSION_FIELDS = [
  'id', 'name', 'baseModel', 'publishedAt', 'trainedWords', 'description', 'stats', 'files', 'images',
] as const;

const SELECT_ENUM = [
  ...TOP_LEVEL_FIELDS,
  ...VERSION_FIELDS.map(v => `versions.${v}` as const),
] as const;

export const civitaiGetModelDetailsParams = z.object({
  id: z.number().int().positive().describe('Civitai model ID (required)'),
  cursor: z.string().optional().describe('Cursor for paginating through versions'),
  page_token_budget: z.number().int().positive().optional().describe('Token budget for the page (default: 15k)'),
  truncate_chars: z.number().int().nonnegative().optional().describe('Default truncation for string fields (default: 200)'),
  per_field_max_chars: z.number().int().positive().optional().describe('Hard clamp for any string field (default: 4k)'),
  image_limit_per_version: z.number().int().nonnegative().optional().describe('Max images per version (default: 5)'),
  select: z
    .array(z.enum(SELECT_ENUM))
    .optional()
    .describe(
      'Optional list of fields to include. Top-level: id,name,type,description,tags,creator,stats,links,versions. Version-level: versions.id,versions.name,versions.baseModel,versions.publishedAt,versions.trainedWords,versions.description,versions.stats,versions.files,versions.images.'
    ),
});

export type CivitaiGetModelDetailsParams = z.infer<typeof civitaiGetModelDetailsParams>;

export const civitaiGetModelDetailsSchema = {
  description: 'Get detailed metadata for one Civitai model (top-level and versions.* fields). Use to inspect a chosen model’s versions, trained words, files, and images before generation.',
  inputSchema: civitaiGetModelDetailsParams.shape,
};

export async function civitaiGetModelDetails(params: CivitaiGetModelDetailsParams) {
  try {
    const parsed = civitaiGetModelDetailsParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            data: null,
            meta: {
              ok: false,
              code: 'VALIDATION_ERROR',
              message: parsed.error.message,
              details: parsed.error.flatten?.() ?? undefined,
            }
          })
        }]
      };
    }

    const input = parsed.data;
    const modelId = input.id;
    
    // Parse cursor for version pagination
    const cursor = decodeCursor<{ offset: number }>(input.cursor);
    const startOffset = cursor?.offset ?? 0;

    // Fetch model details from Civitai API
    const url = `https://civitai.com/api/v1/models/${modelId}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          data: null,
          meta: {
            ok: false,
            code: 'HTTP_ERROR',
            status: response.status,
            status_text: response.statusText,
            requested: { source_url: url, model_id: modelId }
          }
        }) }]
      };
    }

    const model = await response.json();

    // Normalize and structure the response
    const normalizedModel = {
      id: model.id,
      name: model.name,
      type: model.type,
      description: model.description,
      tags: model.tags?.map((t: any) => t.name) || [],
      creator: model.creator ? {
        username: model.creator.username,
        image: model.creator.image,
      } : undefined,
      stats: model.stats ? {
        downloadCount: model.stats.downloadCount,
        favoriteCount: model.stats.favoriteCount,
        commentCount: model.stats.commentCount,
        ratingCount: model.stats.ratingCount,
        rating: model.stats.rating,
      } : undefined,
      links: {
        modelUrl: `https://civitai.com/models/${model.id}`,
      },
      versions: model.modelVersions?.map((v: any) => ({
        id: v.id,
        name: v.name,
        baseModel: v.baseModel,
        publishedAt: v.publishedAt,
        trainedWords: v.trainedWords || [],
        description: v.description,
        stats: v.stats ? {
          downloadCount: v.stats.downloadCount,
          ratingCount: v.stats.ratingCount,
          rating: v.stats.rating,
        } : undefined,
        files: v.files?.map((f: any) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          sizeKB: f.sizeKB,
          primary: f.primary || false,
          downloadUrl: f.downloadUrl,
          hashes: f.hashes || {},
          metadata: f.metadata || {},
        })) || [],
        images: (v.images || []).slice(0, input.image_limit_per_version || 5).map((img: any) => ({
          id: img.id,
          url: img.url,
          width: img.width,
          height: img.height,
          nsfw: img.nsfw || false,
          hash: img.hash,
          meta: img.meta,
        })),
      })) || [],
    };

    // Use context management to paginate versions
    const versionsPage = composeSinglePageResponse(
      normalizedModel.versions,
      {
        startOffset,
        pageTokenBudget: input.page_token_budget || 15_000,
        truncateChars: input.truncate_chars || 200,
        perFieldMaxChars: input.per_field_max_chars || 4_000,
        requestedMeta: { 
          cursor: input.cursor,
          model_id: modelId,
          source_url: url,
        },
      }
    );

    // Apply field selection (top-level and versions.*)
    const select = input.select;
    let dataOut: any = {};

    const includeAllTop = !select || select.length === 0;
    const includeTop = (key: typeof TOP_LEVEL_FIELDS[number]) => includeAllTop || select?.includes(key);

    if (includeTop('id')) dataOut.id = normalizedModel.id;
    if (includeTop('name')) dataOut.name = normalizedModel.name;
    if (includeTop('type')) dataOut.type = normalizedModel.type;
    if (includeTop('description')) dataOut.description = normalizedModel.description;
    if (includeTop('tags')) dataOut.tags = normalizedModel.tags;
    if (includeTop('creator')) dataOut.creator = normalizedModel.creator;
    if (includeTop('stats')) dataOut.stats = normalizedModel.stats;
    if (includeTop('links')) dataOut.links = normalizedModel.links;

    // versions handling
    const requestedVersionsWhole = includeTop('versions');
    const requestedVersionFields = new Set<string>((select || []).filter(v => v.startsWith('versions.')).map(v => v.replace(/^versions\./, '')));
    if (requestedVersionsWhole || requestedVersionFields.size > 0 || includeAllTop) {
      const projectVersion = (ver: any) => {
        if (requestedVersionsWhole || includeAllTop || requestedVersionFields.size === 0) return ver;
        const out: any = {};
        for (const k of VERSION_FIELDS) {
          if (requestedVersionFields.has(k)) {
            out[k] = (ver as any)[k];
          }
        }
        return out;
      };
      dataOut.versions = (versionsPage.data || []).map(projectVersion);
    }

    // Return paginated response
    return {
      content: [{ type: 'text', text: JSON.stringify({
        data: dataOut,
        meta: {
          ok: true,
          ...versionsPage.meta,
          requested: {
            ...(versionsPage.meta.requested || {}),
            model_id: modelId,
            source_url: url,
          },
        }
      }) }]
    };

  } catch (error: any) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        data: null,
        meta: {
          ok: false,
          code: 'UNEXPECTED_ERROR',
          message: error?.message || String(error),
          requested: { model_id: (params as any)?.id }
        }
      }) }]
    };
  }
}
