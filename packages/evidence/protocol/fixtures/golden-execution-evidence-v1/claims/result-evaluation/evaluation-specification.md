# Slug normalization evaluation specification

The Result passes when applying the patch to the supplied repository snapshot and running
`vitest run test/slug.test.ts` produces:

- exit code `0`;
- four passing tests and zero failing tests; and
- explicit coverage of repeated separators, surrounding punctuation, and punctuation-only input.

This evaluation does not assess the execution process, originality, or tool policy.
