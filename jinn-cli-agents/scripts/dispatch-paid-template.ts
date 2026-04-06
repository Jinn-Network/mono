#!/usr/bin/env tsx
/**
 * Execute a template via the x402 gateway.
 * 
 * Usage: yarn dispatch-paid-template <templateId> [--input '{"key": "value"}']
 * Example: yarn dispatch-paid-template simple-paid-test-template --input '{"topic": "smart contracts"}'
 */

import "dotenv/config";
import { logger } from "jinn-node/logging/index.js";

const GATEWAY_URL = process.env.X402_GATEWAY_URL || "https://x402-gateway-production.up.railway.app";

async function main() {
  const templateId = process.argv[2];
  
  if (!templateId) {
    console.error("Usage: yarn dispatch-paid-template <templateId> [--input '{...}']");
    console.error("\nList templates: curl " + GATEWAY_URL + "/templates | jq");
    process.exit(1);
  }
  
  // Parse --input flag
  let input: Record<string, any> = {};
  const inputIdx = process.argv.indexOf("--input");
  if (inputIdx !== -1 && process.argv[inputIdx + 1]) {
    try {
      input = JSON.parse(process.argv[inputIdx + 1]);
    } catch {
      console.error("Invalid JSON for --input");
      process.exit(1);
    }
  }
  
  logger.info({ templateId, input, gateway: GATEWAY_URL }, "Executing template via x402 gateway");
  
  // Call gateway execute endpoint
  const res = await fetch(`${GATEWAY_URL}/templates/${templateId}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  
  const data = await res.json();
  
  if (!res.ok) {
    logger.error({ status: res.status, data }, "Execute failed");
    console.error("\nError:", JSON.stringify(data, null, 2));
    process.exit(1);
  }
  
  const requestId = data.requestId;
  
  console.log("\n=== Template Executed ===");
  console.log(`Request ID: ${requestId}`);
  console.log(`Template: ${templateId}`);
  console.log(`\nPoll status: curl ${GATEWAY_URL}/runs/${requestId}/status`);
  console.log(`Get result:  curl ${GATEWAY_URL}/runs/${requestId}/result`);
  console.log(`\nOr run worker: yarn dev:mech --workstream=${requestId} --single`);
}

main().catch((err) => {
  logger.error({ error: err }, "Fatal error");
  process.exit(1);
});
