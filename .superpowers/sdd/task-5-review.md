# Task 5 Independent Review Findings

Review range: `da1775b298526a4ebb357b47c172142b57c8692e..1bfdd1927b0a48f53a179489c7045f05c69e50c6`

## Critical

1. The unique verdict-intent UUID is stored in the review ref but omitted from
   the native marker/readback, and snapshot recovery does not require the
   selected reviewer login. Bind the exact intent UUID into the canonical
   marker and require reviewer login, exact commit, state, and exact marker in
   session and snapshot recovery. A wrong-login marker copy must never complete
   an intent.

## Important safety and authority

1. Verdict and fix publication boundaries must freshly rederive the unique open
   PR↔issue↔branch mapping and current-head CODEOWNER policy. Do not populate
   issue authority from the manifest. A changed mapping, closed PR, or changed
   approval policy enters structured Human.
2. Persist and confirm the exact-parent `human` review record before draft,
   label, comment, or Project projection. A current-head Human record is
   authoritative and non-reapable; acquisition must repair its overlay, never
   reclaim it after two hours.
3. Remove substring-based exemptions for native `CHANGES_REQUESTED`. Evaluate
   effective current native blockers and re-read them after approval
   confirmation, immediately before terminal publication, and immediately
   before ready.
4. Acquisition projection must re-read Human after every mutation and perform
   a final exact ref/head/Human authority check before spawning.

## Important availability and recovery

1. Production projection, label, Project, draft/ready, and Human-comment
   mutations must catch accepted-response errors and perform exact readback.
   Accept only the exact desired state; otherwise preserve the original error
   or explicit ambiguity. Cover claim projection and verdict/Human transitions.

## Required verification

- Focused RED/GREEN tests for every item above and their race/negative cases.
- `yarn vitest run test/lifecycle test/dispatcher/coordinator-session.test.ts`
- `yarn typecheck`
- `yarn test`
- `git diff --check`
