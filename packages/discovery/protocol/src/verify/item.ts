import type { FactsProfileDocument } from "../facts-profile.js";
import type { AnnouncedItem, SourceCursor } from "../item.js";
import type {
  EntryFetcher,
  FactsRecompute,
  KeyResolver,
  RecordFetcher,
  SignatureVerifier,
  SubstrateChecker,
} from "./ports.js";
import type { ItemOutcome } from "./outcomes.js";

// Named verification: item verification (design §10.4). Skeleton only --
// the five-step procedure is implemented at M4 (Task 13), driven
// red-then-green by the `discovery/testing` conformance kit.

export async function verifyItem(opts: {
  item: AnnouncedItem;
  profile?: FactsProfileDocument;
  decisionGrade: boolean;
  ports: {
    records: RecordFetcher;
    entries: EntryFetcher;
    keys: KeyResolver;
    sigs: SignatureVerifier;
    factsRecompute: FactsRecompute;
    substrate?: SubstrateChecker;
    verifiedChain: (c: SourceCursor) => Promise<boolean>;
  };
}): Promise<ItemOutcome> {
  void opts;
  throw new Error("not implemented");
}
