/**
 * Template Substitution Module
 * 
 * Shared logic for variable substitution in blueprints.
 * Used by both x402-gateway and launch_workstream.ts.
 */

/**
 * Substitute {{variable}} placeholders in a string with input values.
 * Supports nested variable paths like {{blogSpec.name}}.
 */
export function substituteVariables(
    text: string,
    input: Record<string, any>,
    inputSchema?: Record<string, any>
): string {
    return text.replace(/\{\{([\w.]+)\}\}/g, (match, varPath) => {
        // Support nested paths like blogSpec.name
        const parts = varPath.split('.');
        let value: any = input;
        for (const part of parts) {
            if (value && typeof value === 'object' && part in value) {
                value = value[part];
            } else {
                value = undefined;
                break;
            }
        }

        if (value !== undefined) {
            // Handle arrays by joining with newlines
            if (Array.isArray(value)) {
                return value.join('\n');
            }
            return String(value);
        }

        // Try to get default from inputSchema if available
        if (inputSchema?.properties?.[varPath]?.default !== undefined) {
            const defaultValue = inputSchema.properties[varPath].default;
            if (defaultValue !== '$provision') {
                return String(defaultValue);
            }
        }

        // Keep placeholder if no value found
        console.warn(`No value found for template variable: ${varPath}`);
        return match;
    });
}

/**
 * Deep substitute variables in an object (recursively processes strings).
 */
export function deepSubstitute(
    obj: any,
    input: Record<string, any>,
    inputSchema?: Record<string, any>
): any {
    if (typeof obj === 'string') {
        return substituteVariables(obj, input, inputSchema);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => deepSubstitute(item, input, inputSchema));
    }
    if (obj && typeof obj === 'object') {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = deepSubstitute(value, input, inputSchema);
        }
        return result;
    }
    return obj;
}

/**
 * Build a blueprint from a template, applying variable substitution.
 * 
 * @param template - Template object with blueprint JSON string and inputSchema
 * @param input - Input values to substitute into the template
 * @returns Processed blueprint with { invariants, context? }
 */
export async function buildBlueprintFromTemplate(
    template: {
        blueprint?: string;
        inputSchema?: Record<string, any>;
        name?: string;
    },
    input: Record<string, any>
): Promise<{ invariants: any[]; context?: string }> {
    // If template has a stored blueprint, parse and use it
    if (template.blueprint) {
        try {
            const storedBlueprint = JSON.parse(template.blueprint);

            // Deep substitute {{variable}} placeholders in invariants
            const substitutedInvariants = deepSubstitute(
                storedBlueprint.invariants || [],
                input,
                template.inputSchema
            );

            // Also substitute in context if present
            const substitutedContext = storedBlueprint.context
                ? deepSubstitute(storedBlueprint.context, input, template.inputSchema)
                : undefined;

            return {
                invariants: substitutedInvariants,
                context: substitutedContext,
            };
        } catch (parseError) {
            console.warn("Failed to parse stored blueprint, falling back to generic:", parseError);
        }
    }

    // Fallback: Generate generic blueprint for templates without stored blueprints
    const fallbackInvariants = [
        {
            id: "TEMPLATE-001",
            invariant: `Execute the ${template.name || 'template'} with the provided input parameters.`,
            measurement: "Template execution completes successfully with expected output.",
            examples: {
                do: ["Follow the template's intended purpose", "Use provided input parameters"],
                dont: ["Deviate from template scope", "Ignore input parameters"]
            }
        },
        {
            id: "OUTPUT-001",
            invariant: "Produce output conforming to the template's output specification.",
            measurement: "All required output fields are present and correctly formatted.",
            examples: {
                do: ["Include all required output fields", "Format output as specified"],
                dont: ["Omit required fields", "Return unstructured data"]
            }
        }
    ];

    return { invariants: fallbackInvariants };
}

/**
 * Load input config from a JSON file.
 */
export async function loadInputConfig(configPath: string): Promise<Record<string, any>> {
    const { readFile } = await import('fs/promises');
    const { resolve } = await import('path');

    const absolutePath = resolve(process.cwd(), configPath);
    const content = await readFile(absolutePath, 'utf-8');
    return JSON.parse(content);
}
