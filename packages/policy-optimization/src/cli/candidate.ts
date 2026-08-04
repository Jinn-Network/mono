// SPDX-License-Identifier: MIT

/**
 * `optimize candidate inspect` — parse, validate, and place one candidate in the lineage.
 *
 * Three questions in one answer: is this a well-formed candidate manifest (substrate §5.3), what
 * tuple does it name (the population key, §7.3), and where does it sit relative to the manifests
 * this operator already holds (§8.3).
 *
 * It answers **none** of "should I admit it" or "is it any good". Admission is C7c's gate, and
 * whether a candidate is better is established by evaluation records and nothing else — a manifest
 * carries no score and no self-assessment by design (substrate §5.1), so neither does this output.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseExactCandidateManifest,
  canonicalTupleBytes,
  prefixedDigest,
} from "@jinn-network/policy-identity";
import { lineageGraph, lineagePosition } from "../archive/lineage.js";
import { declaredAdoptionComponentClasses, formatAdoptionComponentClasses } from "../archive/adoption.js";
import type { LineageGraph } from "../archive/types.js";
import {
  assertKnownFlags, optional, pathFrom, readBytes, required, type ParsedArgs,
} from "./args.js";
import { type CliContext, type CliResult, lines, ok } from "./result.js";

/** Every `*.json` directly inside `directory`, sorted, as bytes. Not recursive: a flat corpus. */
function manifestsIn(directory: string): readonly Uint8Array[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isFile() ? [readBytes(path)] : [];
    });
}

export function candidateInspect(args: ParsedArgs, context: CliContext): CliResult {
  assertKnownFlags(args, ["manifest", "population"]);
  const path = pathFrom(context.cwd, required(args, "manifest"));
  const bytes = readBytes(path);
  const manifest = parseExactCandidateManifest(bytes);
  const digest = prefixedDigest(bytes);
  const tuple = prefixedDigest(canonicalTupleBytes(manifest.policy));

  const populationDirectory = optional(args, "population");
  const graph: LineageGraph | undefined = populationDirectory === undefined
    || populationDirectory === ""
    ? undefined
    : lineageGraph(withSelf(manifestsIn(pathFrom(context.cwd, populationDirectory)), bytes, digest));

  const head = [
    `manifest     ${digest}`,
    `tuple        ${tuple}`,
    `proposer     ${manifest.proposer}`,
    `parents      ${manifest.parents.length === 0
      ? "none (a seed)"
      : manifest.parents.map((parent) => `${parent.kind}:${parent.digest}`).join(" ")}`,
    `changes      ${manifest.declaredChanges.summary}`,
    // "Declared, not verified" is the substrate's own wording for this block, and the classes below
    // are derived from it — a claim about the payload, never an inspection of one.
    `payload      ${formatAdoptionComponentClasses(declaredAdoptionComponentClasses(manifest))} (declared, not verified)`,
  ];
  if (graph === undefined) {
    return ok(lines(...head, "lineage      not projected (pass --population <dir>)"));
  }

  const position = lineagePosition(graph, digest);
  return ok(lines(
    ...head,
    `population   ${graph.nodes.length} manifests`,
    `ancestors    ${position.ancestors.length === 0 ? "none held locally" : position.ancestors.join(" ")}`,
    `descendants  ${position.descendants.length === 0 ? "none" : position.descendants.join(" ")}`,
    `same tuple   ${position.sameTuple.length === 0 ? "none" : position.sameTuple.join(" ")}`,
    `unresolved   ${position.node.unresolvedParents.length === 0
      ? "none"
      : position.node.unresolvedParents.map((parent) => `${parent.kind}:${parent.digest}`).join(" ")}`,
  ));
}

/** The subject is projected with the population, whether or not the corpus directory holds it. */
function withSelf(
  population: readonly Uint8Array[],
  bytes: Uint8Array,
  digest: string,
): readonly Uint8Array[] {
  const held = population.some((candidate) => prefixedDigest(candidate) === digest);
  return held ? population : [...population, bytes];
}
