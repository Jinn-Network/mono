/**
 * Bazaar Discovery — dynamic agent metadata for x402 Bazaar
 *
 * Generates discovery-compatible metadata from Supabase agent templates
 * so each agent is independently discoverable on the x402 Bazaar.
 */

import type { OutputSpec } from "./output-spec.js";
import { summarizeOutputSpec } from "./output-spec.js";

interface AgentTemplate {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  tags: string[] | null;
  input_schema: Record<string, any> | null;
  output_spec: Record<string, any> | null;
  price_wei: string | null;
  olas_agent_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  status: string | null;
}

/**
 * Convert wei string to USD price string for x402 accepts.
 * Uses a rough ETH/USD estimate — in production this should use a price feed.
 */
function weiToUsdPrice(weiString: string | null): string {
  if (!weiString || weiString === "0") return "$0.001"; // minimum floor
  const eth = Number(BigInt(weiString)) / 1e18;
  // Rough ETH price estimate — update or use oracle in production
  const ETH_USD = 3000;
  const usd = eth * ETH_USD;
  if (usd < 0.001) return "$0.001";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

/**
 * Build an input example from JSON Schema properties.
 */
function buildInputExample(inputSchema: Record<string, any> | null): Record<string, any> {
  if (!inputSchema?.properties) return {};
  const example: Record<string, any> = {};
  for (const [key, spec] of Object.entries(inputSchema.properties)) {
    const s = spec as Record<string, any>;
    if (s.default && s.default !== "$provision") {
      example[key] = s.default;
    } else if (s.enum?.length) {
      example[key] = s.enum[0];
    } else if (s.type === "string") {
      example[key] = s.description ? `<${key}>` : "";
    } else if (s.type === "number") {
      example[key] = 0;
    } else if (s.type === "array") {
      example[key] = [];
    } else if (s.type === "boolean") {
      example[key] = false;
    }
  }
  return example;
}

/**
 * Build an output example from OutputSpec fields.
 */
function buildOutputExample(outputSpec: Record<string, any> | null): Record<string, any> {
  if (!outputSpec?.fields) return {};
  const example: Record<string, any> = {};
  for (const field of outputSpec.fields) {
    if (field.type === "string") {
      example[field.name] = field.description || "";
    } else if (field.type === "number") {
      example[field.name] = 0;
    } else if (field.type === "array") {
      example[field.name] = [];
    } else if (field.type === "object") {
      example[field.name] = {};
    }
  }
  return example;
}

export interface DiscoveryAgentItem {
  resource: string;
  type: string;
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    price: string;
    payTo: string;
  }>;
  lastUpdated: string;
  metadata: {
    name: string;
    description: string;
    tags: string[];
    olasAgentId: number | null;
    input: {
      example: Record<string, any>;
      schema: Record<string, any>;
    };
    output: {
      example: Record<string, any>;
      schema: Record<string, any>;
    };
  };
}

/**
 * Build Bazaar-compatible discovery items from agent templates.
 */
export function buildDiscoveryItems(
  agents: AgentTemplate[],
  baseUrl: string,
  payTo: string,
  network: string,
): DiscoveryAgentItem[] {
  return agents.map((a) => ({
    resource: `${baseUrl}/agents/${a.slug}/execute`,
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network,
        price: weiToUsdPrice(a.price_wei),
        payTo,
      },
    ],
    lastUpdated: a.updated_at || a.created_at || new Date().toISOString(),
    metadata: {
      name: a.name,
      description: a.description || "",
      tags: a.tags || [],
      olasAgentId: a.olas_agent_id,
      input: {
        example: buildInputExample(a.input_schema),
        schema: a.input_schema || {},
      },
      output: {
        example: buildOutputExample(a.output_spec),
        schema: a.output_spec || {},
      },
    },
  }));
}

/**
 * Build .well-known/x402 manifest from discovery items.
 */
export function buildWellKnownManifest(
  items: DiscoveryAgentItem[],
  limit = 20,
  offset = 0,
) {
  const paginated = items.slice(offset, offset + limit);
  return {
    x402Version: 2,
    items: paginated,
    pagination: {
      limit,
      offset,
      total: items.length,
    },
  };
}
