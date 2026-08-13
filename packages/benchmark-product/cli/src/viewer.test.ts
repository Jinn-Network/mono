import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { VerifiedPublicBundleSnapshot } from "@colophon-claims/verify";
import { createVerifiedBundleViewer, type VerifiedBundleViewer } from "./viewer.js";

const roots: string[] = [];
const viewers: VerifiedBundleViewer[] = [];

afterEach(async () => {
  await Promise.all(viewers.splice(0).map((viewer) => viewer.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authenticated(files: Readonly<Record<string, string>>): VerifiedPublicBundleSnapshot {
  const encoder = new TextEncoder();
  const entries = Object.entries(files);
  const manifest = {
    format: "benchmark-product-public-bundle/2" as const,
    files: entries.map(([path, value]) => ({ path, sha256: "a".repeat(64), bytes: encoder.encode(value).length })),
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  return {
    verification: {
      identity: "b".repeat(64),
      checks: ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
      benchmarkSha256: "c".repeat(64),
      runSha256: "d".repeat(64),
      matrixSha256: "e".repeat(64),
      reportSha256: "f".repeat(64),
      reportEnvelopeSha256: "1".repeat(64),
    },
    snapshot: {
      manifest,
      bytes: manifestBytes,
      identity: "b".repeat(64),
      fileBytes: new Map([
        ["bundle.json", manifestBytes],
        ...entries.map(([path, value]) => [path, encoder.encode(value)] as const),
      ]),
    },
  };
}

async function claim(viewer: VerifiedBundleViewer): Promise<{ readonly cookie: string; readonly base: string }> {
  const response = await fetch(viewer.url, { redirect: "manual" });
  expect(response.status).toBe(303);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeDefined();
  return { cookie: cookie!, base: `http://127.0.0.1:${viewer.port}` };
}

describe("verified bundle viewer", () => {
  test("serves every authenticated report link from the verified snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-viewer-"));
    roots.push(root);
    const linked = [
      "matrix.json",
      "verification/assembly.jsonl",
      `records/${"2".repeat(64)}.bin`,
      `native/inspect/${"3".repeat(64)}.eval`,
    ];
    const originalIndex = `<html><body>${linked.map((path) => `<a href="${path}">${path}</a>`).join("")}</body></html>`;
    writeFileSync(join(root, "index.html"), originalIndex);
    const snapshot = authenticated({
      "index.html": originalIndex,
      "matrix.json": "{\"verified\":true}",
      "verification/assembly.jsonl": "{\"kind\":\"header\"}\n",
      [`records/${"2".repeat(64)}.bin`]: "sealed record",
      [`native/inspect/${"3".repeat(64)}.eval`]: "inspect log",
    });
    const viewer = await createVerifiedBundleViewer(root, 0, { verify: async () => snapshot });
    viewers.push(viewer);

    expect((await fetch(`http://127.0.0.1:${viewer.port}/`)).status).toBe(403);
    const session = await claim(viewer);
    expect((await fetch(viewer.url, { redirect: "manual" })).status).toBe(403);

    for (const path of ["index.html", ...linked]) {
      const response = await fetch(`${session.base}/bundle/${path}`, { headers: { cookie: session.cookie } });
      expect(response.status, path).toBe(200);
    }
    expect((await fetch(`${session.base}/bundle/matrix.json`, { headers: { cookie: session.cookie } })).headers.get("content-type"))
      .toBe("application/json; charset=utf-8");
  });

  test("keeps displaying authenticated bytes after the source path is replaced and deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-viewer-snapshot-"));
    roots.push(root);
    const path = join(root, "index.html");
    writeFileSync(path, "verified report");
    const snapshot = authenticated({ "index.html": "verified report" });
    const viewer = await createVerifiedBundleViewer(root, 0, { verify: async () => snapshot });
    viewers.push(viewer);
    const session = await claim(viewer);

    writeFileSync(path, "replaced after verification");
    let response = await fetch(`${session.base}/bundle/index.html`, { headers: { cookie: session.cookie } });
    expect(await response.text()).toBe("verified report");

    unlinkSync(path);
    response = await fetch(`${session.base}/bundle/index.html`, { headers: { cookie: session.cookie } });
    expect(await response.text()).toBe("verified report");
  });
});
