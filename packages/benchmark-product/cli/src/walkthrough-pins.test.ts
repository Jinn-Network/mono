/**
 * The claimant walkthrough is the one document that prints the whole brought-run path, command by
 * command (issue #4942). It repeats values the product owns: the provider names `anchor` accepts,
 * the order of the claimant commands, the reader line a claim pins, the Harbor dataset pin, and
 * three sealed sentences. A copy that drifts sends a claimant to a refusal, or a reader to a line
 * that does not read the bundle, so each copy is held to its source here.
 *
 * The outputs the walkthrough shows are not held here. They were recorded once, by typing the
 * commands, and a later change to a printed line is a change to the product, not to this document.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND,
  TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  TERMINAL_BENCH_21_PINS,
  anchoredPreRegistrationSentence,
  type ClaimAnchor,
} from "@colophon-claims/check";
import { CLAIMANT_COMMAND_PATH, LOCAL_VENUE_LIMITS, PRODUCIBLE_ANCHOR_PROFILES } from "@colophon-claims/core";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const walkthrough = readFileSync(join(here, "..", "..", "CLAIMANT-WALKTHROUGH.md"), "utf8");
const readme = readFileSync(join(here, "..", "README.md"), "utf8");
const cliPackage = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  name: string;
  version: string;
  repository: { url: string };
};

/** The command each `sh` fence holds, with its line continuations joined. */
const commands = [...walkthrough.matchAll(/^```sh\n(.*?)^```/gmsu)]
  .map((fence) => fence[1]!.replace(/\\\n\s*/gu, "").trimEnd());

/** How the walkthrough starts the published CLI: the package at its `major.minor` line. */
const colophon = `npx ${cliPackage.name}@${cliPackage.version.split(".").slice(0, 2).join(".")} `;

/** The verbs that read a draft and change nothing. They may sit anywhere on the path. */
const READ_VERBS = ["inspect", "status", "results"];

/** The verb a claimant command names: the longest known verb its words start with. */
function verbOf(command: string): string {
  const words = command.slice(colophon.length);
  const known = [...CLAIMANT_COMMAND_PATH.map((step) => step.verb), ...READ_VERBS]
    .filter((verb) => words === verb || words.startsWith(`${verb} `))
    .sort((left, right) => right.length - left.length);
  return known[0] ?? words.split(" ")[0]!;
}

describe("claimant walkthrough: reachable from the README a claimant holds", () => {
  test("the README links it on the ref the publish step pins, and says what it gives", () => {
    const repository = cliPackage.repository.url.replace(/\.git$/u, "");
    expect(readme).toContain(
      `[\`CLAIMANT-WALKTHROUGH.md\`](${repository}/blob/next/packages/benchmark-product/CLAIMANT-WALKTHROUGH.md)`,
    );
    // `arm add --help` sends a claimant to this README by the document's name (issue #4946).
    expect(readme).toContain("## Bring a Terminal-Bench 2.1 run");
  });

  test("the README states the two-arm minimum and the platforms the claimant verbs need", () => {
    // Issue #4948: the minimum was learned from a refusal at `quote`. Issue #4950: the README
    // named platforms for the sample only.
    const unwrapped = readme.replace(/\s+/gu, " ");
    expect(unwrapped).toContain("A draft needs at least two arms.");
    expect(unwrapped).toContain("the claimant verbs need one of those two platforms");
    expect(unwrapped).toContain("Ubuntu x64 and Apple-silicon macOS arm64");
  });
});

describe("claimant walkthrough: one command per block, in the published order", () => {
  test("every sh fence holds exactly one command", () => {
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command.split("\n"), command).toHaveLength(1);
  });

  test("the claimant commands are the published path: every command of it, and in its order", () => {
    const verbs = commands.filter((command) => command.startsWith(colophon)).map(verbOf);
    const path = CLAIMANT_COMMAND_PATH.map((step) => step.verb);
    // Anything that is not on the path is a read verb. `arm add` runs twice, once for each arm.
    expect(verbs.filter((verb) => !path.includes(verb) && !READ_VERBS.includes(verb))).toEqual([]);
    const onPath = verbs.filter((verb) => path.includes(verb));
    expect(onPath.filter((verb, index) => verb !== onPath[index - 1])).toEqual(path);
    expect(verbs.filter((verb) => verb === "arm add")).toHaveLength(2);
  });

  test("the CLI is started one way, at the package's own line", () => {
    const started = [...walkthrough.matchAll(/npx @colophon-claims\/cli\S*/gu)].map((match) => `${match[0]} `);
    expect(started.length).toBeGreaterThan(0);
    expect([...new Set(started)]).toEqual([colophon]);
  });
});

describe("claimant walkthrough: the anchor step names what `anchor` accepts", () => {
  test("both provider values are listed, and they are the producible profiles", () => {
    const listed = [...walkthrough.matchAll(/^- `(https:\/\/spec\.jinn\.network\/[^`]+)`:/gmu)].map((match) => match[1]);
    expect(listed).toEqual([...PRODUCIBLE_ANCHOR_PROFILES]);
    // And nowhere else does the document print a profile name of its own invention.
    const everywhere = [...walkthrough.matchAll(/https:\/\/spec\.jinn\.network\/trust\/anchor-profiles\/[a-z0-9-]+\/v\d+/gu)]
      .map((match) => match[0]);
    expect([...new Set(everywhere)].sort()).toEqual([...PRODUCIBLE_ANCHOR_PROFILES].sort());
  });

  test("the one anchor command passes a listed provider, the lock subject and an endpoint", () => {
    const anchors = commands.filter((command) => command.startsWith(`${colophon}anchor `));
    expect(anchors).toHaveLength(1);
    const provider = / --provider (\S+)/u.exec(anchors[0]!)?.[1];
    expect(PRODUCIBLE_ANCHOR_PROFILES as readonly string[]).toContain(provider);
    expect(anchors[0]).toContain(" --subject lock ");
    expect(anchors[0]).toMatch(/ --endpoint https?:\/\/\S+$/u);
  });
});

describe("claimant walkthrough: the reader runs the line the claim pins", () => {
  // The claim of a /10 bundle pins this command with `<bundle-dir>` in place of the directory.
  const pinned = PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND.replace(/ <bundle-dir>$/u, "");

  test("every reader command is that line, followed by a bundle directory", () => {
    expect(PUBLIC_BUNDLE_V10_VERIFICATION_COMMAND).toBe(`${pinned} <bundle-dir>`);
    const readers = commands.filter((command) => /^npx @colophon-claims\/(?:check|verify)/u.test(command));
    expect(readers.length).toBeGreaterThanOrEqual(3);
    for (const reader of readers) {
      expect(reader.startsWith(`${pinned} ./`), reader).toBe(true);
      expect(reader.slice(pinned.length + 1).split(" ")[0], reader).toMatch(/^\.\/\S+$/u);
    }
    // Once on the claimant's own directory, once on the fetched copy, once with the trust root.
    expect(readers.filter((reader) => reader.includes(" --tsa-root "))).toHaveLength(1);
  });

  test("no other reader line, under either published name, appears anywhere in the document", () => {
    const named = [...walkthrough.matchAll(/@colophon-claims\/(?:check|verify)@[0-9][^\s`]*/gu)].map((match) => match[0]);
    expect([...new Set(named)]).toEqual([pinned.slice("npx ".length)]);
  });
});

describe("claimant walkthrough: the Harbor commands run the sealed slate", () => {
  const harbor = commands.filter((command) => command.startsWith("harbor run "));
  const firstTen = TERMINAL_BENCH_21_PINS.tasks.slice(0, 10).map((task) => `terminal-bench/${task.name}`);

  test("one job for each arm, on the dataset revision the slate seals", () => {
    expect(harbor).toHaveLength(2);
    const dataset = `${TERMINAL_BENCH_21_PINS.datasetId}@${TERMINAL_BENCH_21_PINS.datasetRevision}`;
    for (const command of harbor) expect(command, command).toContain(` -d '${dataset}' `);
    expect(harbor.map((command) => / -a (\S+)/u.exec(command)?.[1])).toEqual(["terminus-2", "oracle"]);
    expect(harbor.map((command) => / --job-name (\S+)/u.exec(command)?.[1])).toEqual(["terminus-2", "oracle"]);
  });

  test("the ten tasks of --slice 10, in slate order, one trial each and retries off", () => {
    for (const command of harbor) {
      expect([...command.matchAll(/ -i (\S+)/gu)].map((match) => match[1]), command).toEqual(firstTen);
      expect(command).toContain(" --n-attempts 1 ");
      expect(command).toContain(" --max-retries 0 ");
      expect(command).toContain(" -o jobs ");
    }
    // The method command plans what those two jobs run.
    const method = commands.find((command) => command.startsWith(`${colophon}method `));
    expect(method).toContain(" --slice 10 ");
    expect(method).toMatch(/ --replicates 1$/u);
    // And the task names `inspect` is shown printing are the same ten.
    for (const name of firstTen) expect(walkthrough).toContain(`          "${name}"`);
  });
});

describe("claimant walkthrough: a quoted product sentence is the product's own", () => {
  const quoted = [...walkthrough.matchAll(/^> (.+)$/gmu)].map((match) => match[1]!);

  test("the three block quotes are the comparability sentence and the two pre-registration sentences", () => {
    const anchoredAt = quoted.map((sentence) => /existed no later than (\S+Z)\. /u.exec(sentence)?.[1]).find((time) => time !== undefined);
    expect(anchoredAt, "the anchored sentence states a time").toBeDefined();
    // Only `genTime` is read to render the sentence; the rest fills the shape of an RFC 3161 anchor.
    const lockAnchor: ClaimAnchor = {
      subject: "lock",
      kind: "https://spec.jinn.network/records/benchmark-run/v1",
      provider: PRODUCIBLE_ANCHOR_PROFILES[0],
      recordSha256: "0".repeat(64),
      facts: { genTime: anchoredAt!, policyOid: "2.999.1", serialNumber: "01", signerCertificateSha256: "0".repeat(64) },
    };
    expect(quoted).toEqual([
      TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
      LOCAL_VENUE_LIMITS[1],
      anchoredPreRegistrationSentence(lockAnchor),
    ]);
  });

  test("the anchored sentence states the time the shown checker output states", () => {
    const shown = /lock anchor · authority-time · verified · (\S+)\n/u.exec(walkthrough)?.[1];
    expect(shown).toBeDefined();
    expect(quoted[2]).toContain(`existed no later than ${shown}. `);
  });
});
