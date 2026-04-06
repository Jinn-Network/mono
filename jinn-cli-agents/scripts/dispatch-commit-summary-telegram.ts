#!/usr/bin/env tsx
/**
 * Dispatch the commit-summary-telegram template to post commit highlights to Telegram.
 */

import "dotenv/config";
import * as fs from "fs";
import * as crypto from "crypto";
import { marketplaceInteract } from "@jinn-network/mech-client-ts/dist/marketplace_interact.js";
import { getServiceProfile } from "jinn-node/env/operate-profile.js";
import { getRandomStakedMech } from "jinn-node/worker/filters/stakingFilter.js";

const template = JSON.parse(fs.readFileSync("blueprints/commit-summary-telegram.json", "utf8"));
const input = JSON.parse(fs.readFileSync("blueprints/inputs/commit-summary-test.json", "utf8"));

// Substitute input values into invariants
const currentTimestamp = new Date().toISOString();
let invariantsStr = JSON.stringify(template.invariants);
invariantsStr = invariantsStr.replace(/\{\{repoUrl\}\}/g, input.repoUrl);
invariantsStr = invariantsStr.replace(/\{\{timePeriod\}\}/g, input.timePeriod);
invariantsStr = invariantsStr.replace(/\{\{currentTimestamp\}\}/g, currentTimestamp);
const invariants = JSON.parse(invariantsStr);

const blueprint = JSON.stringify({ invariants });
const jobDefinitionId = `commit-summary-${crypto.randomUUID().slice(0, 8)}`;

// Get tools from template
const tools = template.templateMeta.tools.map((t: { name: string }) => t.name);

const ipfsContent = {
  blueprint,
  jobName: template.templateMeta.name,
  model: "gemini-2.5-flash",
  jobDefinitionId,
  nonce: crypto.randomUUID(),
  outputSpec: template.templateMeta.outputSpec,
  priceWei: template.templateMeta.priceWei || "0",
  inputSchema: template.templateMeta.inputSchema,
  networkId: "jinn",
  input, // Include the actual input values
  enabledTools: tools, // Include tools in IPFS content so worker can read them
};

const profile = getServiceProfile();
console.log("Dispatching commit-summary-telegram template...");
console.log("Job Definition ID:", jobDefinitionId);
console.log("Input:", JSON.stringify(input, null, 2));
console.log("Tools:", tools);
console.log("Current timestamp:", currentTimestamp);

const priorityMech = await getRandomStakedMech(profile.mechAddress);
const result = await marketplaceInteract({
  prompts: [blueprint],
  priorityMech,
  tools,
  ipfsJsonContents: [ipfsContent],
  chainConfig: profile.chainConfig,
  keyConfig: { source: "value", value: profile.privateKey },
  postOnly: true,
  responseTimeout: 61,
});

const requestId = result.request_ids?.[0];
console.log("\n✅ Template dispatched successfully!");
console.log("Request ID:", requestId);
console.log(`\n🔗 Explorer: https://explorer.jinn.network/workstreams/${requestId}`);
console.log(`\n🔧 To process this request:`);
console.log(`   MECH_TARGET_REQUEST_ID=${requestId} yarn mech --single`);
