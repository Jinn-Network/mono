import { randomUUID } from "node:crypto";
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
      format: "benchmark-product-public-bundle/2",
      identity: "b".repeat(64),
      checks: ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
      benchmarkSha256: "c".repeat(64),
      runSha256: "d".repeat(64),
      matrixSha256: "e".repeat(64),
      reportSha256: "f".repeat(64),
      reportEnvelopeSha256: "1".repeat(64),
    },
    comparison: {
      profile: "colophon-public-comparison/1",
      sampleKind: "bundled-prediction",
      tasks: [{
        digest: "2".repeat(64),
        profileUri: "https://spec.jinn.network/task-execution/profiles/prediction-forecast/v1",
        label: "Will the sample event happen?",
        summary: "Synthetic sample resolution: Yes.",
        evidencePath: `records/${"2".repeat(64)}.bin`,
      }],
      arms: ["baseline", "candidate"],
      cells: ["baseline", "candidate"].map((armId, index) => ({
        cellKey: `${armId}-cell`,
        taskDigest: "2".repeat(64),
        armId,
        replicate: 0,
        outcome: "judged" as const,
        outputSummary: `Forecast ${index === 0 ? "60" : "80"}% Yes`,
        primaryScore: { name: "solverBrier" as const, value: index === 0 ? "0.16" : "0.04", direction: "lower-is-better" as const },
        outputs: [],
        verdicts: [],
        evidencePaths: [],
      })),
      descriptiveComparison: {
        kind: "paired-measurement",
        measurement: "solverBrier",
        direction: "lower-is-better",
        firstArm: "baseline",
        secondArm: "candidate",
        pairedCells: 1,
        lowerByFirst: 0,
        lowerBySecond: 1,
        ties: 0,
        formalWinner: false,
      },
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

/** A verified metadata-first evidence-native bundle (issue #2986): artifact digests, no bodies. */
function metadataFirstSnapshot(notFetchedDigests: readonly string[]): VerifiedPublicBundleSnapshot {
  const encoder = new TextEncoder();
  const manifest = {
    format: "benchmark-product-public-bundle/5" as const,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first" as const,
    files: [{ path: "report.json", sha256: "a".repeat(64), bytes: 2 }],
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  return {
    verification: {
      format: "benchmark-product-public-bundle/5",
      profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
      identity: `sha256:${"b".repeat(64)}`,
      checks: [
        "manifest", "evidence-closure", "artifact-integrity", "signature-validity",
        "matrix-rederivation", "report-verification", "claim-consistency",
      ],
      artifactContent: {
        status: "not-fetched",
        verified: 2,
        notFetched: notFetchedDigests.length,
        notFetchedDigests,
      },
      benchmarkDigest: `sha256:${"c".repeat(64)}`,
      manifestDigest: `sha256:${"d".repeat(64)}`,
      cohortDigest: `sha256:${"e".repeat(64)}`,
      matrixDigest: `sha256:${"f".repeat(64)}`,
      reportDigest: `sha256:${"1".repeat(64)}`,
      evidenceRecords: 336,
      artifacts: 5,
      verifiedSignerKeyIds: [],
    },
    snapshot: {
      manifest,
      bytes: manifestBytes,
      identity: `sha256:${"b".repeat(64)}`,
      fileBytes: new Map([
        ["bundle.json", manifestBytes],
        ["report.json", encoder.encode("{}")],
      ]),
    },
  };
}

describe("verified bundle viewer", () => {
  test("never folds a deferred artifact check into the headline pass count", async () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-viewer-metadata-first-"));
    roots.push(root);
    writeFileSync(join(root, "report.json"), "{}");
    const snapshot = metadataFirstSnapshot(["1".repeat(64), "2".repeat(64), "3".repeat(64)]);
    const viewer = await createVerifiedBundleViewer(root, 0, { verify: async () => snapshot });
    viewers.push(viewer);
    const session = await claim(viewer);
    const page = await (await fetch(session.base, { headers: { cookie: session.cookie } })).text();

    expect(page).toContain("6 of 7 bundle checks passed, 1 not fetched.");
    expect(page).not.toContain("7 of 7 bundle checks passed");
    expect(page).toContain("<strong>artifact-integrity</strong> <span class=\"deferred\">not fetched</span>");
    expect(page).toContain("<strong>manifest</strong> <span class=\"pass\">passed</span>");
    // The deferred state must not be painted in the success colour.
    expect(page).toContain(".checks span.deferred{color:#9d6b23}");
    expect(page).toContain("3 artifact bodies were not fetched.");
    // No released npx reader understands this profile, so the page must not hand out one.
    expect(page).not.toContain("npx @colophon-claims/verify@0.1");
    expect(page).toContain("colophon bundle verify --bundle");
  });


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

  test("puts the comparison and explicit next actions before the embedded report", async () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-viewer-aha-"));
    roots.push(root);
    writeFileSync(join(root, "index.html"), "verified report");
    const snapshot = authenticated({ "index.html": "verified report", "evidence.json": "{}" });
    let workspaceStarts = 0;
    let workspaceCloses = 0;
    const viewer = await createVerifiedBundleViewer(root, 0, {
      verify: async () => snapshot,
      startWorkspace: async () => {
        workspaceStarts += 1;
        return { url: "http://127.0.0.1:44000/launch", close: async () => { workspaceCloses += 1; } };
      },
    });
    viewers.push(viewer);
    const session = await claim(viewer);
    const home = await fetch(session.base, { headers: { cookie: session.cookie } });
    const html = await home.text();
    expect(html).toContain("Complete comparison on 1 sample tasks");
    expect(html).toContain("candidate had lower solverBrier in 1");
    expect(html.indexOf("What happened, task by task")).toBeLessThan(html.indexOf("Published report"));
    expect(html).toContain("Use my work");
    expect(html).toContain("Copy verification command");

    const action = await fetch(`${session.base}/use-my-work`, {
      method: "POST",
      headers: { cookie: session.cookie },
      redirect: "manual",
    });
    expect(action.status).toBe(303);
    expect(action.headers.get("location")).toBe("http://127.0.0.1:44000/launch");
    expect(workspaceStarts).toBe(1);
    expect((await fetch(`${session.base}/use-my-work`, { method: "POST", headers: { cookie: session.cookie } })).status).toBe(405);
    await viewer.close();
    viewers.pop();
    expect(workspaceCloses).toBe(1);
  });

  test("renders the neutral v4 qualification summary and format-scoped reader2 command", async () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-viewer-v4-"));
    roots.push(root);
    writeFileSync(join(root, "index.html"), "verified report");
    const base = authenticated({ "index.html": "verified report", "evidence.json": "{}" });
    if (base.verification.format !== "benchmark-product-public-bundle/2") throw new Error("legacy fixture drifted");
    const { comparison: _comparison, ...snapshot } = base;
    const v4: VerifiedPublicBundleSnapshot = {
      ...snapshot,
      verification: {
        ...base.verification,
        format: "benchmark-product-public-bundle/4",
        qualification: {
          publicationGrade: true,
          truthAdmission: "two-human-unanimous",
          candidateClasses: ["factuality"],
          strata: ["core", "stress"],
          armCount: 4,
          itemCount: 2,
          exclusionCount: 0,
        },
      },
    };
    const viewer = await createVerifiedBundleViewer(root, 0, { verify: async () => v4 });
    viewers.push(viewer);
    const session = await claim(viewer);
    const html = await (await fetch(session.base, { headers: { cookie: session.cookie } })).text();
    expect(html).toContain("Verified binary qualification");
    expect(html).toContain("two-human-unanimous");
    expect(html).toContain("factuality");
    expect(html).toContain("@colophon-claims/verify@0.1");
    expect(html).not.toContain("What happened, task by task");
  });

  test("keeps a packaged-workspace start failure out of the browser response and permits a retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-viewer-start-failure-"));
    roots.push(root);
    writeFileSync(join(root, "index.html"), "verified report");
    const snapshot = authenticated({ "index.html": "verified report" });
    let attempts = 0;
    const privateDiagnostic = `/private/operator/auth-${randomUUID()}.json`;
    const viewer = await createVerifiedBundleViewer(root, 0, {
      verify: async () => snapshot,
      startWorkspace: async () => {
        attempts += 1;
        throw new Error(privateDiagnostic);
      },
    });
    viewers.push(viewer);
    const session = await claim(viewer);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await fetch(`${session.base}/use-my-work`, {
        method: "POST",
        headers: { cookie: session.cookie },
      });
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(body).toContain("Return to the terminal for the local diagnostic");
      expect(body).not.toContain(privateDiagnostic);
      expect(attempts).toBe(attempt);
    }
  });
});
