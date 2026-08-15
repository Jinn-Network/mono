# walkthrough-v1

The four §13 verification walkthroughs -- old verdict after key rotation,
open-fleet adoption settlement, confidential input / leaked documents, and
two-Safe evaluator distinctness -- are executable end-to-end integration
fixtures in `src/walkthroughs.ts`, run by `src/walkthroughs.test.ts`
(Task T16). Each drives the real `@jinn-network/trust-core` verification
procedures against a scenario seeded through `src/fakes.ts` and
`src/fixtures.ts`.

Note (walkthrough 2, open-fleet adoption settlement): this exercises the
adoption-authorization Statement TWIN resolution only. The EIP-712
enforcement struct and its schema/bijection to the Statement live in the
marketplace tree (design §8.2), out of this plan's scope; this fixture
stubs the launcher-IRI binding and treats the Statement's own DSSE
verification as the marketplace consumer would supply it.
