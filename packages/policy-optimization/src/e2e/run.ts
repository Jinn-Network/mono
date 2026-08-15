// SPDX-License-Identifier: MIT

/**
 * The operator's entry point: one miniature campaign, narrated as it runs (program §1 C9,
 * human touchpoint 3).
 *
 * `campaign.test.ts` and this module drive the **same** `runE2ECampaign`. The test asserts the
 * properties; this prints them. Nothing here re-implements a stage, and nothing here can pass
 * while the test fails — which is the only arrangement under which a demo is worth reading.
 *
 * Output discipline: plain text, no emoji (`BRAND.md`), and the §11 residuals printed last rather
 * than linked. A campaign that prints a recommendation without printing what the recommendation
 * does not prove is the exact self-deception §11 exists to name.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { archiveLayout, defaultArchiveRoot } from "../archive/index.js";
import { CAMPAIGN_JOURNAL_FILENAME } from "../tokens.js";
import { HONESTY_RESIDUALS, runE2ECampaign, type Stage } from "./campaign.js";
import { loadLearnerCandidateFixture } from "./learner-fixture.js";

const RULE = "-".repeat(96);

export interface E2ECampaignCliOptions {
  /** Campaign directory. Omitted → a fresh temporary directory, printed on the first line. */
  readonly directory?: string;
  /** Omit the C6-emitted candidate; the campaign then runs with the reference proposer only. */
  readonly withoutLearner?: boolean;
  readonly write?: (line: string) => void;
}

/** `--dir <path>` / `--without-learner` / `--help`. */
export function parseE2ECampaignArgs(argv: readonly string[]): E2ECampaignCliOptions | "help" {
  const options: { directory?: string; withoutLearner?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--without-learner") {
      options.withoutLearner = true;
      continue;
    }
    if (argument === "--dir") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--dir needs a path");
      options.directory = resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--dir=")) {
      options.directory = resolve(argument.slice("--dir=".length));
      continue;
    }
    throw new Error(`unrecognized argument '${argument}'. Try --help.`);
  }
  return options;
}

export const USAGE = [
  "Usage: yarn e2e:campaign [--dir <path>] [--without-learner]",
  "",
  "  Runs one miniature Policy Optimization campaign end to end on the local venue:",
  "  seed policy -> evidence bundle -> proposals -> admission -> development wave ->",
  "  promotion run -> recommendation -> archive -> adopt -> rollback.",
  "",
  "  --dir <path>        where to write the campaign. Default: a fresh temporary directory.",
  "                      The directory must be empty; a campaign is sealed once.",
  "  --without-learner   run with the reference proposer only, skipping the candidate the",
  "                      shipped learner emitted (packages/policy-optimization/fixtures/learner/).",
  "",
  "  Nothing here touches the network, spends money, or reads your operator state.",
].join("\n");

function renderStage(stage: Stage, write: (line: string) => void): void {
  write("");
  write(`[${String(stage.number).padStart(2, " ")}] ${stage.title}`);
  write(`     ${stage.detail}`);
  const width = Math.max(...stage.facts.map((fact) => fact.label.length));
  for (const fact of stage.facts) {
    write(`       ${fact.label.padEnd(width, " ")} : ${fact.value}`);
  }
}

function wrap(text: string, width: number, indent: string): readonly string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && `${line} ${word}`.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(indent + line);
  return lines;
}

/** Run the campaign and narrate it. Resolves to the process exit code. */
export async function runE2ECampaignCli(options: E2ECampaignCliOptions = {}): Promise<number> {
  const write = options.write ?? ((line: string) => console.log(line));
  const directory = options.directory
    ?? join(mkdtempSync(join(tmpdir(), "jinn-campaign-")), "campaign");

  write(RULE);
  write("Jinn Policy Optimization — one campaign, end to end, on the local venue");
  write(RULE);
  write(`campaign directory : ${directory}`);
  write(
    `proposers          : reference (deterministic ablation)`
    + `${options.withoutLearner ? "" : " + the shipped learner's committed candidate"}`,
  );

  const outcome = await runE2ECampaign({
    directory,
    report: (stage) => renderStage(stage, write),
    learnerCandidate: options.withoutLearner ? undefined : loadLearnerCandidateFixture(),
  });

  const layout = archiveLayout(defaultArchiveRoot(directory));
  const recommended = outcome.participants.find(
    (entry) => entry.candidate.tupleDigest === outcome.recommendation.tupleDigest,
  );

  write("");
  write(RULE);
  write("Result");
  write(RULE);
  write(`  recommended policy : ${recommended?.label ?? "unknown"}`);
  write(`  tuple              : ${outcome.recommendation.tupleDigest}`);
  write(`  objective value    : ${outcome.recommendation.value} (avg@k over the promotion gate)`);
  write(`  basis              : signed Report ${outcome.promotionReport.digest}`);
  write(`  campaign phase     : ${outcome.handle.state.phase}`);
  write("");
  write(`  journal            : ${join(directory, CAMPAIGN_JOURNAL_FILENAME)}`);
  write(`                       ${outcome.handle.entries.length} entries; replay reconstructs the campaign`);
  write(`  archive (derived)  : ${layout.projectionPath}`);
  write(`  adoption log       : ${layout.adoptionPath}`);
  write(`                       ${outcome.adoption.byteIdentical
    ? "adopt -> rollback returned the operator to the seed policy, byte-identically"
    : "WARNING: rollback did NOT restore the original run pinning"}`);

  write("");
  write(RULE);
  write("What this run does NOT prove");
  write(RULE);
  for (const residual of HONESTY_RESIDUALS) {
    write("");
    for (const line of wrap(residual, 90, "  ")) write(line);
  }
  write("");
  return outcome.adoption.byteIdentical ? 0 : 1;
}
