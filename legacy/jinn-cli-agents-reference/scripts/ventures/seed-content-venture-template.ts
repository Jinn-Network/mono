#!/usr/bin/env tsx
import "dotenv/config";
import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";

const BLUEPRINT_PATH = "blueprints/content-venture-template.json";

interface VentureTemplateBlueprint {
  ventureTemplateMeta: {
    id: string;
    name: string;
    description: string;
    version?: string;
    model?: string;
    safetyTier?: "public" | "private" | "restricted";
    status?: "draft" | "published" | "archived";
    enabledTools?: string[];
    inputSchema?: Record<string, unknown>;
    outputSpec?: Record<string, unknown>;
  };
  blueprint: {
    invariants: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options: { ventureId?: string; status?: "draft" | "published" | "archived" } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];

    if (arg === "--venture-id" && value) {
      options.ventureId = value;
      i++;
      continue;
    }

    if (arg === "--status" && value) {
      if (!["draft", "published", "archived"].includes(value)) {
        throw new Error("--status must be one of: draft | published | archived");
      }
      options.status = value as "draft" | "published" | "archived";
      i++;
    }
  }

  return options;
}

async function main() {
  const { ventureId, status } = parseArgs();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  if (!fs.existsSync(BLUEPRINT_PATH)) {
    throw new Error(`Blueprint not found at ${BLUEPRINT_PATH}`);
  }

  const file = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, "utf8")) as VentureTemplateBlueprint;

  if (!file.ventureTemplateMeta?.id || !file.ventureTemplateMeta?.name) {
    throw new Error("ventureTemplateMeta.id and ventureTemplateMeta.name are required");
  }

  if (!file.blueprint?.invariants || !Array.isArray(file.blueprint.invariants)) {
    throw new Error("blueprint.invariants array is required");
  }

  const meta = file.ventureTemplateMeta;
  const slug = meta.id;

  const record = {
    name: meta.name,
    slug,
    description: meta.description ?? null,
    version: meta.version ?? "1.0.0",
    blueprint: file.blueprint,
    input_schema: meta.inputSchema ?? {},
    output_spec: meta.outputSpec ?? {},
    enabled_tools: meta.enabledTools ?? [],
    model: meta.model ?? "gemini-2.5-flash",
    safety_tier: meta.safetyTier ?? "public",
    venture_id: ventureId ?? null,
    status: status ?? meta.status ?? "draft",
  };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: existing, error: getError } = await supabase
    .from("venture_templates")
    .select("id, slug, status")
    .eq("slug", slug)
    .maybeSingle();

  if (getError) {
    throw new Error(`Failed reading venture_templates: ${getError.message}`);
  }

  if (existing?.id) {
    const { data: updated, error: updateError } = await supabase
      .from("venture_templates")
      .update(record)
      .eq("id", existing.id)
      .select("id, slug, status")
      .single();

    if (updateError) {
      throw new Error(`Failed updating venture template: ${updateError.message}`);
    }

    console.log(`Updated venture template ${updated.slug} (${updated.id}) -> ${updated.status}`);
    return;
  }

  const { data: created, error: createError } = await supabase
    .from("venture_templates")
    .insert(record)
    .select("id, slug, status")
    .single();

  if (createError) {
    throw new Error(`Failed creating venture template: ${createError.message}`);
  }

  console.log(`Created venture template ${created.slug} (${created.id}) -> ${created.status}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
