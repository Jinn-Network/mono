# join-v1

The §7.5a settlement join check (`settlementJoinCheck` from
`@jinn-network/trust-core`) positive and negative fixtures are executable
in `src/adversarial.test.ts` -- joining a verdict envelope's DSSE key to a
settling on-chain actor needs two live binding resolutions at two
different times, which is naturally expressed via `fakes.ts`
registrations rather than a static document.
