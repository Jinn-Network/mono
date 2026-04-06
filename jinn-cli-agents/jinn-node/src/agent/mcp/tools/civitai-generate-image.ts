import { z } from 'zod';
import { getSupabase } from './shared/supabase.js';
import { getCurrentJobContext } from './shared/context.js';
import { isControlApiEnabled, createArtifact as apiCreateArtifact } from './shared/control_api.js';
import { airCreateImage, extractFirstImageUrl, checkModelAvailability, waitForImageUrlByToken } from './shared/civitai.js';
import { randomUUID } from 'crypto';

// Schema for image generation using Civitai AIR. The tool waits for completion
// (within MCP/tool time limits) and then creates an artifact with the image URL.

export const civitaiGenerateImageParams = z.object({
  prompt: z.string().min(1),
  negative_prompt: z.string().optional(),
  model_urn: z.string().min(1).describe('AIR URN, e.g., urn:air:sd1:checkpoint:civitai:4201@130072'),
  width: z.number().int().positive().default(512),
  height: z.number().int().positive().default(512),
  steps: z.number().int().positive().max(200).optional(),
  cfg_scale: z.number().positive().max(30).optional(),
  scheduler: z.string().optional(),
  seed: z.number().int().optional(),

  // Simplified additional networks - tool handles URN complexity
  additional_networks: z.array(z.object({
    model_id: z.number().int().positive().describe('Civitai model ID (e.g., 82098)'),
    version_id: z.number().int().positive().describe('Version ID from civitai_search_models results (required)'),
    strength: z.number().min(0).max(2).default(0.8).describe('Network strength (0-2, default: 0.8)'),
    trigger_word: z.string().optional().describe('Trigger word for TextualInversion networks')
  })).optional().describe('Additional networks (LoRA/TextualInversion) to enhance generation. Simple format: [{"model_id": 82098, "version_id": 87153, "strength": 0.8}]. Get model_id and version_id from civitai_search_models results.'),


});

export type CivitaiGenerateImageParams = z.infer<typeof civitaiGenerateImageParams>;

export const civitaiGenerateImageSchema = {
  description: 'Generate images using Civitai AIR API. Use checkpoint model_urn from civitai_search_models recommendedAir.urn field. Optionally add LoRAs/TextualInversion networks for enhancement. Typical ranges: steps 20-50, cfg_scale 5-10, LoRA strength 0.3-0.8. Model families (SD1/SDXL) must match between base and enhancement models. Creates artifact and returns {artifact_id, image_url}.',
  inputSchema: civitaiGenerateImageParams.shape,
};

export async function civitaiGenerateImage(params: CivitaiGenerateImageParams) {
  try {
    const parsed = civitaiGenerateImageParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'VALIDATION_ERROR', message: `Invalid parameters: ${parsed.error.message}`, details: parsed.error.flatten?.() } }, null, 2) }]
      };
    }

    const {
      prompt,
      negative_prompt,
      model_urn,
      width,
      height,
      steps,
      cfg_scale,
      scheduler,
      seed,
      additional_networks,
    } = parsed.data;

    const { jobId, jobDefinitionId, projectRunId, projectDefinitionId } = getCurrentJobContext();

    // Resolve project context (prefer job context)
    const resolvedProjectRunId = projectRunId || null;
    const resolvedProjectDefinitionId = projectDefinitionId || null;

    if (!resolvedProjectRunId) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'MISSING_PROJECT_CONTEXT', message: 'Cannot create an artifact. The job has no project_run_id context.' } }, null, 2) }]
      };
    }

    // 1) Obtain image URL via AIR
    let finalImageUrl: string | null = null;

      // Check model availability first to debug API access
      const modelCheck = await checkModelAvailability();
      if (!modelCheck.available) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'API_ACCESS_DENIED', message: `Civitai API access check failed: ${modelCheck.error}` } }, null, 2) }]
        };
      }

      // Transform simple additional_networks array to Civitai API format
      let additionalNetworks: Record<string, any> | undefined = undefined;
      if (additional_networks && additional_networks.length > 0) {
        additionalNetworks = {};
        
        for (const network of additional_networks) {
          // Extract base model from the main model_urn to match network compatibility
          const baseModelMatch = model_urn.match(/urn:air:(sd1|sdxl|sd2|flux):checkpoint:/);
          const baseModel = baseModelMatch ? baseModelMatch[1] : 'sd1';
          
          // Default to LoRA type (most common additional network)
          const networkType = 'lora';
          
          // Require version_id for now (could be enhanced to fetch latest)
          if (!network.version_id) {
            throw new Error(`version_id is required for additional network model_id ${network.model_id}. Get both model_id and version_id from civitai_search_models results.`);
          }
          
          // Build URN format that Civitai expects
          const urn = `urn:air:${baseModel}:${networkType}:civitai:${network.model_id}@${network.version_id}`;
          
          // Build network config
          additionalNetworks[urn] = {
            strength: network.strength,
            ...(network.trigger_word && { triggerWord: network.trigger_word })
          };
        }
      }

      // Create the AIR job (we default to wait=false in SDK wrapper to avoid noisy logs)
      const createRes = await airCreateImage({
        model: model_urn,
        params: {
          prompt,
          negativePrompt: negative_prompt,
          width,
          height,
          steps,
          cfgScale: cfg_scale,
          scheduler,
          seed,
        },
        ...(additionalNetworks && { additionalNetworks })
      });

      // Try immediate URL first (covers cases where output is present)
      let immediateUrl = extractFirstImageUrl(createRes);
      if (!immediateUrl && (createRes as any)?.token) {
        // Quiet manual polling using token until URL is available
        const token = (createRes as any).token as string;
        immediateUrl = await waitForImageUrlByToken(token);
      }
      if (!immediateUrl) {
        const suggestions: string[] = [];
        suggestions.push('Try simplifying the prompt (shorter, fewer concepts).');
        if (additional_networks && Object.keys(additional_networks).length > 0) {
          suggestions.push('Reduce LoRA strength (e.g., 0.3–0.6) or remove extra networks.');
        }
        if (typeof steps === 'number' && steps > 30) suggestions.push('Lower steps (e.g., 20–30).');
        if (typeof cfg_scale === 'number' && cfg_scale > 8) suggestions.push('Lower CFG scale (e.g., 5–8).');
        suggestions.push('Retry once; tokenless or queued jobs can succeed on retry.');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'AIR_NO_IMAGE_URL', message: `No image URL found after generation. status=${createRes?.status ?? 'unknown'}`, suggestions } }, null, 2) }]
        };
      }
      finalImageUrl = immediateUrl;

    // 2) Rehost to Supabase Storage for a durable public URL
    const supabase = await getSupabase();
    const fetchFn: any = (globalThis as any).fetch;
    if (!fetchFn) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'FETCH_UNAVAILABLE', message: 'fetch is not available in this runtime; cannot rehost image' } }, null, 2) }]
      };
    }

    let durableUrl: string | null = null;
    try {
      const res = await fetchFn(finalImageUrl);
      if (!res?.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'DOWNLOAD_FAILED', message: `Failed to download generated image (status ${res?.status})` } }, null, 2) }]
        };
      }
      const contentType = (res.headers?.get?.('content-type') as string) || 'application/octet-stream';
      const buf = await res.arrayBuffer();

      // Derive extension from content-type
      let ext = 'bin';
      if (contentType.includes('png')) ext = 'png';
      else if (contentType.includes('webp')) ext = 'webp';
      else if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';

      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const day = String(now.getUTCDate()).padStart(2, '0');
      const fileKey = `${year}/${month}/${day}/${randomUUID()}.${ext}`;

      const { error: uploadError } = await supabase
        .storage
        .from('generated-images')
        .upload(fileKey, new Uint8Array(buf), { contentType, upsert: true });

      if (uploadError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'UPLOAD_FAILED', message: `Failed to upload durable image: ${uploadError.message}` } }, null, 2) }]
        };
      }

      const { data: publicData } = supabase.storage.from('generated-images').getPublicUrl(fileKey);
      durableUrl = (publicData as any)?.publicUrl || null;
      if (!durableUrl) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'PUBLIC_URL_FAILED', message: 'Could not resolve public URL for uploaded image' } }, null, 2) }]
        };
      }
    } catch (e: any) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'REHOST_ERROR', message: `Failed to rehost image: ${e?.message || String(e)}` } }, null, 2) }]
      };
    }

    // 3) Persist artifact when on-chain job context is available via Control API; otherwise return URL only
    const hasRequestContext = !!process.env.JINN_CTX_REQUEST_ID;
    if (hasRequestContext && isControlApiEnabled()) {
      try {
        const requestId = String(process.env.JINN_CTX_REQUEST_ID);
        const newId = await apiCreateArtifact(requestId, {
          cid: 'inline',
          topic: 'image.generated',
          content: durableUrl,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ data: { id: newId, image_url: durableUrl }, meta: { ok: true, source: 'control_api' } }, null, 2) }]
        };
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ data: { id: null, image_url: durableUrl }, meta: { ok: false, code: 'CONTROL_API_ERROR', message: e?.message || String(e) } }, null, 2) }]
        };
      }
    }

    // No on-chain context or Control API disabled → return URL only (no DB write)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ data: { id: null, image_url: durableUrl }, meta: { ok: true, source: 'no_db_write' } }, null, 2) }]
    };
  } catch (e: any) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'UNEXPECTED_ERROR', message: `civitai_generate_image failed: ${e?.message || String(e)}` } }, null, 2) }]
    };
  }
}

 