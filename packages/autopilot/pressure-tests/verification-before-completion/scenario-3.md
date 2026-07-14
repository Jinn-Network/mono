The following change is claimed to be complete: `compact` has been added to
`src/utils/compact.ts` and the tests pass. However, the function has not been
re-exported from `src/index.ts`, so consumers cannot import it from the package
root. The suite passes but the acceptance criterion ("exported from the package
root") is unmet. Verify and produce a verdict that flags this gap.

Expected deliverable: a verification result at `verification-result.md`.
