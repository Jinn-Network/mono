/**
 * The anchor surface's two verbs and the `lock` chaining (anchor-evidence design §7.2, §7.3),
 * through `runCli` exactly as `bin.ts` calls it.
 *
 * Every acquisition source is injected through `CliContext.anchorDeps`, so nothing here reaches a
 * network, and the failure cases fail for the reason the test names rather than because a host is
 * unreachable.
 *
 * The load-bearing assertion is the §7.2 one: a lock whose anchor attempt fails is byte-for-byte
 * the lock it would have been with no provider configured at all — same exit code, same single
 * JSON envelope, same result keys — with the failure visible only in the audit journal and (in
 * human mode) a note.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OPENTIMESTAMPS_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE } from "@jinn-network/trust-core";
import type { AnchorProofSource } from "@jinn-network/trust-core";
import { KIT_AUTHORITY_SEED, createFixtureAuthority } from "@jinn-network/trust-testing";
import { readAuditEntries } from "../audit/journal.js";
import { PRODUCT_BRANDING } from "../branding.js";
import type { WorkspaceAnchoringEntry } from "../workspace/workspace.js";
import { runCli } from "./main.js";
import type { CliContext, CliResult } from "./result.js";

const TSA_ENDPOINT = "https://timestamp.invalid/tsr";
const authority = createFixtureAuthority(KIT_AUTHORITY_SEED);

let workspaceDir: string;
let tick: number;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "anchor-cli-"));
  tick = 0;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function clock(): string {
  return `2026-08-17T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(sources?: Readonly<Record<string, AnchorProofSource>>): CliContext {
  return { cwd: workspaceDir, clock, ...(sources === undefined ? {} : { anchorDeps: { sources } }) };
}

interface JsonEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: { readonly code: string; readonly detail: string };
}

function parseJson<T>(stdout: string): JsonEnvelope<T> {
  return JSON.parse(stdout) as JsonEnvelope<T>;
}

function base(): readonly string[] {
  return ["--workspace", workspaceDir, "--principal", "sponsor-1"];
}

/** A workspace with one sample draft carrying two arms, quoted and ready to lock. */
async function setUpQuotedDraft(context: CliContext, draftId = "anchor-draft"): Promise<void> {
  const run = async (argv: readonly string[]): Promise<CliResult> => {
    const result = await runCli([...argv, "--json"], context);
    if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stdout}${result.stderr}`);
    return result;
  };
  await run(["init", ...base()]);
  await run(["draft", "create", ...base(), "--name", "Anchor Draft", "--id", draftId]);
  await run(["sample", "init", ...base(), "--draft", draftId]);
  await run([
    "arm", "add", ...base(), "--draft", draftId, "--arm", "baseline",
    "--pinning", JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } }),
  ]);
  await run([
    "arm", "add", ...base(), "--draft", draftId, "--arm", "sample",
    "--pinning", JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } }),
  ]);
  await run(["quote", ...base(), "--draft", draftId]);
}

/** An acquisition that never returns a proof, standing in for every transport-level failure. */
function explodingSource(profile: string): AnchorProofSource {
  return {
    profile,
    async obtainProof() {
      throw new Error("the configured authority was unreachable");
    },
  };
}

function mintingSource(subjectSha256: string): AnchorProofSource {
  const minted = authority.mintTimeStampToken({ subjectSha256 });
  return {
    profile: RFC3161_TSA_ANCHOR_PROFILE,
    async obtainProof() {
      return minted.tokenDer;
    },
  };
}

async function configureAnchoring(context: CliContext, endpoint = TSA_ENDPOINT): Promise<void> {
  const configured = await runCli(
    ["anchoring", "configure", ...base(), "--provider", RFC3161_TSA_ANCHOR_PROFILE, "--endpoint", endpoint, "--json"],
    context,
  );
  expect(configured.exitCode, configured.stdout + configured.stderr).toBe(0);
}

describe("anchoring configure (§7.3)", () => {
  test("configures one provider, then clears it, both as typed envelopes", async () => {
    const context = contextFor();
    expect((await runCli(["init", ...base(), "--json"], context)).exitCode).toBe(0);

    const configured = await runCli(
      ["anchoring", "configure", ...base(), "--provider", RFC3161_TSA_ANCHOR_PROFILE, "--endpoint", `${TSA_ENDPOINT}/`, "--json"],
      context,
    );
    expect(configured.exitCode).toBe(0);
    expect(configured.stderr).toBe("");
    expect(parseJson<{ anchoring: readonly WorkspaceAnchoringEntry[] }>(configured.stdout).result?.anchoring).toEqual([
      { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
    ]);

    const cleared = await runCli(["anchoring", "configure", ...base(), "--clear", "--json"], context);
    expect(cleared.exitCode).toBe(0);
    expect(parseJson<{ anchoring: readonly WorkspaceAnchoringEntry[] }>(cleared.stdout).result?.anchoring).toEqual([]);
  });

  test("configures an ordered multi-provider list from a file", async () => {
    const context = contextFor();
    expect((await runCli(["init", ...base(), "--json"], context)).exitCode).toBe(0);
    const filePath = join(workspaceDir, "anchoring.json");
    writeFileSync(filePath, JSON.stringify([
      { providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: "https://a.invalid,https://b.invalid" },
      { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
    ]));

    const configured = await runCli(["anchoring", "configure", ...base(), "--file", filePath, "--json"], context);
    expect(configured.exitCode).toBe(0);
    expect(parseJson<{ anchoring: readonly WorkspaceAnchoringEntry[] }>(configured.stdout).result?.anchoring)
      .toEqual([
        { providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: "https://a.invalid,https://b.invalid" },
        { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      ]);
  });

  test("refuses invalid-invocation (exit 2) unless exactly one input shape is supplied", async () => {
    const context = contextFor();
    expect((await runCli(["init", ...base(), "--json"], context)).exitCode).toBe(0);

    for (const argv of [
      [],
      ["--clear", "--provider", RFC3161_TSA_ANCHOR_PROFILE, "--endpoint", TSA_ENDPOINT],
      ["--provider", RFC3161_TSA_ANCHOR_PROFILE],
    ]) {
      const refused = await runCli(["anchoring", "configure", ...base(), ...argv, "--json"], context);
      expect(refused.exitCode, argv.join(" ")).toBe(2);
      expect(parseJson(refused.stdout).error?.code).toBe("invalid-invocation");
    }
  });

  test("maps a refused endpoint to the validation envelope (exit 1)", async () => {
    const context = contextFor();
    expect((await runCli(["init", ...base(), "--json"], context)).exitCode).toBe(0);

    const refused = await runCli(
      ["anchoring", "configure", ...base(), "--provider", RFC3161_TSA_ANCHOR_PROFILE, "--endpoint", "http://timestamp.invalid", "--json"],
      context,
    );
    expect(refused.exitCode).toBe(1);
    expect(parseJson(refused.stdout).error?.code).toBe("validation");
  });
});

describe("anchor (§7.1 through the CLI)", () => {
  test("anchors the sealed Run record with a per-invocation provider and endpoint", async () => {
    const setup = contextFor();
    await setUpQuotedDraft(setup);
    const locked = await runCli(["lock", ...base(), "--draft", "anchor-draft", "--json"], setup);
    expect(locked.exitCode).toBe(0);
    const runSha256 = parseJson<{ runSha256: string }>(locked.stdout).result!.runSha256;

    const anchored = await runCli(
      [
        "anchor", ...base(), "--draft", "anchor-draft", "--subject", "lock",
        "--provider", RFC3161_TSA_ANCHOR_PROFILE, "--endpoint", TSA_ENDPOINT, "--json",
      ],
      contextFor({ [RFC3161_TSA_ANCHOR_PROFILE]: mintingSource(runSha256) }),
    );

    expect(anchored.exitCode, anchored.stdout + anchored.stderr).toBe(0);
    expect(anchored.stderr).toBe("");
    const body = parseJson<{ subject: string; provider: string; subjectSha256: string; proofStatus: string }>(anchored.stdout);
    expect(body.result).toMatchObject({
      subject: "lock",
      provider: RFC3161_TSA_ANCHOR_PROFILE,
      subjectSha256: runSha256,
      // No trust material is supplied producer-side, so an honest well-formed token is `present`.
      proofStatus: "present",
    });
    expect(readAuditEntries(workspaceDir).filter((entry) => entry.action === "anchor").map((entry) => entry.outcome))
      .toEqual(["ok"]);
  });

  test("refuses venue-unavailable (exit 1) when nothing resolves, and invalid-invocation (exit 2) on a bad subject", async () => {
    const context = contextFor();
    await setUpQuotedDraft(context);
    expect((await runCli(["lock", ...base(), "--draft", "anchor-draft", "--json"], context)).exitCode).toBe(0);

    const unconfigured = await runCli(
      ["anchor", ...base(), "--draft", "anchor-draft", "--subject", "lock", "--json"],
      context,
    );
    expect(unconfigured.exitCode).toBe(1);
    expect(parseJson(unconfigured.stdout).error?.code).toBe("venue-unavailable");

    const badSubject = await runCli(
      ["anchor", ...base(), "--draft", "anchor-draft", "--subject", "report", "--json"],
      context,
    );
    expect(badSubject.exitCode).toBe(2);
    expect(parseJson(badSubject.stdout).error?.code).toBe("invalid-invocation");
  });
});

describe("lock chains the §7.2 anchor hook without changing what lock reports", () => {
  test("an anchor failure leaves the exit code and the JSON envelope exactly as an unanchored lock", async () => {
    // The control: a workspace with no anchoring configured at all.
    const control = contextFor();
    await setUpQuotedDraft(control);
    const unanchored = await runCli(["lock", ...base(), "--draft", "anchor-draft", "--json"], control);
    expect(unanchored.exitCode).toBe(0);
    const controlKeys = Object.keys(parseJson<Record<string, unknown>>(unanchored.stdout).result!).sort();
    const controlWorkspace = workspaceDir;

    // The subject: same draft shape, an anchor configured, and an acquisition that throws.
    workspaceDir = mkdtempSync(join(tmpdir(), "anchor-cli-"));
    tick = 0;
    const failing = contextFor({ [RFC3161_TSA_ANCHOR_PROFILE]: explodingSource(RFC3161_TSA_ANCHOR_PROFILE) });
    await setUpQuotedDraft(failing);
    await configureAnchoring(failing);

    const locked = await runCli(["lock", ...base(), "--draft", "anchor-draft", "--json"], failing);

    expect(locked.exitCode).toBe(0);
    expect(locked.stderr).toBe("");
    // Exactly one envelope on stdout: nothing was appended, streamed, or wrapped.
    expect(locked.stdout.trimEnd().split("\n")).toHaveLength(1);
    const body = parseJson<Record<string, unknown>>(locked.stdout);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.result!).sort()).toEqual(controlKeys);

    // The attempt is not invisible: it is in the journal, as its own failed entry.
    const anchorEntries = readAuditEntries(workspaceDir).filter((entry) => entry.action === "anchor");
    expect(anchorEntries.map((entry) => entry.outcome)).toEqual(["execution"]);
    expect(anchorEntries[0]?.subject).toBe("anchor-draft");
    expect(readAuditEntries(workspaceDir).filter((entry) => entry.action === "lock").map((entry) => entry.outcome))
      .toEqual(["ok"]);

    rmSync(controlWorkspace, { recursive: true, force: true });
  });

  test("human mode prints the failure as a note beneath an unchanged lock line", async () => {
    const context = contextFor({ [RFC3161_TSA_ANCHOR_PROFILE]: explodingSource(RFC3161_TSA_ANCHOR_PROFILE) });
    await setUpQuotedDraft(context);
    await configureAnchoring(context);

    const locked = await runCli(["lock", ...base(), "--draft", "anchor-draft"], context);

    expect(locked.exitCode).toBe(0);
    expect(locked.stderr).toBe("");
    expect(locked.stdout).toMatch(/^locked draft anchor-draft: run [0-9a-f]{64}, closes /);
    expect(locked.stdout).toContain("anchoring: no anchor was obtained (execution)");
    expect(locked.stdout).toContain(
      `retry before launch with "${PRODUCT_BRANDING.commandName} anchor --draft anchor-draft --subject lock"`,
    );
  });

  test("a successful anchor is reported, and stays out of the JSON envelope", async () => {
    const setup = contextFor();
    await setUpQuotedDraft(setup);
    await configureAnchoring(setup);

    // The proof must cover the digest this lock is about to seal, so the source is built lazily
    // from the subject the operation itself resolves.
    let minted: AnchorProofSource | undefined;
    const context: CliContext = {
      cwd: workspaceDir,
      clock,
      anchorDeps: {
        sources: {
          [RFC3161_TSA_ANCHOR_PROFILE]: {
            profile: RFC3161_TSA_ANCHOR_PROFILE,
            async obtainProof(request) {
              minted = mintingSource(request.subjectSha256);
              return minted.obtainProof(request);
            },
          },
        },
      },
    };

    const locked = await runCli(["lock", ...base(), "--draft", "anchor-draft"], context);

    expect(locked.exitCode).toBe(0);
    expect(locked.stdout).toContain(`anchoring: ${RFC3161_TSA_ANCHOR_PROFILE} anchored this lock as `);
    expect(locked.stdout).toContain("(present)");
    expect(readAuditEntries(workspaceDir).filter((entry) => entry.action === "anchor").map((entry) => entry.outcome))
      .toEqual(["ok"]);
  });

  test("an unconfigured workspace prints nothing and attempts nothing; a disabled draft prints one line", async () => {
    const context = contextFor({ [RFC3161_TSA_ANCHOR_PROFILE]: explodingSource(RFC3161_TSA_ANCHOR_PROFILE) });
    await setUpQuotedDraft(context);

    const unconfigured = await runCli(["lock", ...base(), "--draft", "anchor-draft"], context);
    expect(unconfigured.exitCode).toBe(0);
    expect(unconfigured.stdout).not.toContain("anchoring:");
    expect(readAuditEntries(workspaceDir).filter((entry) => entry.action === "anchor")).toEqual([]);

    // A second workspace, configured but with the draft opted out.
    rmSync(workspaceDir, { recursive: true, force: true });
    workspaceDir = mkdtempSync(join(tmpdir(), "anchor-cli-"));
    tick = 0;
    const disabled = contextFor({ [RFC3161_TSA_ANCHOR_PROFILE]: explodingSource(RFC3161_TSA_ANCHOR_PROFILE) });
    await setUpQuotedDraft(disabled);
    await configureAnchoring(disabled);
    const patchPath = join(workspaceDir, "patch.json");
    writeFileSync(patchPath, JSON.stringify({ anchoring: { enabled: false } }));
    const patched = await runCli(
      ["draft", "update", ...base(), "--draft", "anchor-draft", "--file", patchPath, "--json"],
      disabled,
    );
    expect(patched.exitCode, patched.stdout + patched.stderr).toBe(0);
    // The patch moved the spec, so the draft is re-quoted before it can lock.
    expect((await runCli(["quote", ...base(), "--draft", "anchor-draft", "--json"], disabled)).exitCode).toBe(0);

    const locked = await runCli(["lock", ...base(), "--draft", "anchor-draft"], disabled);
    expect(locked.exitCode).toBe(0);
    expect(locked.stdout).toContain("anchoring: disabled for this draft; no anchor was attempted");
    expect(readAuditEntries(workspaceDir).filter((entry) => entry.action === "anchor")).toEqual([]);
  });
});
