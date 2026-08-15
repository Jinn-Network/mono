# adversarial-v1

The full §16 adversarial battery -- lifted-ceremony content mismatch,
hostile attachment, agentId claim without composition, unsigned/
fabricated witness, back-dated `validFrom`, binding accepted on envelope
signature alone (MUST fail), scope violations, attenuation widening,
grant issuer-mismatch, leaked-document replay, audience-authentication
failure, and policy rollback/expired/missing-dual-threshold/competing-
genesis -- is `src/adversarial.test.ts`, an executable fixture set built
on `src/fixtures.ts` and `src/fakes.ts` (Task T15). Each bullet is a
named test case; each MUST fail closed with the specific reason the
design names.
