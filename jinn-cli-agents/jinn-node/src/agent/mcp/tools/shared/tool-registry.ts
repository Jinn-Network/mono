import { z } from 'zod';

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, any>;
  examples?: string[];
}

// Curated core CLI tools mirrored from the old list-tools implementation
const CORE_CLI_TOOLS: ToolInfo[] = [
  {
    name: 'web_fetch',
    description:
      'Fetches content from URLs. Takes a comprehensive prompt that includes the URL(s) to fetch and specific instructions on how to process their content.',
    parameters: {
      prompt: {
        type: 'string',
        description:
          'A comprehensive prompt that includes the URL(s) (up to 20) to fetch and specific instructions on how to process their content. The prompt must contain at least one URL starting with http:// or https://.',
        required: true,
      },
    },
    examples: [
      'Fetch and summarize an article: {"prompt": "Can you summarize the main points of https://example.com/news/latest"}',
      'Compare two articles: {"prompt": "What are the differences in the conclusions of these two papers: https://arxiv.org/abs/2401.0001 and https://arxiv.org/abs/2401.0002?"}',
    ],
  },
  {
    name: 'google_web_search',
    description:
      'Performs web searches via the Gemini API. Returns a processed summary of the search results, including citations to the original sources.',
    parameters: {
      query: { type: 'string', description: 'The search query to perform.', required: true },
    },
    examples: [
      'Search for latest AI advancements: {"query": "latest advancements in AI-powered code generation"}',
      'Search for specific information: {"query": "best practices for TypeScript error handling"}',
    ],
  },
];

let REGISTRY: ToolInfo[] = [];

export function setToolRegistry(serverTools: { name: string; schema: any }[]) {
  const dynamicTools: ToolInfo[] = serverTools.map((t) => ({
    name: t.name,
    description: t.schema.description,
    parameters: t.schema.inputSchema,
  }));
  REGISTRY = [...CORE_CLI_TOOLS, ...dynamicTools];
}

export function getRegisteredToolNames(): string[] {
  return REGISTRY.map((t) => t.name);
}

export const toolRegistryParams = z.object({
  include_examples: z.boolean().optional(),
  include_parameters: z.boolean().optional(),
  tool_name: z.string().optional(),
});

export async function toolRegistry(params: any) {
  const parse = toolRegistryParams.safeParse(params);
  if (!parse.success) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { ok: false, code: 'VALIDATION_ERROR', message: `Invalid parameters: ${parse.error.message}`, details: parse.error.flatten?.() ?? undefined },
            null,
            2,
          ),
        },
      ],
    };
  }
  const { include_examples = false, include_parameters = false, tool_name } = parse.data;

  let tools = REGISTRY;
  if (tool_name) {
    tools = REGISTRY.filter((t) => t.name.toLowerCase() === tool_name.toLowerCase());
    if (tools.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, code: 'NOT_FOUND', message: `Tool '${tool_name}' not found.`, details: { available_tools: REGISTRY.map((t) => t.name).join(', ') } }, null, 2),
          },
        ],
      };
    }
  }

  const toolsInfo = tools.map((t) => {
    const info: any = { name: t.name, description: t.description };
    if (include_parameters) info.parameters = t.parameters;
    if (include_examples && t.examples) info.examples = t.examples;
    return info;
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ data: { total_tools: toolsInfo.length, tools: toolsInfo }, meta: { ok: true } }, null, 2),
      },
    ],
  };
}



