#!/usr/bin/env tsx
/**
 * Seed (or update) a template in Supabase from a blueprint file.
 *
 * Reads the blueprint's templateMeta to extract name, slug, description,
 * inputSchema, outputSpec, and tools. Creates the template if it doesn't
 * exist, or updates it if it does (matched by slug).
 *
 * Usage:
 *   yarn tsx scripts/templates/seed-from-blueprint.ts <blueprint-file> [options]
 *
 * Options:
 *   --venture-id <uuid>    Associate with a venture
 *   --status <status>      draft | published | archived (default: draft)
 *   --version <ver>        Version string (default: 1.0.0)
 *   --price-wei <wei>      Price in wei (default: 0)
 *
 * Examples:
 *   # Seed as draft
 *   yarn tsx scripts/templates/seed-from-blueprint.ts blueprints/commit-data-gather.json
 *
 *   # Seed as published, linked to Jinn Marketing venture
 *   yarn tsx scripts/templates/seed-from-blueprint.ts blueprints/commit-data-gather.json \
 *     --status published --venture-id 9c7a2bb7-7694-4aff-ad93-5e278886cfa1
 *
 *   # Update an existing template (matched by slug from templateMeta.id)
 *   yarn tsx scripts/templates/seed-from-blueprint.ts blueprints/commit-data-gather.json --status published
 */
import "dotenv/config";
import * as fs from "fs";
import { createTemplate, getTemplateBySlug, updateTemplate } from "./crud.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const blueprintPath = args[0];

  if (!blueprintPath || blueprintPath.startsWith("--")) {
    console.error("Usage: yarn tsx scripts/templates/seed-from-blueprint.ts <blueprint-file> [options]");
    console.error("");
    console.error("Options:");
    console.error("  --venture-id <uuid>    Associate with a venture");
    console.error("  --status <status>      draft | published | archived (default: draft)");
    console.error("  --version <ver>        Version string (default: 1.0.0)");
    console.error("  --price-wei <wei>      Price in wei (default: 0)");
    process.exit(1);
  }

  const opts: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      const key = args[i].slice(2);
      opts[key] = args[i + 1];
      i++;
    }
  }

  return { blueprintPath, opts };
}

async function main() {
  const { blueprintPath, opts } = parseArgs();

  if (!fs.existsSync(blueprintPath)) {
    console.error(`Blueprint file not found: ${blueprintPath}`);
    process.exit(1);
  }

  const blueprintFile = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));

  // Validate structure
  if (!blueprintFile.templateMeta) {
    console.error("Blueprint file must have a 'templateMeta' section with id, name, description, inputSchema, outputSpec, and tools.");
    process.exit(1);
  }
  if (!blueprintFile.invariants || !Array.isArray(blueprintFile.invariants)) {
    console.error("Blueprint file must have an 'invariants' array at the top level.");
    process.exit(1);
  }

  const meta = blueprintFile.templateMeta;
  const slug = meta.id || meta.slug || meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const blueprint = { invariants: blueprintFile.invariants };
  const enabledTools = (meta.tools || []).map((t: { name: string }) => t.name);
  const status = opts.status || "draft";
  const version = opts.version || "1.0.0";
  const priceWei = opts["price-wei"] || meta.priceWei || "0";
  const ventureId = opts["venture-id"] || undefined;

  // Check if template already exists
  const existing = await getTemplateBySlug(slug);

  if (existing) {
    console.log(`Template "${slug}" already exists: ${existing.id} (${existing.status})`);
    console.log("Updating...");
    const updated = await updateTemplate({
      id: existing.id,
      blueprint,
      inputSchema: meta.inputSchema,
      outputSpec: meta.outputSpec,
      enabledTools,
      description: meta.description,
      version,
      status,
      ...(ventureId ? { ventureId } : {}),
    });
    console.log(`Updated: ${updated.id} → ${updated.status}`);
    return;
  }

  const template = await createTemplate({
    name: meta.name,
    slug,
    description: meta.description,
    version,
    blueprint,
    inputSchema: meta.inputSchema,
    outputSpec: meta.outputSpec,
    enabledTools,
    priceWei,
    status,
    ventureId,
  });

  console.log(`Created template: ${template.id}`);
  console.log(`  Slug:    ${template.slug}`);
  console.log(`  Status:  ${template.status}`);
  console.log(`  Version: ${version}`);
  if (ventureId) console.log(`  Venture: ${ventureId}`);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
