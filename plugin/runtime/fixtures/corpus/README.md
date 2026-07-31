# Corpus test fixtures

`execution-evidence.valid.json` is a byte-for-byte copy of
`packages/evidence/protocol`'s own conforming Execution Evidence golden
fixture. It is copied, never re-authored: the record family's truth lives in
`evidence/protocol`, and a second hand-written copy here would drift.

Regenerate with:

    cp ../../../../packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json \
       execution-evidence.valid.json

These fixtures are test-only and are not in the package's `files` list.
