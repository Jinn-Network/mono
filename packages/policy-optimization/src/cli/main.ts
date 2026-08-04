// SPDX-License-Identifier: MIT

/**
 * The `optimize` verb tree (program §1, sub-unit C7d).
 *
 * Shipped as **this package's own bin** (`policy-optimization optimize …`). The argv shape is
 * `jinn optimize …` verbatim from the second word on, so wiring it into the client's verb tree
 * later is a dispatch entry rather than a re-design. It is not wired today: the client is denied
 * by this package's source boundary and this package is denied to the client by the tier boundary
 * (`policy-optimization-package-inventory.test.mjs`: "no other package in the repository depends on
 * the product"). See FINDING F-C7d-4.
 *
 * `runCli` returns a result; only `bin.ts` touches the process.
 */

import { PolicyOptimizationError } from "../errors.js";
import { campaignCreate, campaignRun, campaignStatus } from "./campaign.js";
import { candidateInspect } from "./candidate.js";
import { policyAdopt, policyRollback } from "./policy.js";
import { parseArgs, type ParsedArgs } from "./args.js";
import { failed, ok, type CliContext, type CliResult } from "./result.js";

const USAGE = `policy-optimization — the Policy Optimization product's CLI (product design §§5–9).

  optimize campaign create   --dir <campaign-dir> --document <campaign.json> --seed <file> [--seed <file>…] [--at <rfc3339>]
  optimize campaign run      --dir <campaign-dir> --settings <run-settings.json> --benchmark <development-benchmark.json>
                             --candidates <admitted.json> [--reports <rows.json>] [--outcomes <rows.json>]
                             [--informativeness <rows.json>] [--at <rfc3339>]
                             first wave only: --promotion-benchmark <file> and one of
                             --trusted-at <rfc3339> | --trusted-run-not-closed
  optimize campaign status   --dir <campaign-dir>
  optimize candidate inspect --manifest <candidate.json> [--population <dir-of-manifests>]
  optimize policy adopt      (--dir <campaign-dir> | --archive-dir <dir>) --candidate <candidate-or-tuple.json>
                             --task-profile <uri> [--route <name>] [--approve-payload-class=<class>…] [--at <rfc3339>]
  optimize policy rollback   (--dir <campaign-dir> | --archive-dir <dir>) --task-profile <uri> [--route <name>]
                             [--tuple <file>] [--at <rfc3339>]

Payload classes (§7.4, cheapest first): prompt, skill, tool-config, hook, harness-fork, unclassified.
`;

type Verb = (args: ParsedArgs, context: CliContext) => CliResult;

const VERBS: ReadonlyMap<string, Verb> = new Map([
  ["optimize campaign create", campaignCreate],
  ["optimize campaign run", campaignRun],
  ["optimize campaign status", campaignStatus],
  ["optimize candidate inspect", candidateInspect],
  ["optimize policy adopt", policyAdopt],
  ["optimize policy rollback", policyRollback],
]);

export function runCli(argv: readonly string[], context: CliContext): CliResult {
  try {
    const args = parseArgs(argv);
    if (args.words.length === 0 || args.words[0] === "help" || args.flags.has("help")) {
      return ok(USAGE);
    }
    const verb = VERBS.get(args.words.join(" "));
    if (verb === undefined) {
      return failed(`unknown command "${args.words.join(" ")}"\n\n${USAGE}`);
    }
    return verb(args, context);
  } catch (cause) {
    // Every refusal in this package is a `PolicyOptimizationError` carrying a category and a path;
    // both are printed, because "invalid-document" alone does not tell an operator which file.
    if (cause instanceof PolicyOptimizationError) {
      return failed([
        `${cause.category}: ${cause.message}`,
        ...cause.errors.slice(1).map((issue) => `  ${issue.path}: ${issue.message}`),
      ].join("\n"));
    }
    return failed(cause instanceof Error ? cause.message : String(cause));
  }
}

export { USAGE };
