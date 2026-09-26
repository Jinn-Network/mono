import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AGENT_DATA_ENV, PRINCIPAL_ENV, WORKSPACE_ENV } from "@/lib/server/product-context";
import { GET, HEAD } from "./route";

const workspaces: string[] = [];
afterEach(() => { delete process.env[WORKSPACE_ENV]; delete process.env[PRINCIPAL_ENV]; delete process.env[AGENT_DATA_ENV]; for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("same-workspace publication HTTP route", () => {
  test("returns exact GET/HEAD bytes with preserved content type and refuses traversal", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "publication-route-")); workspaces.push(workspace);
    const bytes = Buffer.from("exact public bytes"); const digest = createHash("sha256").update(bytes).digest("hex");
    const root = join(workspace, "publication", "public", "publication-artifacts", "sha256"); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, digest), bytes); writeFileSync(join(root, `${digest}.content-type`), "application/example");
    const agentDataDir = join(workspace, "agent-data"); mkdirSync(agentDataDir, { recursive: true });
    process.env[WORKSPACE_ENV] = workspace; process.env[PRINCIPAL_ENV] = "sponsor"; process.env[AGENT_DATA_ENV] = agentDataDir;
    const context = { params: Promise.resolve({ path: ["publication-artifacts", "sha256", digest] }) };
    const get = await GET(new Request("http://example.test/publication/publication-artifacts/sha256/" + digest), context);
    expect(get.status).toBe(200); expect(get.headers.get("content-type")).toBe("application/example"); expect(get.headers.get("cache-control")).toContain("immutable"); expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
    const head = await HEAD(new Request("http://example.test/publication/publication-artifacts/sha256/" + digest, { method: "HEAD" }), context);
    expect(head.status).toBe(200); expect(head.headers.get("content-type")).toBe("application/example"); expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await GET(new Request("http://example.test/publication/anything"), { params: Promise.resolve({ path: ["..", "private"] }) })).status).toBe(404);
  });

  test("serves /lock-index.json with revalidate cache, not as an immutable artifact (#3398)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "publication-route-lock-index-")); workspaces.push(workspace);
    const root = join(workspace, "publication", "public"); mkdirSync(root, { recursive: true });
    const bytes = Buffer.from('{"format":"colophon-archive-lock-index/1","locks":[]}\n');
    writeFileSync(join(root, "lock-index.json"), bytes);
    writeFileSync(join(root, "lock-index.json.content-type"), "application/json");
    const agentDataDir = join(workspace, "agent-data"); mkdirSync(agentDataDir, { recursive: true });
    process.env[WORKSPACE_ENV] = workspace; process.env[PRINCIPAL_ENV] = "sponsor"; process.env[AGENT_DATA_ENV] = agentDataDir;
    const context = { params: Promise.resolve({ path: ["lock-index.json"] }) };
    const get = await GET(new Request("http://example.test/publication/lock-index.json"), context);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/json");
    expect(get.headers.get("cache-control")).toBe("no-cache");
    expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
  });
});
