#!/usr/bin/env tsx
/**
 * Generic template dispatch script.
 *
 * Reads a blueprint file + input file, substitutes variables into invariants,
 * and dispatches to the marketplace. Works with any template that follows the
 * standard blueprint format.
 *
 * Variable substitution: any {{key}} in invariants is replaced with the
 * matching value from the input file. {{currentTimestamp}} is always available.
 *
 * Usage:
 *   yarn tsx scripts/dispatch-template.ts <blueprint> <input> [options]
 *
 * Options:
 *   --venture-id <uuid>   Venture ID for worker filtering (default: Jinn Marketing)
 *   --model <model>       Model to use (default: gemini-2.5-flash)
 *
 * Examples:
 *   yarn tsx scripts/dispatch-template.ts \
 *     blueprints/commit-data-gather.json \
 *     blueprints/inputs/commit-data-gather-test.json
 *
 *   yarn tsx scripts/dispatch-template.ts \
 *     blueprints/crypto-token-research.json \
 *     blueprints/inputs/crypto-token-test.json \
 *     --venture-id a68795df-774d-4782-a72e-3c6c73b91bb7
 */

import "dotenv/config";
import * as fs from "fs";
import * as crypto from "crypto";
import { marketplaceInteract } from "@jinn-network/mech-client-ts/dist/marketplace_interact.js";
import { getServiceProfile } from "jinn-node/env/operate-profile.js";

// --- Parse args ---
const args = process.argv.slice(2);
const blueprintPath = args.find((a) => !a.startsWith("--") && a.endsWith(".json"));
const inputPath = args.filter((a) => !a.startsWith("--") && a.endsWith(".json"))[1];

if (!blueprintPath || !inputPath) {
  console.error("Usage: yarn tsx scripts/dispatch-template.ts <blueprint.json> <input.json> [options]");
  process.exit(1);
}

function getOpt(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const ventureId = getOpt("venture-id", "9c7a2bb7-7694-4aff-ad93-5e278886cfa1");
const model = getOpt("model", "gemini-2.5-flash");

// --- Load files ---
const template = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));

// --- Substitute variables into invariants ---
const currentTimestamp = new Date().toISOString();
let invariantsStr = JSON.stringify(template.invariants);

// Replace {{currentTimestamp}} (always available)
invariantsStr = invariantsStr.replace(/\{\{currentTimestamp\}\}/g, currentTimestamp);

// Replace all input keys
for (const [key, value] of Object.entries(input)) {
  const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
  invariantsStr = invariantsStr.replace(regex, String(value));
}

const invariants = JSON.parse(invariantsStr);
const blueprint = JSON.stringify({ invariants });

const slug = template.templateMeta?.id || "template";
const jobDefinitionId = `${slug}-${crypto.randomUUID().slice(0, 8)}`;
const tools = (template.templateMeta?.tools || []).map((t: { name: string }) => t.name);

const ipfsContent = {
  blueprint,
  jobName: template.templateMeta?.name || slug,
  model,
  jobDefinitionId,
  nonce: crypto.randomUUID(),
  outputSpec: template.templateMeta?.outputSpec || {},
  priceWei: template.templateMeta?.priceWei || "0",
  inputSchema: template.templateMeta?.inputSchema || {},
  networkId: "jinn",
  input,
  enabledTools: tools,
  ventureId,
};

const profile = getServiceProfile();

console.log(`Dispatching: ${template.templateMeta?.name || blueprintPath}`);
console.log(`  Blueprint: ${blueprintPath}`);
console.log(`  Input:     ${inputPath}`);
console.log(`  Tools:     ${tools.join(", ")}`);
console.log(`  Model:     ${model}`);
console.log(`  Venture:   ${ventureId}`);
console.log(`  Timestamp: ${currentTimestamp}`);

const result = await marketplaceInteract({
  prompts: [blueprint],
  priorityMech: profile.mechAddress,
  tools,
  ipfsJsonContents: [ipfsContent],
  chainConfig: profile.chainConfig,
  keyConfig: { source: "value", value: profile.privateKey },
  postOnly: true,
  responseTimeout: 61,
});

const requestId = result.request_ids?.[0];
console.log(`\nDispatched! Request ID: ${requestId}`);
console.log(`Explorer: https://explorer.jinn.network/workstreams/${requestId}`);
console.log(`\nTo execute locally:`);
console.log(`  MECH_TARGET_REQUEST_ID=${requestId} yarn dev:mech --single`);
