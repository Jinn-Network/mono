import { z } from 'zod';
import { getOpenAIClient } from './shared/openai.js';
import { mcpLogger } from '../../../logging/index.js';

export const embedTextParams = z.object({
  text: z.string().min(1, 'text must be non-empty'),
  model: z.string().trim().min(1).default('text-embedding-3-small').optional(),
  dim: z.number().int().positive().max(3072).optional(),
});

export const embedTextSchema = {
  description: `Generate an embedding vector for the provided text using the configured OpenAI embedding model. Returns { model, dim, vector }.`,
  inputSchema: embedTextParams.shape,
};

export async function embedText(args: unknown) {
  try {
    const parsed = embedTextParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: {
                ok: false,
                code: 'VALIDATION_ERROR',
                message: parsed.error.message,
              },
            }),
          },
        ],
      };
    }

    const { text, model: modelOverride, dim } = parsed.data;
    const model = modelOverride || 'text-embedding-3-small';

    const client = await getOpenAIClient();

    const response = await client.embeddings.create({
      model,
      input: text,
      ...(dim ? { dimensions: dim } : {}),
    });

    const embedding = response?.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Embedding response missing vector data');
    }

    const resolvedDim = embedding.length;

    const result = {
      model,
      dim: resolvedDim,
      vector: embedding,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            data: result,
            meta: { ok: true },
          }),
        },
      ],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.warn({ message }, 'embed_text tool error');
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: {
              ok: false,
              code: 'EXECUTION_ERROR',
              message,
            },
          }),
        },
      ],
    };
  }
}
