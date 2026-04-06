#!/usr/bin/env tsx
/**
 * One-time script to dispatch a job with correct assertions blueprint.
 * This creates a new template in Ponder with proper format.
 */

import "dotenv/config";
import * as fs from "fs";
import * as crypto from "crypto";
import { marketplaceInteract } from "@jinn-network/mech-client-ts/dist/marketplace_interact.js";
import { getServiceProfile } from "jinn-node/env/operate-profile.js";
import { getRandomStakedMech } from "jinn-node/worker/filters/stakingFilter.js";

const template = JSON.parse(fs.readFileSync("blueprints/simple-paid-test.json", "utf8"));
const topic = "DeFi protocols";
const assertions = JSON.parse(JSON.stringify(template.assertions).replace(/\{\{topic\}\}/g, topic));
const blueprint = JSON.stringify({ assertions });
const jobDefinitionId = "simple-paid-v2-" + crypto.randomUUID().slice(0, 8);

const ipfsContent = {
  blueprint,
  jobName: "Simple Paid Test v2 - " + topic,
  model: "gemini-2.5-flash",
  jobDefinitionId,
  nonce: crypto.randomUUID(),
  outputSpec: template.outputSpec,
  priceWei: template.priceWei,
  priceUsd: template.priceUsd,
  inputSchema: template.inputSchema,
  networkId: "jinn",
};

const profile = getServiceProfile();
console.log("Dispatching with correct assertions blueprint...");
console.log("Job Definition ID:", jobDefinitionId);

const priorityMech = await getRandomStakedMech(profile.mechAddress);
const result = await marketplaceInteract({
  prompts: [blueprint],
  priorityMech,
  tools: template.enabledTools || [],
  ipfsJsonContents: [ipfsContent],
  chainConfig: profile.chainConfig,
  keyConfig: { source: "value", value: profile.privateKey },
  postOnly: true,
  responseTimeout: 61,
});

console.log("Request ID:", result.request_ids?.[0]);
console.log("\nNew template will be created in Ponder after indexing.");
console.log("Check: curl -s -X POST 'https://indexer.jinn.network/graphql' -H 'Content-Type: application/json' -d '{\"query\":\"{ jobTemplates(where: { name_contains: \\\"v2\\\" }, limit: 5) { items { id name blueprint } } }\"}' | jq");
