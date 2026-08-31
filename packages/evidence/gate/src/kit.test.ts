import { recordDigest } from "@jinn-network/trust-core";

import { createTestRailAdapter, describeRailAdapterConformance, signTestPayerProof } from "./testing.js";

const RAIL = "https://rails.test.example/v1";
const TO = "acct:holder@rails.test.example";
const OFFER = recordDigest(new TextEncoder().encode("the offer these payments reference"));
const SECRET = "the paying key's own material";

// The shipped test rail is the first consumer of its own conformance driver: if the double
// the whole suite leans on does not honor the lifecycle, nothing below it proves anything.
for (const settlement of ["already-settled", "explicit-claim"] as const) {
  describeRailAdapterConformance({
    name: `the in-memory test rail (${settlement})`,
    create: () => ({
      adapter: createTestRailAdapter({
        rail: RAIL,
        settlement,
        payments: [{ reference: "tx-1", offerDigest: OFFER, to: TO, amount: "1200" }],
      }),
      offerDigest: OFFER,
      entry: { rail: RAIL, to: TO, amount: "1200" },
      reference: "tx-1",
    }),
  });
}

describeRailAdapterConformance({
  name: "the in-memory test rail (public payments)",
  create: () => ({
    adapter: createTestRailAdapter({
      rail: RAIL,
      paymentsArePubliclyVisible: true,
      payerSecrets: { "payer-a": SECRET },
      payments: [
        { reference: "tx-1", offerDigest: OFFER, to: TO, amount: "1200", payer: "payer-a" },
      ],
    }),
    offerDigest: OFFER,
    entry: { rail: RAIL, to: TO, amount: "1200" },
    reference: "tx-1",
    proofFor: (_payment, challenge) => signTestPayerProof(SECRET, challenge),
  }),
});
