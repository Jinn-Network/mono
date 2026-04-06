/**
 * Venture Dispatch — dispatch jobs from workstream templates.
 *
 * Called by the venture watcher when a schedule entry is due.
 * Loads the workstream template from the `templates` table,
 * builds the IPFS payload, and posts to the marketplace.
 */

import { randomUUID } from 'node:crypto';
import { workerLogger } from '../../logging/index.js';
import { getTemplate, listTemplates } from '../../scripts/templates/crud.js';
import { buildIpfsPayload } from '../../agent/shared/ipfs-payload-builder.js';
import { extractToolPolicyFromBlueprint } from '../../shared/template-tools.js';
import { extractSchemaEnvVars } from '../../shared/job-env.js';
import { getMechAddress, getServicePrivateKey, getServiceSafeAddress, getMechChainConfig } from '../../env/operate-profile.js';
import { getRandomStakedMech } from '../filters/stakingFilter.js';
import { get_mech_config } from '@jinn-network/mech-client-ts/dist/config.js';
import { dispatchViaSafe } from '../safe-dispatch.js';
import { graphQLRequest } from '../../http/client.js';
import type { Venture } from '../../data/ventures.js';
import type { ScheduleEntry } from '../../data/types/scheduleEntry.js';
import { config as nodeConfig, secrets } from '../../config/index.js';

// ---------------------------------------------------------------------------
// Context provisioning — opt-in rich context injection into blueprint
// ---------------------------------------------------------------------------

type ContextProvisioningConfig = {
  enabled: boolean;
  includeDispatchSchedule: boolean;
  includeTemplateCatalog: boolean;
  includeRecentRequestIds: boolean;
  includeVentureInvariants: boolean;
  templateCatalogLimit: number;
  recentRequestLimit: number;
  injectIntoInvariants: string[];
};

const DEFAULT_CONTEXT_CONFIG: ContextProvisioningConfig = {
  enabled: false,
  includeDispatchSchedule: false,
  includeTemplateCatalog: false,
  includeRecentRequestIds: false,
  includeVentureInvariants: false,
  templateCatalogLimit: 20,
  recentRequestLimit: 5,
  injectIntoInvariants: [],
};

function parseContextProvisioningConfig(mergedInput: Record<string, any>): ContextProvisioningConfig {
  const raw = mergedInput.contextProvisioning;
  if (!raw || typeof raw !== 'object') return DEFAULT_CONTEXT_CONFIG;

  const include = (key: string) => raw[key] === true;
  const anyEnabled = include('includeDispatchSchedule') || include('includeTemplateCatalog')
    || include('includeRecentRequestIds') || include('includeVentureInvariants');

  return {
    enabled: anyEnabled,
    includeDispatchSchedule: include('includeDispatchSchedule'),
    includeTemplateCatalog: include('includeTemplateCatalog'),
    includeRecentRequestIds: include('includeRecentRequestIds'),
    includeVentureInvariants: include('includeVentureInvariants'),
    templateCatalogLimit: typeof raw.templateCatalogLimit === 'number' ? raw.templateCatalogLimit : 20,
    recentRequestLimit: typeof raw.recentRequestLimit === 'number' ? raw.recentRequestLimit : 5,
    injectIntoInvariants: Array.isArray(raw.injectIntoInvariants) ? raw.injectIntoInvariants : [],
  };
}

type DispatchContextBundle = {
  scheduleBlock: string;
  templateBlock: string;
  recentRequestIdsBlock: string;
  ventureInvariantsBlock: string;
};

async function buildDispatchContextBundle(
  venture: Venture,
  config: ContextProvisioningConfig,
): Promise<DispatchContextBundle> {
  const bundle: DispatchContextBundle = {
    scheduleBlock: '',
    templateBlock: '',
    recentRequestIdsBlock: '',
    ventureInvariantsBlock: '',
  };

  if (config.includeDispatchSchedule) {
    const schedule = venture.dispatch_schedule || [];
    bundle.scheduleBlock = schedule.length > 0
      ? schedule.map((e: any) =>
        `  - [${e.id}] template=${e.templateId} cron="${e.cron}" enabled=${e.enabled !== false} label="${e.label || ''}"`)
        .join('\n')
      : '  (no schedule entries configured)';
  }

  if (config.includeTemplateCatalog) {
    try {
      const ventureTemplates = await listTemplates({
        ventureId: venture.id,
        status: 'published',
        limit: config.templateCatalogLimit,
      });
      const globalTemplates = await listTemplates({
        status: 'published',
        limit: config.templateCatalogLimit,
      });
      const allTemplates = deduplicateById([...ventureTemplates, ...globalTemplates])
        .slice(0, config.templateCatalogLimit);
      bundle.templateBlock = allTemplates.length > 0
        ? allTemplates.map((t: any) =>
          `  - [${t.id}] "${t.name}" (${t.slug}) tools=${(t.enabled_tools || []).length}`)
          .join('\n')
        : '  (no published templates found)';
    } catch (err) {
      workerLogger.warn({ err }, 'Context provisioning: failed to fetch template catalog');
      bundle.templateBlock = '  (template catalog unavailable)';
    }
  }

  if (config.includeRecentRequestIds) {
    try {
      const ponderUrl = nodeConfig.services.ponderUrl;
      const data = await graphQLRequest<{
        requests: { items: Array<{ id: string; jobName: string; delivered: boolean; blockTimestamp: string }> };
      }>({
        url: ponderUrl,
        query: `query RecentVentureRequests($ventureId: String!) {
          requests(
            where: { ventureId: $ventureId }
            limit: ${config.recentRequestLimit + 3}
            orderBy: "blockTimestamp"
            orderDirection: "desc"
          ) {
            items { id jobName delivered blockTimestamp }
          }
        }`,
        variables: { ventureId: venture.id },
      });
      const ids = (data?.requests?.items || [])
        .map(item => item.id)
        .filter((id): id is string => typeof id === 'string' && id.startsWith('0x'))
        .slice(0, config.recentRequestLimit);
      bundle.recentRequestIdsBlock = ids.length > 0
        ? ids.map(id => `  - ${id}`).join('\n')
        : '  (no recent request IDs found)';
    } catch (err) {
      workerLogger.warn({ err }, 'Context provisioning: failed to fetch recent request IDs');
      bundle.recentRequestIdsBlock = '  (recent request IDs unavailable)';
    }
  }

  if (config.includeVentureInvariants) {
    const ventureBlueprint = venture.blueprint as any;
    const allInvariants = Array.isArray(ventureBlueprint?.invariants) ? ventureBlueprint.invariants : [];
    bundle.ventureInvariantsBlock = allInvariants.length > 0
      ? allInvariants.map((inv: any) => {
        if (inv.type === 'BOOLEAN') {
          return `  - [${inv.id}] (${inv.type}): ${inv.condition || ''}. Assessment: ${inv.assessment || ''}`;
        }
        const bounds = inv.min != null && inv.max != null
          ? `${inv.min}–${inv.max}`
          : inv.min != null ? `≥ ${inv.min}` : inv.max != null ? `≤ ${inv.max}` : '';
        return `  - [${inv.id}] (${inv.type}): ${inv.metric || ''} ${bounds}. Assessment: ${inv.assessment || ''}`;
      }).join('\n')
      : '';
  }

  return bundle;
}

function applyContextInjectionToInvariants(
  blueprint: any,
  config: ContextProvisioningConfig,
  bundle: DispatchContextBundle,
  ventureName: string,
  ventureId: string,
): void {
  const invariants = blueprint?.invariants;
  if (!Array.isArray(invariants) || config.injectIntoInvariants.length === 0) return;

  for (const inv of invariants) {
    if (!config.injectIntoInvariants.includes(inv.id)) continue;

    let contextBlock = '';

    if (bundle.ventureInvariantsBlock && config.includeVentureInvariants) {
      contextBlock += `\n\nVENTURE INVARIANTS for "${ventureName}" (${ventureId}):\n${bundle.ventureInvariantsBlock}\n\nYou MUST assess each of these venture invariants during ORIENT and include them in the invariantHealthMap.`;
    }

    if (bundle.scheduleBlock && config.includeDispatchSchedule) {
      contextBlock += `\n\nDISPATCH SCHEDULE for venture "${ventureName}":\n${bundle.scheduleBlock}`;
    }

    if (bundle.templateBlock && config.includeTemplateCatalog) {
      contextBlock += `\n\nAVAILABLE TEMPLATES:\n${bundle.templateBlock}`;
    }

    if (bundle.recentRequestIdsBlock && config.includeRecentRequestIds) {
      contextBlock += `\n\nRECENT REQUEST IDS (use these with get_details):\n${bundle.recentRequestIdsBlock}`;
    }

    if (contextBlock) {
      inv.condition = (inv.condition || '') + contextBlock;
    }
  }
}

function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

type DispatchFromTemplateOptions = {
  /**
   * Optional deterministic job definition ID.
   * If omitted, a random UUID is generated (legacy behavior).
   */
  jobDefinitionId?: string;
};

/**
 * Dispatch a finite workstream from a template + venture schedule entry.
 */
export async function dispatchFromTemplate(
  venture: Venture,
  entry: ScheduleEntry,
  options?: DispatchFromTemplateOptions,
): Promise<{ requestIds: string[] }> {
  // 1. Load workstream template from templates table
  const template = await getTemplate(entry.templateId);
  if (!template) {
    throw new Error(`Template not found: ${entry.templateId}`);
  }

  // 2. Merge input: entry.input provides runtime overrides (+ input_schema defaults)
  const mergedInput = template.input_schema
    ? { ...extractDefaults(template.input_schema as Record<string, any>), ...entry.input }
    : (entry.input || {});

  // 2b. Extract env vars from input_schema envVar mappings
  const extractedEnv = template.input_schema
    ? extractSchemaEnvVars(template.input_schema as Record<string, any>, mergedInput, 'inputSchema.properties')
    : undefined;

  // Merge: schema-extracted base, explicit entry.input.env overrides
  const mergedEnv = (extractedEnv || mergedInput.env)
    ? { ...extractedEnv, ...(mergedInput.env || {}) }
    : undefined;

  if (extractedEnv) {
    workerLogger.info(
      { ventureId: venture.id, templateId: template.id, envKeys: Object.keys(extractedEnv) },
      'Venture dispatch: extracted env vars from input schema'
    );
  }

  // 3. Build blueprint with substitution
  const blueprintObj = typeof template.blueprint === 'string'
    ? JSON.parse(template.blueprint)
    : template.blueprint;

  // Substitute {{variables}} in blueprint with merged input
  const substitutedBlueprint = deepSubstitute(blueprintObj, mergedInput);

  // 3b. Opt-in context provisioning — inject schedule/templates/requestIds/invariants
  const contextConfig = parseContextProvisioningConfig(mergedInput);
  if (contextConfig.enabled) {
    workerLogger.info(
      {
        ventureId: venture.id,
        templateId: template.id,
        includeDispatchSchedule: contextConfig.includeDispatchSchedule,
        includeTemplateCatalog: contextConfig.includeTemplateCatalog,
        includeRecentRequestIds: contextConfig.includeRecentRequestIds,
        includeVentureInvariants: contextConfig.includeVentureInvariants,
        injectIntoInvariants: contextConfig.injectIntoInvariants,
      },
      'Venture dispatch: context provisioning enabled'
    );
    const dispatchContext = await buildDispatchContextBundle(venture, contextConfig);
    applyContextInjectionToInvariants(
      substitutedBlueprint,
      contextConfig,
      dispatchContext,
      venture.name,
      venture.id,
    );
  }

  const blueprintStr = JSON.stringify(substitutedBlueprint);

  // 4. Extract venture invariants (FLOOR/CEILING/RANGE) for context
  const ventureBlueprint = venture.blueprint as any;
  const ventureInvariants = Array.isArray(ventureBlueprint?.invariants)
    ? ventureBlueprint.invariants.filter((inv: any) =>
      inv.type === 'FLOOR' || inv.type === 'CEILING' || inv.type === 'RANGE'
    )
    : [];

  // 5. Build venture context for the agent
  const ventureContext: Record<string, any> = {
    ventureId: venture.id,
    ventureName: venture.name,
    ventureInvariants,
  };

  // 6. Extract tools from template
  const toolPolicy = extractToolPolicyFromBlueprint(substitutedBlueprint);
  const enabledTools = toolPolicy.availableTools.length > 0
    ? toolPolicy.availableTools
    : (Array.isArray(template.enabled_tools) ? template.enabled_tools : []);

  // 7. Generate a unique job definition ID (or use deterministic override)
  const jobDefinitionId = options?.jobDefinitionId || randomUUID();
  const jobName = entry.label
    ? `${venture.name} — ${entry.label}`
    : `${venture.name} — ${template.name}`;

  workerLogger.info(
    { ventureId: venture.id, templateId: template.id, jobName, jobDefinitionId },
    'Venture dispatch: posting to marketplace'
  );

  // 8. Build IPFS payload
  const buildResult = await buildIpfsPayload({
    blueprint: blueprintStr,
    jobName,
    jobDefinitionId,
    enabledTools,
    cyclic: false,
    ventureId: venture.id,
    templateId: template.id,
    skipBranch: true,
    additionalContextOverrides: {
      env: mergedEnv,
    },
  });
  const { ipfsJsonContents } = buildResult;

  // 9. Apply venture context transform to payload
  if (ipfsJsonContents.length > 0) {
    const payload = ipfsJsonContents[0];

    // Inject ventureContext into additionalContext
    if (payload.additionalContext) {
      payload.additionalContext.ventureContext = ventureContext;
    } else {
      payload.additionalContext = { ventureContext };
    }

    // Inject model preference from schedule entry input
    if (mergedInput.model) {
      payload.additionalContext = payload.additionalContext || {};
      payload.additionalContext.model = mergedInput.model;
    }

    // Include outputSpec from template if available
    if (template.output_spec && typeof template.output_spec === 'object') {
      payload.outputSpec = template.output_spec;
    }
  }

  // 10. Post to marketplace via Safe (ensures mapRequestCounts[multisig] increments for staking)
  const mechAddress = getMechAddress();
  const privateKey = getServicePrivateKey();
  const safeAddress = getServiceSafeAddress();
  const rpcHttpUrl = secrets.rpcUrl;
  const chainConfig = getMechChainConfig();

  if (!mechAddress) {
    throw new Error('Service target mech address not configured. Check .operate service config (MECH_TO_CONFIG).');
  }

  if (!privateKey) {
    throw new Error('Service agent private key not found. Check .operate/keys directory.');
  }

  if (!safeAddress) {
    throw new Error('Service Safe address not configured. Check JINN_SERVICE_SAFE_ADDRESS or service config.');
  }

  const priorityMech = await getRandomStakedMech(mechAddress);

  // Resolve marketplace address from chain config
  const mechConfig = get_mech_config(chainConfig);
  const mechMarketplaceAddress = mechConfig.mech_marketplace_contract;

  if (!mechMarketplaceAddress || mechMarketplaceAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error('Mech Marketplace contract address not configured for this chain.');
  }

  const result = await dispatchViaSafe({
    serviceSafeAddress: safeAddress,
    agentEoaPrivateKey: privateKey,
    priorityMech,
    mechMarketplaceAddress,
    rpcUrl: rpcHttpUrl,
    ipfsJsonContents,
    responseTimeout: 300,
  });

  // 11. Normalize request IDs
  const rawIds = result?.request_ids ?? [];
  const requestIds: string[] = Array.isArray(rawIds) ? rawIds.map(String) : [];

  workerLogger.info(
    { ventureId: venture.id, templateId: template.id, requestIds },
    'Venture dispatch: marketplace request posted'
  );

  return { requestIds };
}

/**
 * Extract default values from a JSON Schema input_schema.
 */
function extractDefaults(inputSchema: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  if (inputSchema.properties) {
    for (const [key, spec] of Object.entries(inputSchema.properties as Record<string, any>)) {
      if (spec.default !== undefined) result[key] = spec.default;
    }
  }
  return result;
}

/**
 * Recursively substitute {{variable}} placeholders in an object.
 */
function deepSubstitute(obj: any, input: Record<string, any>): any {
  if (typeof obj === 'string') {
    return obj.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path) => {
      const value = resolvePath(input, path);
      if (value === undefined) return _match;
      if (Array.isArray(value)) return value.join('\n');
      return String(value);
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(item => deepSubstitute(item, input));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepSubstitute(value, input);
    }
    return result;
  }
  return obj;
}

function resolvePath(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}
