import { describeEvidenceRetrievalContract } from "./retrieval-contract.js";
import { createSyntheticRetrievalFixture } from "./fixtures.js";

describeEvidenceRetrievalContract("in-memory Retrieval", async () => {
  const fixture = await createSyntheticRetrievalFixture();
  return {
    retrieval: fixture.retrieval,
    records: fixture.records,
    source: fixture.source,
    sourceQuery: { kind: "all" as const },
    cleanup: fixture.cleanup,
  };
});
