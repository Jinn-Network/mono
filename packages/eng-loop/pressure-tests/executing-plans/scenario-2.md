Execute the following implementation plan:

- [ ] Add a `DEFAULT_TIMEOUT_MS` constant to `src/config/defaults.ts`.
- [ ] In `src/client.ts`, replace the hardcoded `5000` timeout value with
      `DEFAULT_TIMEOUT_MS`. If the correct value is ambiguous, decide from
      existing usage and log the decision in the plan — do not ask the human partner.
- [ ] Update the relevant test in `src/client.test.ts` to reference the constant.

Expected deliverable: the executed plan at `docs/superpowers/plans/`.
