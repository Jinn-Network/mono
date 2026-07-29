import { verifyItem } from "@jinn-network/record-discovery-protocol";
import { runItemConformance } from "@jinn-network/record-discovery-testing";

// Local configuration of the discovery kit's generic facts-consistency /
// item-verification driver (program §7.130): no benchmarking-specific
// adapter is added to the kit; the leaf wires the exported protocol
// reference procedure locally as a devDependency consumer.
runItemConformance(verifyItem);
