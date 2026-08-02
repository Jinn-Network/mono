# Prediction snapshot fixture v1

This is an append-only fixture family. `fixtureVersion: 1` and the five
literal artifact digests in `prediction-snapshot-fixture.test.ts` are the
contract: semantic changes add a new versioned fixture directory; they do not
rewrite this version or silently rebaseline its bytes. `verification-key.json`
is the public Ed25519 material used to verify both DSSE PAE signatures.
