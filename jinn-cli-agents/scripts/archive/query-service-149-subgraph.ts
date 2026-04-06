#!/usr/bin/env tsx
/**
 * Query Service #149 from OLAS Mech Marketplace Subgraph
 * 
 * Uses the subgraph endpoint that the Autonolas frontend uses.
 */

import "dotenv/config";

// Base Mech Marketplace Subgraph
// Source: https://github.com/valory-xyz/autonolas-frontend-mono
const BASE_MM_SUBGRAPH_URL = "https://api.studio.thegraph.com/query/57238/mech-marketplace-base/version/latest";

const SAFE_ADDRESS = "0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645";

async function queryServiceFromSubgraph() {
  console.log("🔍 Querying Mech Marketplace Subgraph (Base)");
  console.log(`Looking for Safe: ${SAFE_ADDRESS}`);
  console.log("=".repeat(80));
  console.log();

  // First, try to introspect the schema
  const schemaQuery = `
    {
      __schema {
        types {
          name
          kind
        }
      }
    }
  `;

  console.log("📋 Introspecting subgraph schema...");
  const schemaResponse = await fetch(BASE_MM_SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: schemaQuery }),
  });
  const schemaData = await schemaResponse.json();
  console.log("Available entity types:");
  console.log(schemaData.data?.__schema?.types
    .filter((t: any) => t.kind === "OBJECT" && !t.name.startsWith("_"))
    .map((t: any) => `  - ${t.name}`)
    .join("\n"));
  console.log();

  // GraphQL query for mech (service) details by address
  const query = `
    {
      meches(where: { owner: "${SAFE_ADDRESS.toLowerCase()}" }) {
        id
        address
        mechFactory
        owner
        configHash
      }
      requests(where: { service: "${SAFE_ADDRESS.toLowerCase()}" }, first: 5, orderBy: blockTimestamp, orderDirection: desc) {
        id
        requestId
        sender
        blockTimestamp
      }
      delivers(where: { service: "${SAFE_ADDRESS.toLowerCase()}" }, first: 5, orderBy: blockTimestamp, orderDirection: desc) {
        id
        requestId
        sender
        blockTimestamp
      }
    }
  `;

  try {
    const response = await fetch(BASE_MM_SUBGRAPH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    console.log("📥 Raw Response:");
    console.log(JSON.stringify(data, null, 2));
    console.log();

    if (data.errors) {
      console.error("❌ GraphQL Errors:");
      console.error(JSON.stringify(data.errors, null, 2));
      process.exit(1);
    }

    if (!data.data) {
      console.log("❌ No data returned from subgraph");
      process.exit(1);
    }

    const { meches, requests, delivers } = data.data;
    
    console.log("✅ Query Results!");
    console.log("-".repeat(80));
    console.log(`Meches owned by Safe: ${meches?.length || 0}`);
    console.log(`Recent Requests: ${requests?.length || 0}`);
    console.log(`Recent Delivers: ${delivers?.length || 0}`);
    console.log();

    if (meches && meches.length > 0) {
      console.log("🤖 Deployed Mechs:");
      meches.forEach((mech: any) => {
        console.log(`  - Mech Address: ${mech.address}`);
        console.log(`    ID: ${mech.id}`);
        console.log(`    Factory: ${mech.mechFactory}`);
        console.log(`    Config Hash: ${mech.configHash}`);
        console.log();
      });
    }

    if (requests && requests.length > 0) {
      console.log("📥 Recent Requests:");
      requests.forEach((req: any) => {
        console.log(`  - Request ID: ${req.requestId}`);
        console.log(`    From: ${req.sender}`);
        console.log(`    Time: ${new Date(Number(req.blockTimestamp) * 1000).toISOString()}`);
        console.log();
      });
    }

    if (delivers && delivers.length > 0) {
      console.log("📤 Recent Delivers:");
      delivers.forEach((del: any) => {
        console.log(`  - Request ID: ${del.requestId}`);
        console.log(`    From: ${del.sender}`);
        console.log(`    Time: ${new Date(Number(del.blockTimestamp) * 1000).toISOString()}`);
        console.log();
      });
    }

    console.log("🔗 View Safe on BaseScan:");
    console.log(`https://basescan.org/address/${SAFE_ADDRESS}`);

  } catch (error) {
    console.error("❌ Error querying subgraph:");
    console.error(error);
    process.exit(1);
  }
}

queryServiceFromSubgraph();
