import { BigInt, BigDecimal } from "@graphprotocol/graph-ts";
import { KnowledgeTree } from "../../generated/schema";

/**
 * Recompute and save the KnowledgeTree aggregate for the given intentCid.
 *
 * Tier semantics: 'attested', 'consensus', and 'proved' all count as
 * "attested-or-better" for the aggregate. This means attestedFraction
 * answers "what fraction of this tree has at least attested evidence?"
 */
export function upsertKnowledgeTree(
  intentCid: string,
  role: string,
  evidenceTier: string,
  block: BigInt,
): void {
  let tree = KnowledgeTree.load(intentCid);
  if (tree == null) {
    tree = new KnowledgeTree(intentCid);
    tree.intent = intentCid;
    tree.totalRestorations = 0;
    tree.totalVerdicts = 0;
    tree.attestedRestorations = 0;
    tree.attestedVerdicts = 0;
    tree.attestedFraction = BigDecimal.zero();
  }

  const isAttested =
    evidenceTier == "attested" ||
    evidenceTier == "consensus" ||
    evidenceTier == "proved";

  if (role == "restoration") {
    tree.totalRestorations = tree.totalRestorations + 1;
    if (isAttested) tree.attestedRestorations = tree.attestedRestorations + 1;
  } else if (role == "verdict") {
    tree.totalVerdicts = tree.totalVerdicts + 1;
    if (isAttested) tree.attestedVerdicts = tree.attestedVerdicts + 1;
  }

  const total = tree.totalRestorations + tree.totalVerdicts;
  const attested = tree.attestedRestorations + tree.attestedVerdicts;
  if (total == 0) {
    tree.attestedFraction = BigDecimal.zero();
  } else {
    tree.attestedFraction = BigDecimal.fromString(attested.toString()).div(
      BigDecimal.fromString(total.toString()),
    );
  }

  tree.lastUpdatedBlock = block;
  tree.save();
}
