#!/usr/bin/env tsx
/**
 * Dispatch single-question-test.json template for OutputSpec passthrough verification.
 * Creates a non-delegating job that should complete quickly.
 */

import "dotenv/config";
import * as fs from "fs";
import * as crypto from "crypto";
import { marketplaceInteract } from "@jinn-network/mech-client-ts/dist/marketplace_interact.js";
import { getServiceProfile } from "jinn-node/env/operate-profile.js";
import { getRandomStakedMech } from "jinn-node/worker/filters/stakingFilter.js";

const template = JSON.parse(fs.readFileSync("blueprints/single-question-test.json", "utf8"));
const question = process.argv[2] || "What is 2+2?";

// Substitute {{question}} in invariants
const invariants = JSON.parse(JSON.stringify(template.invariants).replace(/\{\{question\}\}/g, question));
const blueprint = JSON.stringify({ invariants });

// Generate unique job definition ID with hash for template matching
const contentHash = crypto.createHash('md5').update(blueprint).digest('hex').slice(0, 8);
const templateId = `single-question-test-${contentHash}`;

const ipfsContent = {
  blueprint,
  jobName: `Single Question Test - ${question.slice(0, 30)}`,
  model: "gemini-2.5-flash",
  jobDefinitionId: templateId,
  nonce: crypto.randomUUID(),
  // OutputSpec passthrough - this is what we're testing
  outputSpec: template.outputSpec,
  templateId,
  priceWei: template.priceWei,
  priceUsd: template.priceUsd,
  inputSchema: template.inputSchema,
  networkId: "jinn",
};

const profile = getServiceProfile();
console.log("Dispatching single-question template...");
console.log("Question:", question);
console.log("Template ID:", templateId);
console.log("OutputSpec:", JSON.stringify(template.outputSpec, null, 2));

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

const requestId = result.request_ids?.[0];
console.log("\n=== Dispatched ===");
console.log("Request ID:", requestId);
console.log("\nRun worker:");
console.log(`MECH_TARGET_REQUEST_ID=${requestId} yarn dev:mech --single`);
console.log("\nCheck result (after delivery):");
console.log(`curl https://x402-gateway-production.up.railway.app/runs/${requestId}/result | jq '{status, hasOutputSpec: (.outputSpec != null), outputSpec}'`);
