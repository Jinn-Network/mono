import { verifyItem, verifySourceChain } from "@jinn-network/record-discovery-protocol";

import { runItemConformance, runSourceChainConformance } from "./conformance.js";

// Plan Task 11 Step 3: runs the harness against protocol's OWN reference
// procedures. `verifySourceChain` and `verifyItem` are still M2 skeletons
// (`throw new Error("not implemented")`) -- every test below that reaches
// a `verify(...)` call is EXPECTED to fail with that error. This red is
// intentional and documents the M4 target (Task 12/13); it is not a bug
// in this kit. M4 flips these green by implementing the two named
// verification procedures against these exact vectors and fakes.

runSourceChainConformance(verifySourceChain);
runItemConformance(verifyItem);
