import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";

import { createFsBlobStore } from "./fs-blob-store.js";
import { createArchiveHttpHandler } from "./handler.js";

// The mount contract the operator API server consumes at cutover stage 4
// (wiring itself is stage 4's job, not this plan's): the handler is a
// plain `(Request) => Promise<Response>`, so one Hono route carries the
// whole public archive subtree, and every other route on the same app
// stays on the authenticated surface. Cross-plan contract 7 is a
// property of the handler, not of the mount: even mounted at `/*` it
// answers nothing outside the archive grammar.
describe("archive handler mounted on a Hono app", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jinn-transport-http-mount-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves the archive subtree and leaks no sibling route", async () => {
    const store = createFsBlobStore(root);
    await store.put(WELL_KNOWN_PATH, new TextEncoder().encode('{"protocol":"x","sources":[]}'), "application/json");

    const handler = createArchiveHttpHandler({ reader: store, basePath: "/v1/archive" });
    const app = new Hono();
    app.get("/v1/status", (c) => c.json({ secret: "operator-only" }));
    app.all("/v1/archive", (c) => handler(c.req.raw));
    app.all("/v1/archive/*", (c) => handler(c.req.raw));

    const served = await app.request(`http://host/v1/archive${WELL_KNOWN_PATH}`);
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ protocol: "x", sources: [] });

    for (const path of [
      "/v1/archive/v1/status",
      "/v1/archive/../v1/status",
      "/v1/archive/",
      "/v1/archive/sources",
    ]) {
      const response = await app.request(`http://host${path}`);
      expect([404, 301, 308], path).toContain(response.status);
      if (response.status === 200) throw new Error(`archive mount leaked ${path}`);
    }

    // The sibling route still works for the host itself.
    const status = await app.request("http://host/v1/status");
    expect(status.status).toBe(200);
  });
});
