import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { client, graphql } from "ponder";

const app = new Hono();

// Enable CORS for all routes (required for SSE from different origins)
app.use("/*", cors({
  origin: "*", // Allow all origins (or specify your domains)
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Accept", "Cache-Control"],
  credentials: true,
}));

// ERC-8004 Identity Registry discovery endpoint
app.get("/.well-known/registry.json", (c) => {
  return c.json({
    "type": "https://eips.ethereum.org/EIPS/eip-8004#discovery",
    "publisher": {
      "name": "Jinn Network",
      "url": "https://jinn.network",
    },
    "identityRegistry": {
      "base:8453": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    },
    "documentTypes": [
      "adw:Artifact",
      "adw:Blueprint",
      "adw:Template",
      "adw:Skill",
      "adw:Configuration",
      "adw:Knowledge",
      "adw:AgentCard",
    ],
    "storage": {
      "primary": "ipfs",
      "gateway": "https://gateway.autonolas.tech/ipfs/",
    },
  });
});

// SQL over HTTP for @ponder/client (SSE)
app.use("/sql/*", client({ db, schema }));

// GraphQL API for existing queries
app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

export default app;

