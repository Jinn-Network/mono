import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliContext, type Demo1PreregistrationCommitment, type Demo1PreregistrationWitness } from "../index.js";
import { appendRunJournalEntry } from "../run/journal.js";
import { writeRunState } from "../run/state.js";

const roots: string[] = [];
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function setup(): {
  root: string;
  workspace: string;
  witnessPath: string;
  commitment: Demo1PreregistrationCommitment;
} {
  const root = mkdtempSync(join(tmpdir(), "demo1-prereg-cli-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const commitment = {
    runSha256: digest("run"),
    methodSummarySha256: digest("method"),
    graderProgramSha256: digest("grader"),
    sourceCommit: "c".repeat(40),
  };
  writeRunState(workspace, "demo-1", {
    draftId: "demo-1",
    specSha256: digest("spec"),
    owner: "urn:demo1:owner",
    runSha256: commitment.runSha256,
    lockedAt: "2026-08-13T09:55:00.000Z",
  });
  const witness: Demo1PreregistrationWitness = {
    commitment,
    commitmentSha256: createHash("sha256").update(JSON.stringify({
      graderProgramSha256: commitment.graderProgramSha256,
      methodSummarySha256: commitment.methodSummarySha256,
      runSha256: commitment.runSha256,
      sourceCommit: commitment.sourceCommit,
    })).digest("hex"),
    manifestCid: "bafydemo1preregistration",
    transactionHash: `0x${"a".repeat(64)}`,
    external: {
      source: "erc8004-block",
      timestamp: "2026-08-13T09:59:59.000Z",
      chainId: 84532,
      blockNumber: "1234567",
      blockHash: `0x${"b".repeat(64)}`,
    },
  };
  const witnessPath = join(root, "witness.json");
  writeFileSync(witnessPath, JSON.stringify(witness));
  return { root, workspace, witnessPath, commitment };
}

const context: CliContext = {
  cwd: "/",
  clock: () => "2026-08-13T10:00:00.000Z",
};

function argv(input: ReturnType<typeof setup>): string[] {
  return [
    "demo1", "prereg", "verify",
    "--workspace", input.workspace,
    "--draft", "demo-1",
    "--witness", input.witnessPath,
    "--method-summary-sha256", input.commitment.methodSummarySha256,
    "--grader-program-sha256", input.commitment.graderProgramSha256,
    "--source-commit", input.commitment.sourceCommit,
    "--json",
  ];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("one-command Demo-1 pre-dispatch verifier", () => {
  it("reads the locked Run and witness and emits one machine-readable readiness result", async () => {
    const input = setup();
    const result = await runCli(argv(input), context);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      result: {
        stage: "post-lock-pre-dispatch",
        ready: true,
        runSha256: input.commitment.runSha256,
        manifestCid: "bafydemo1preregistration",
        transactionHash: `0x${"a".repeat(64)}`,
        externalTimestamp: "2026-08-13T09:59:59.000Z",
      },
    });
  });

  it("fails closed if any run-journal activity predates the command", async () => {
    const input = setup();
    appendRunJournalEntry(input.workspace, "demo-1", {
      kind: "launched",
      at: "2026-08-13T10:00:00.000Z",
    });
    const result = await runCli(argv(input), context);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "illegal-transition" },
    });
  });
});
