// SPDX-License-Identifier: MIT
import { InMemoryEvidenceCatalog } from "./in-memory.js";
import { describeEvidenceCatalogContract } from "./testing.js";

describeEvidenceCatalogContract(() => {
  const catalog = new InMemoryEvidenceCatalog();
  return { reader: catalog, writer: catalog };
});
