/**
 * OutputInvariantProvider - Converts outputSpec to agent-visible invariant
 *
 * This provider reads the outputSpec from the job blueprint and generates
 * a constraint invariant that tells the agent what output format is required.
 *
 * The outputSpec defines:
 * - Which fields must be in the final output
 * - Their types and descriptions
 * - Required vs optional fields
 *
 * The generated invariant instructs the agent to:
 * 1. Structure its output according to the schema
 * 2. Upload the structured output as an artifact using create_artifact
 * 3. Include the CID in the delivery summary
 *
 * Domain: system - Core agent behavior (output formatting)
 */

import type {
  InvariantProvider,
  BuildContext,
  BlueprintContext,
  BlueprintBuilderConfig,
  Invariant,
} from '../../types.js';

/**
 * OutputSpec field definition
 */
interface OutputField {
  name: string;
  path?: string;
  type: string;
  required?: boolean;
  description?: string;
  items?: { type: string };
}

/**
 * OutputSpec structure — supports multiple formats:
 * - { fields: [...] } — venture-foundry style
 * - { schema: { properties, required } } — x402 gateway style (nested)
 * - { type: "object", properties, required } — raw JSON Schema (template output_spec column)
 */
interface OutputSpec {
  version?: string;
  fields?: OutputField[];
  schema?: {
    type: 'object';
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  // Raw JSON Schema format (top-level properties/required)
  type?: string;
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
}

/**
 * OutputInvariantProvider generates output schema invariants from outputSpec
 */
export class OutputInvariantProvider implements InvariantProvider {
  name = 'output';

  enabled(_config: BlueprintBuilderConfig): boolean {
    return true;
  }

  async provide(
    ctx: BuildContext,
    _builtContext: BlueprintContext
  ): Promise<Invariant[]> {
    const blueprintStr = ctx.metadata?.blueprint;

    if (!blueprintStr) {
      return [];
    }

    // Extract outputSpec: check blueprint.outputSpec first, fall back to metadata.outputSpec
    // (venture dispatches put outputSpec as a sibling of blueprint, not inside it)
    let outputSpec: OutputSpec | undefined;
    try {
      const blueprint = typeof blueprintStr === 'object'
        ? blueprintStr
        : JSON.parse(blueprintStr);
      outputSpec = blueprint.outputSpec;
    } catch {
      // Invalid blueprint JSON - GoalInvariantProvider will handle the error
    }

    if (!outputSpec && ctx.metadata?.outputSpec) {
      outputSpec = ctx.metadata.outputSpec as OutputSpec;
    }

    if (!outputSpec) {
      return [];
    }

    // Build field descriptions from either fields array or schema
    const fieldDescriptions = this.buildFieldDescriptions(outputSpec);

    if (fieldDescriptions.length === 0) {
      return [];
    }

    const requiredFields = fieldDescriptions
      .filter(f => f.required)
      .map(f => f.name);

    const fieldList = fieldDescriptions
      .map(f => `- **${f.name}** (${f.type}${f.required ? ', required' : ''}): ${f.description}`)
      .join('\n');

    return [
      {
        id: 'SYS-OUTPUT',
        type: 'BOOLEAN',
        condition: `You produce a structured output artifact containing these fields:\n${fieldList}`,
        assessment: `Delivery contains artifact with all required fields: ${requiredFields.join(', ')}. Artifact CID is included in summary.`,
        examples: {
          do: [
            'Structured output artifact with all required fields, CID in summary',
            'Summary includes clickable artifact link: [Output](https://gateway.autonolas.tech/ipfs/...)',
          ],
          dont: [
            'Work completed but no structured output artifact exists',
            'Output scattered across files without summary artifact',
          ],
        },
      },
    ];
  }

  /**
   * Build field descriptions from outputSpec (supports both fields array and schema)
   */
  private buildFieldDescriptions(outputSpec: OutputSpec): Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }> {
    const fields: Array<{
      name: string;
      type: string;
      required: boolean;
      description: string;
    }> = [];

    // Check for fields array format (venture-foundry style)
    if (outputSpec.fields && Array.isArray(outputSpec.fields)) {
      for (const field of outputSpec.fields) {
        fields.push({
          name: field.name,
          type: field.type + (field.items ? `<${field.items.type}>` : ''),
          required: field.required ?? false,
          description: field.description || 'No description',
        });
      }
    }

    // Check for nested schema format (x402 gateway style: { schema: { properties, required } })
    if (outputSpec.schema?.properties) {
      const requiredSet = new Set(outputSpec.schema.required || []);
      for (const [name, prop] of Object.entries(outputSpec.schema.properties)) {
        fields.push({
          name,
          type: prop.type,
          required: requiredSet.has(name),
          description: prop.description || 'No description',
        });
      }
    }

    // Check for raw JSON Schema format (template output_spec column: { type, properties, required })
    if (!outputSpec.schema && !outputSpec.fields && outputSpec.properties) {
      const requiredSet = new Set(outputSpec.required || []);
      for (const [name, prop] of Object.entries(outputSpec.properties)) {
        fields.push({
          name,
          type: prop.type,
          required: requiredSet.has(name),
          description: prop.description || 'No description',
        });
      }
    }

    return fields;
  }
}

