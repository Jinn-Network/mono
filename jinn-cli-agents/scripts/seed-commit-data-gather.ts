#!/usr/bin/env tsx
/**
 * Seed the commit-data-gather template into Supabase and schedule it on Jinn Marketing venture.
 */
import "dotenv/config";
import { createTemplate, getTemplateBySlug, updateTemplate } from "./templates/crud.js";
import * as fs from "fs";

const blueprintFile = JSON.parse(fs.readFileSync("blueprints/commit-data-gather.json", "utf8"));

const blueprint = { invariants: blueprintFile.invariants };
const { inputSchema, outputSpec, tools } = blueprintFile.templateMeta;

async function main() {
  // Check if template already exists
  const existing = await getTemplateBySlug("commit-data-gather");

  if (existing) {
    console.log(`Template already exists: ${existing.id} (${existing.status})`);
    console.log("Updating blueprint...");
    const updated = await updateTemplate({
      id: existing.id,
      blueprint,
      inputSchema,
      outputSpec,
      enabledTools: tools.map((t: { name: string }) => t.name),
      description: blueprintFile.templateMeta.description,
      version: "1.0.0",
      status: "published",
    });
    console.log("Updated:", updated.id, updated.status);
    return updated;
  }

  const template = await createTemplate({
    name: "Commit Data Gather",
    slug: "commit-data-gather",
    description: blueprintFile.templateMeta.description,
    version: "1.0.0",
    blueprint,
    inputSchema,
    outputSpec,
    enabledTools: tools.map((t: { name: string }) => t.name),
    priceWei: "0",
    status: "published",
    ventureId: "9c7a2bb7-7694-4aff-ad93-5e278886cfa1", // Jinn Marketing
  });

  console.log("Created template:", template.id);
  console.log("Slug:", template.slug);
  console.log("Status:", template.status);
  return template;
}

main().catch(e => {
  console.error("Error:", e.message);
  process.exit(1);
});
