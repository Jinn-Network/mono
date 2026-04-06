import { z } from 'zod';
import { graphQLRequest } from '../../../http/client.js';
import { getCurrentJobContext } from './shared/context.js';
import { BASE_UNIVERSAL_TOOLS, computeToolPolicy } from '../../toolPolicy.js';
import { config } from '../../../config/index.js';

// Define the structure for tool information, including optional examples
interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, any>;
  examples?: string[];
}

// Hardcode the core CLI tools that are not part of this MCP server
const CORE_CLI_TOOLS: ToolInfo[] = [
  {
    name: 'web_fetch',
    description: 'Fetches content from URLs. Takes a comprehensive prompt that includes the URL(s) to fetch and specific instructions on how to process their content.',
    parameters: {
      prompt: {
        type: 'string',
        description: 'A comprehensive prompt that includes the URL(s) (up to 20) to fetch and specific instructions on how to process their content. The prompt must contain at least one URL starting with http:// or https://.',
        required: true
      }
    },
    examples: [
      'Fetch and summarize an article: {"prompt": "Can you summarize the main points of https://example.com/news/latest"}',
      'Compare two articles: {"prompt": "What are the differences in the conclusions of these two papers: https://arxiv.org/abs/2401.0001 and https://arxiv.org/abs/2401.0002?"}'
    ]
  },
  {
    name: 'google_web_search',
    description: 'Performs web searches via the Gemini API. Returns a processed summary of the search results, including citations to the original sources.',
    parameters: {
      query: {
        type: 'string',
        description: 'The search query to perform.',
        required: true
      }
    },
    examples: [
      'Search for latest AI advancements: {"query": "latest advancements in AI-powered code generation"}',
      'Search for specific information: {"query": "best practices for TypeScript error handling"}'
    ]
  },
  {
    name: 'list_directory',
    description: 'Lists the contents of a directory.',
    parameters: {
      path: {
        type: 'string',
        description: 'The path to the directory to list.',
        required: true
      }
    }
  },
  {
    name: 'read_file',
    description: 'Reads the content of a file.',
    parameters: {
      path: {
        type: 'string',
        description: 'The path to the file to read.',
        required: true
      }
    }
  },
  {
    name: 'write_file',
    description: 'Writes content to a file.',
    parameters: {
      path: {
        type: 'string',
        description: 'The path to the file to write.',
        required: true
      },
      content: {
        type: 'string',
        description: 'The content to write to the file.',
        required: true
      }
    }
  },
  {
    name: 'search_file_content',
    description: 'Searches for a pattern in a file.',
    parameters: {
      path: {
        type: 'string',
        description: 'The path to the file to search.',
        required: true
      },
      pattern: {
        type: 'string',
        description: 'The pattern to search for.',
        required: true
      }
    }
  },
  {
    name: 'glob',
    description: 'Finds files matching a glob pattern.',
    parameters: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match.',
        required: true
      },
      path: {
        type: 'string',
        description: 'The root path to start searching from.',
        required: false
      }
    }
  },
  {
    name: 'replace',
    description: 'Replaces content in a file.',
    parameters: {
      path: {
        type: 'string',
        description: 'The path to the file.',
        required: true
      },
      pattern: {
        type: 'string',
        description: 'The pattern to replace.',
        required: true
      },
      replacement: {
        type: 'string',
        description: 'The replacement text.',
        required: true
      }
    }
  },
  {
    name: 'run_shell_command',
    description: 'Runs a shell command.',
    parameters: {
      command: {
        type: 'string',
        description: 'The shell command to run.',
        required: true
      }
    }
  },
  {
    name: 'browser_automation',
    description: 'Meta-tool that enables all Chrome DevTools browser automation capabilities. When included in enabledTools, activates the chrome-devtools MCP server with 26 tools for browser automation including: navigation (navigate_page, new_page, close_page), input (click, fill, hover, press_key), screenshots (take_screenshot, take_snapshot), performance tracing, and network inspection. Useful for verification jobs that need visual testing.',
    parameters: {},
    examples: [
      'Enable browser automation for a verification job: enabledTools: ["browser_automation"]',
      'Combine with other tools: enabledTools: ["write_file", "read_file", "browser_automation"]'
    ]
  },
  {
    name: 'fireflies_meetings',
    description: 'Meta-tool that enables Fireflies meeting intelligence tools. When included in enabledTools, activates 3 tools: fireflies_get_transcripts (list recent meetings), fireflies_search (keyword search across transcripts), and fireflies_get_summary (get structured summary for a specific meeting ID). Useful for content jobs that need meeting insights as source material. Privacy: extract ideas only, never attribute to speakers.',
    parameters: {},
    examples: [
      'Enable meeting tools for a research job: enabledTools: ["fireflies_meetings"]',
      'The 3 expanded tools accept: fireflies_get_transcripts(limit?: number), fireflies_search(query: string), fireflies_get_summary(transcript_id: string)'
    ]
  },
  // nano_banana: deprecated
  {
    name: 'telegram_messaging',
    description: 'Meta-tool that enables Telegram messaging capabilities. When included in enabledTools, activates the telegram_send_message tool for broadcasting messages to Telegram channels/groups. Write-only: can send messages but cannot read replies. Requires credential bridge provider "telegram" and JINN_JOB_TELEGRAM_CHAT_ID (optional JINN_JOB_TELEGRAM_TOPIC_ID).',
    parameters: {},
    examples: [
      'Enable Telegram for a distribution job: enabledTools: ["telegram_messaging"]',
      'Send a message: telegram_send_message({ chat_id: "-100123456789", text: "New post published!", topic_id: "2" })'
    ]
  }
];

export const listToolsParams = z.object({
  include_examples: z.boolean().optional().describe('Whether to include usage examples in the response.'),
  include_parameters: z.boolean().optional().describe('Whether to include full parameter details in the response.'),
  tool_name: z.string().optional().describe('If provided, returns detailed information about a specific tool.'),
});

export const listToolsSchema = {
  description: `Lists the effective tools for the current workstream (core CLI + MCP server tools).

MANDATORY: Call this BEFORE using create_job or create_job_batch so you select appropriate enabled_tools. Research jobs should include web search tools (google_web_search or web_fetch) when internet research is required.

Important scope note: If job context provides template tool policy (JINN_CTX_AVAILABLE_TOOLS or JINN_CTX_REQUIRED_TOOLS), this returns ONLY the tools that are actually enabled in the current workstream (universal tools + template tools). If no policy is provided, it falls back to the full tool catalog.

Usage:
- Default: returns tool names and descriptions
- include_parameters=true: include full parameter schemas
- include_examples=true: include usage examples when available
- tool_name="<name>": return details for a single tool

Response: { data: { total_tools, tools: [{ name, description, parameters?, examples? }] }, meta: { ok: true } }`,
  inputSchema: listToolsParams.shape,
};

const listToolsForTemplateParamsBase = z.object({
  templateId: z.string().optional().describe('Template ID to scope tools (jobTemplate.id)'),
  jobDefinitionId: z.string().optional().describe('Job definition ID to resolve template tools'),
});

export const listToolsForTemplateParams = listToolsForTemplateParamsBase.refine(
  (val) => !!val.templateId || !!val.jobDefinitionId,
  { message: 'Provide templateId or jobDefinitionId' }
);

export const listToolsForTemplateSchema = {
  description: `Lists the effective tool catalog for a template (universal tools + template tools).

Provide templateId (jobTemplate.id) or jobDefinitionId (canonical job definition ID).
Returns:
- universalTools: platform-required tools (always available)
- availableTools: tools declared by the template
- effectiveTools: union of universal + template tools`,
  inputSchema: listToolsForTemplateParamsBase.shape,
};

function normalizeTemplateTools(enabledTools: unknown): string[] {
  if (Array.isArray(enabledTools)) {
    return enabledTools.filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0);
  }
  if (typeof enabledTools === 'string') {
    try {
      const parsed = JSON.parse(enabledTools);
      if (Array.isArray(parsed)) {
        return parsed.filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0);
      }
    } catch {
      return [];
    }
  }
  return [];
}

function inferIsCodingJob(): boolean {
  return Boolean(process.env.CODE_METADATA_REPO_ROOT || process.env.JINN_WORKSPACE_DIR);
}

function getScopedToolsFromContext(): { allowList: string[] | null; source: 'available' | 'required' | null } {
  const { availableTools, requiredTools } = getCurrentJobContext();
  const normalizedAvailable = normalizeTemplateTools(availableTools);
  const normalizedRequired = normalizeTemplateTools(requiredTools);
  const hasAvailableTools = process.env.JINN_CTX_AVAILABLE_TOOLS !== undefined;
  const hasRequiredTools = process.env.JINN_CTX_REQUIRED_TOOLS !== undefined;

  if (hasAvailableTools) {
    const { mcpIncludeTools } = computeToolPolicy(normalizedAvailable, { isCodingJob: inferIsCodingJob() });
    return { allowList: mcpIncludeTools, source: 'available' };
  }

  if (hasRequiredTools) {
    const { mcpIncludeTools } = computeToolPolicy(normalizedRequired, { isCodingJob: inferIsCodingJob() });
    return { allowList: mcpIncludeTools, source: 'required' };
  }

  return { allowList: null, source: null };
}

export async function listTools(params: any, serverTools: any[]) {
  try {
    const parseResult = listToolsParams.safeParse(params);
    if (!parseResult.success) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: false, code: 'VALIDATION_ERROR', message: `Invalid parameters: ${parseResult.error.message}`, details: parseResult.error.flatten?.() ?? undefined }, null, 2)
        }]
      };
    }
    const { include_examples = false, include_parameters = false, tool_name } = parseResult.data;

    const dynamicTools: ToolInfo[] = serverTools.map(tool => ({
      name: tool.name,
      description: tool.schema.description,
      parameters: tool.schema.inputSchema,
    }));

    let allTools: ToolInfo[] = [...CORE_CLI_TOOLS, ...dynamicTools];
    const { allowList } = getScopedToolsFromContext();
    if (allowList && allowList.length > 0) {
      const allowed = new Set(allowList);
      allTools = allTools.filter(tool => allowed.has(tool.name));
    }

    if (tool_name) {
      allTools = allTools.filter(tool => tool.name.toLowerCase() === tool_name.toLowerCase());
      if (allTools.length === 0) {
        const availableToolNames = [...CORE_CLI_TOOLS, ...dynamicTools]
          .filter(tool => !allowList || allowList.includes(tool.name))
          .map(t => t.name)
          .join(', ');
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: false, code: 'NOT_FOUND', message: `Tool '${tool_name}' not found.`, details: { available_tools: availableToolNames } }, null, 2)
          }]
        };
      }
    }

    const toolsInfo = allTools.map(tool => {
      const info: any = { name: tool.name, description: tool.description };
      if (include_parameters) {
        info.parameters = tool.parameters;
      }
      if (include_examples && (tool as any).examples) {
        info.examples = (tool as any).examples;
      }
      return info;
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ data: { total_tools: toolsInfo.length, tools: toolsInfo }, meta: { ok: true } }, null, 2)
      }]
    };
  } catch (e: any) {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'RUNTIME_ERROR', message: `Error listing tools: ${e.message}` } }, null, 2) },
      ],
    };
  }
}

export async function listToolsForTemplate(params: any) {
  try {
    const parseResult = listToolsForTemplateParams.safeParse(params);
    if (!parseResult.success) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: false, code: 'VALIDATION_ERROR', message: `Invalid parameters: ${parseResult.error.message}`, details: parseResult.error.flatten?.() ?? undefined }, null, 2)
        }]
      };
    }

    const { templateId, jobDefinitionId } = parseResult.data;
    const gqlUrl = config.services.ponderUrl;
    let template: { id: string; name: string; enabledTools?: any } | null = null;

    if (templateId) {
      const query = `
        query GetTemplate($id: String!) {
          jobTemplate(id: $id) {
            id
            name
            enabledTools
          }
        }
      `;
      const data = await graphQLRequest<{ jobTemplate: { id: string; name: string; enabledTools?: any } | null }>({
        url: gqlUrl,
        query,
        variables: { id: templateId },
        context: { operation: 'listToolsForTemplate', templateId },
      });
      template = data?.jobTemplate || null;
    }

    if (!template && jobDefinitionId) {
      const query = `
        query GetTemplateByJobDefinition($jobDefinitionId: String!) {
          jobTemplates(where: { canonicalJobDefinitionId: $jobDefinitionId }, limit: 1) {
            items {
              id
              name
              enabledTools
            }
          }
        }
      `;
      const data = await graphQLRequest<{ jobTemplates: { items: Array<{ id: string; name: string; enabledTools?: any }> } }>({
        url: gqlUrl,
        query,
        variables: { jobDefinitionId },
        context: { operation: 'listToolsForTemplate', jobDefinitionId },
      });
      template = data?.jobTemplates?.items?.[0] || null;
    }

    if (!template) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: false, code: 'NOT_FOUND', message: 'Template not found for provided identifier.' }, null, 2)
        }]
      };
    }

    const availableTools = normalizeTemplateTools(template.enabledTools);
    const effectiveTools = Array.from(new Set([...BASE_UNIVERSAL_TOOLS, ...availableTools]));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            templateId: template.id,
            templateName: template.name,
            universalTools: BASE_UNIVERSAL_TOOLS,
            availableTools,
            effectiveTools,
          },
          meta: { ok: true },
        }, null, 2)
      }]
    };
  } catch (e: any) {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'RUNTIME_ERROR', message: `Error listing template tools: ${e.message}` } }, null, 2) },
      ],
    };
  }
}
