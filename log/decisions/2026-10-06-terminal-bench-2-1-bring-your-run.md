---
id: DR-2026-10-06
title: The Terminal-Bench 2.1 bring-your-run rulings; nine decisions before the first publish
date: 2026-10-06
verb: Decide
status: operator rulings of 2026-10-06 on design issue #4959; ratified on code-owner approval of this record
owning-docs: packages/benchmark-product/EXTERNAL-RUN-IMPORT.md, PUBLIC-BUNDLE.md, EXTERNAL-VERIFICATION.md, cli/README.md
---

# DR-2026-10-06: The Terminal-Bench 2.1 bring-your-run rulings

## Context

The pre-publish dry run of the stranger rehearsal
([#4742](https://github.com/Jinn-Network/mono/issues/4742)) could not finish.
[Its record](https://github.com/Jinn-Network/mono/issues/4742#issuecomment-5933608329)
names three issues that each stop the walk:
[#4937](https://github.com/Jinn-Network/mono/issues/4937) (`run import --from
harbor` refuses the official slate),
[#4938](https://github.com/Jinn-Network/mono/issues/4938) (an imported run
carries no scores) and
[#4936](https://github.com/Jinn-Network/mono/issues/4936) (`publish` refuses
every run on the slate). The first was a plain defect and is fixed
([#4960](https://github.com/Jinn-Network/mono/pull/4960)). The other two, and
several smaller frictions, needed choices that no document makes, or that
documents make in two different ways.

Design issue [#4959](https://github.com/Jinn-Network/mono/issues/4959) held
nine questions, each with its options and a recommendation, and ruled on
nothing. The operator ruled on 2026-10-06. The ruling is recorded in
[a comment on that issue](https://github.com/Jinn-Network/mono/issues/4959#issuecomment-6019271678):
the recommendation is taken on every decision, and one decision, the first,
changed between the issue being written and the ruling.

The rulings come now because of where the packages are. On npm, checked
2026-10-06, `@colophon-claims/check`, `@colophon-claims/core` and
`@colophon-claims/cli` exist only as `0.0.0` name reservations, so a decision
made now costs no version. After the first publish each one costs a new
version and a new receipt, and the 89 Task digests and the Benchmark digest
of the official slate become public.

This record states the nine rulings as they were made, the two places where
they settle a conflict between earlier documents, and the defaults taken on
the points no ruling settles. It quotes an earlier document only where it
settles a conflict.

## Decisions

The numbers and the option letters are the issue's.

1. **An official-slate task is described by a new grader family,
   `external-verifier`.** Each of the 89 official Terminal-Bench 2.1 tasks
   binds its own EvaluationSpec.

   The issue recommended one spec per task in the existing
   `deterministic-process` family. The operator first ruled that, on the
   condition that every required field is read from the task's own package
   and nothing is invented, with a new family as the fallback. All 89 task
   packages were then read. They state a verifier timeout and an image tag
   (89 of 89), and no image digest, platform, parser identity or
   test-transition list (0 of 89). Three packages describe arm64 as well as
   amd64, so writing `linux/amd64` would be false, not only unsourced. An
   independent check tried the narrower variants (an empty platform, a
   composite with no parts, a minimal human-review block, a namespaced
   extension) and found that each one seals and each one states something
   untrue. So the fallback applies.

   The ruled shape, for one task:

   ```json
   {
     "protocol": "https://spec.jinn.network/profiles/evaluation-spec/v1",
     "semanticsVersion": "4",
     "family": "external-verifier",
     "grader": {
       "name": "terminal-bench/adaptive-rejection-sampler",
       "digest": { "sha256": "bcaa2399985cd57666018025846289ab25e193ae0dd8fb7f0ffab2410c24d4de" },
       "accessClass": "public"
     },
     "familyBlock": {
       "harness": "harbor",
       "testMaterial": [
         { "name": "tests/test.sh", "digest": { "sha256": "38b43560d173cc2b952c3a3e17b8a480216d84e33450515e047bcb0d806b1e0a" }, "accessClass": "public" },
         { "name": "tests/test_outputs.py", "digest": { "sha256": "547dc6e107f034f41703722aeceb6d0236e3fb69116fc3f2fbaba11884de352f" }, "accessClass": "public" }
       ],
       "declaredImage": "alexgshaw/adaptive-rejection-sampler:20251031",
       "timeout": 900
     },
     "measurements": [{ "name": "reward", "type": "number", "required": true }],
     "verdictRule": { "all": [
       { "inconclusiveWhen": { "not": { "any": [
           { "threshold": { "measurement": "reward", "op": "eq", "value": 0 } },
           { "threshold": { "measurement": "reward", "op": "eq", "value": 1 } } ] } },
         "class": "non-binary-reward" },
       { "threshold": { "measurement": "reward", "op": "eq", "value": 1 } } ] },
     "unscorable": [{ "name": "non-binary-reward", "disposition": "recorded-inconclusive" }],
     "evidenceConventions": { "requiredRefs": ["trial-result.json"] }
   }
   ```

   Ruled with it:

   - The grader is the task package, named by the harness's own content
     hash. The family text states that rule, because the value is not the
     SHA-256 of any single file.
   - Each declared measurement is the same-named key of the harness's raw
     reward map. The reward is sealed as a number. The verdict comes from the
     sealed rule: pass at 1, fail at 0, inconclusive for any other value.
   - The family block carries its own semantics version, as
     `state-predicate` does. The shape above does not print it. Its exact
     field name and value are fixed in the protocol proposal.
   - The verifier file list is named `testMaterial`, so the record-discovery
     facts package announces those digests without a change.
   - The Harbor reader refuses a trial whose task ref differs from the grader
     digest. That part landed in #4960.
   - A reward that is not a whole number must reach the sealed rule and come
     out inconclusive. The import coercion that turns the decimal string into
     a number the sealer refuses is corrected in `core`.
   - A new family is a protocol change. It needs a numbered proposal in the
     protocol specification repository under its governance
     ([DR-2026-09-03](./2026-09-03-protocol-spec-repository.md)), then the
     change to `packages/task-execution/profiles`, one canary publish, and
     re-pinned receipts for `check`, `core` and `cli`. No package version
     changes, because none of the three is published.

   That proposal is proposal 0002,
   `proposals/0002-external-verifier-grader-family.md` in the protocol
   specification repository. It fixes the family's text; this record does
   not.

2. **A trial with no reward stays outside the score** and is counted in the
   accounting. The number is called Terminal-Bench 2.1 accuracy only when
   every cell was judged; otherwise it is the pass rate over judged cells.
   Every brought run carries the comparability sentence that
   [DR-2026-08-17-b](./2026-08-17-official-suite-protocol.md) decision 3
   requires, because no brought run can show today that it is
   leaderboard-ready. A timed-out trial that still has a reward is graded by
   that reward. This is option (a).

3. **Two arms for the first publish.** A run needs two arms, and Harbor's
   oracle agent is the suggested control. A one-arm claim stays open for a
   later version. This is option (a), for the first publish.

4. **`lock` accepting an unquoted draft is the design; `quote` ships first.**
   `lock` should accept an unquoted draft for a brought run. Until that
   lands, `quote` stays a required step and the walkthrough says it is a
   stopgap. Option (b) is the design, and option (a) ships first.

5. **The lock's public anchor is the commitment.** Posting the Run digest is
   an extra. The walkthrough names the two provider profile values and one
   working public endpoint as an example, with the trust material a reader
   needs. One anchored lock is exercised end to end, reader flags included,
   before publish. This is option (b).

6. **A run with an arm that has no judged cell still publishes,** with its
   full accounting. The claim text and the report page say that no rate is
   stated for that arm. This is option (c).

7. **The checker is published once, with these in it.** They land before
   `@colophon-claims/check@0.2.1` is published: the Terminal-Bench 2.1
   task-name projector, the Run digest in the checker's command output, the
   comparability sentence, the zero-judged wording, and `--help` exiting 0
   ([#4958](https://github.com/Jinn-Network/mono/pull/4958)). This is
   option (a).

8. **Full-slate limits.**
   - The aggregate evidence cap for the named readers is raised to a figure
     measured on a real run.
   - The method sets a longer run window, and `lock` prints the close time.
   - One replicate stays the default. The method takes a flag for more, and
     `lock` says that fewer than five trials is not leaderboard-comparable.
   - The reader accepts only Harbor versions that have a real fixture in the
     tree and refuses the rest by name.

9. **Steps 1, 2 and 7 of
   [#2851](https://github.com/Jinn-Network/mono/issues/2851) and #4742 are
   reworded** once the changes above have landed. Step 7 becomes: fetch the
   bundle, then run the checker command the claim prints. The `check`
   dispatch already publishes the `@colophon-claims/verify` alias, so the
   publish order stays `check`, then `core`, then `cli`. This is option (a).

The three publishes stay on hold until these have landed and a repeat of the
dry run reaches a checked bundle with no workaround.

## Conflicts settled

Two rulings decide between earlier documents that said different things.

**The denominator, in DR-2026-08-17-b decision 6.**
[DR-2026-08-17-b](./2026-08-17-official-suite-protocol.md) decision 6 says
two things. First: "TB accuracy is mean binary reward over trials (errors
count as 0)." Then: "Use the registered method that averages all judged
replicates per task (wilson@1 is acceptable)." For a trial with no reward the
two differ. Harbor's mean counts it as 0. The registered method leaves it
out.

The rule that is normative for all methods had already decided the counting.
The benchmarking application design
(`docs/superpowers/specs/2026-07-28-benchmarking-application-design.md`),
section 9.3: "Only `judged` cells enter any score." The product design
(`docs/superpowers/specs/2026-08-05-benchmark-product-design.md`), addendum of
2026-08-07: "Only judged cells enter score denominators: infrastructure
failures and every other unjudged/expired cell are never silently converted
into score losses."

Decision 2 settles it on that side. A trial with no reward stays outside the
score, so for such a trial the parenthesis "(errors count as 0)" does not
describe a rate Colophon states. The registered method over judged
replicates governs. The rate can then be higher than Harbor's mean for the
same job, which is why the name is conditional.

Decision 3 of the same record is applied, not changed: "When not
`leaderboard_submit_ready`, Report `limitations[]` carries a canonical
sentence." No brought run can show today that it is leaderboard-ready, so
every brought run carries that sentence, and the sentence says that the rate
can be higher than Harbor's mean.

**`quote` on the claimant path, against DR-2026-09-04.**
[DR-2026-09-04](./2026-09-04-colophon-surrounds-the-run.md) decision 5 lists
"quote before full-suite lock" among the running decisions the official-suite
records lose, and its decision 4 says the runner's orchestration "receives no
investment toward surviving on a claimant's machine". The same record "Does
not amend: DR-2026-08-18-f (method operand)", and
[DR-2026-08-18-f](./2026-08-18-colophon-method-cli.md) decision 1 says: "After
bind, quote / lock / launch / collect / report / publish stay as they are."
The code follows the second. `lock` refuses a draft that was never quoted,
with "only a quoted draft can be locked"
(`packages/benchmark-product/core/src/operations/run-lock.ts`).

Decision 4 settles both the direction and the order. The direction is
DR-2026-09-04's: `lock` accepts an unquoted draft for a brought run. The
order is that the first publish keeps `quote` as a required step, and the
walkthrough labels it a stopgap. The issue gives the reason: accepting an
unquoted draft is a change to the lifecycle state machine with an open
question in it (`lock` needs a way to know the run will be brought, because
the import comes later), and it changes no digest, so it costs one later
`core` version. So `quote` on the claimant path is a labelled departure from
DR-2026-09-04 decision 5 that ends when `lock` accepts an unquoted draft. It
is not a reversal of that decision.

## Defaults taken on open points

No ruling settles the fourteen points below. They are defaults, not rulings.
Each is taken on the operator's instruction to follow the recommendation,
and each is what gets built unless the operator says otherwise. Points 4 and
11 freeze when the checker is published; the operator reads both in the
pull request that adds them, before that.

1. **Who sponsors and approves proposal 0002.** It is authored under one
   operator credential, sponsored and ruled by the operator, and approved
   under the operator's other maintainer credential, as earlier pull requests
   in that repository were; the other maintainer is asked for a review and
   not awaited. Both credentials are one person's
   ([DR-2026-08-31](./2026-08-31-codeowners-two-operator-identities.md)), and
   that repository's bar against a change that benefits only one
   implementation is argued in the proposal's text, not met by a second
   implementation.
2. **How strict the family is.** As strict as proposal 0002's draft: one
   harness, `harbor`; at least one named and digested `testMaterial` entry;
   no inline content in the grader or the test material; at least one
   measurement. The two functions that compute the harness's package content
   hash and read measurements from a reward map live in the task profiles
   package with their own vectors, and if the proposal's sponsor removes
   them, `core` keeps its own copies.
3. **Whether the specification import gates the publishes.** No. Neither the
   import of the new vectors into the protocol specification repository nor
   that repository's next release gates the three publishes, and the vectors
   already waiting to be imported there need no proposal of their own. The
   import should be merged before the bundle of #2851 is hosted.
4. **The comparability sentence.** One sentence, carried by every brought
   run on the official slate whatever its coverage or replicate count. It
   says the run is not a leaderboard submission and that its rate can be
   higher than Harbor's mean for the same job; its exact wording is set in
   the checker pull request that adds it.
5. **What entitles a page to say "Terminal-Bench 2.1" and "accuracy".** The
   suite name rests on the checker's pinned digests of the 89 official
   Tasks. "Accuracy" is used only when all 89 tasks are present and every
   planned cell reached a verdict, so a ten-task slice with every cell judged
   reads "Pass rate over judged cells"; that is narrower than decision 2's
   words, which permit the extra condition.
6. **A generic `--file` import on the official slate.** Refused in
   `core@0.1.0`: a run on the official slate comes through `run import
   --from harbor`. The refusal is in the producer only, because the checker
   can require the import marker to name Harbor and cannot prove that a
   Harbor process wrote the rewards.
7. **The limit figures.** The evidence cap is the larger of 64 MiB and a
   per-cell figure, measured on a real run, times the expected cells. The run
   window is the larger of 24 hours and tasks times replicates times 2 hours
   (890 hours for the full slate at five replicates), and the one Harbor
   version accepted is 0.21.0.
8. **Where the dry run and the measuring run happen.** In `linux/amd64`
   containers on the machine the coordinating agent runs on. That proves the
   path and measures bytes; a score made under emulation is not a result, and
   a native linux/x64 host replaces the containers if the operator supplies
   one.
9. **What the verifier pins commit and seal.** A manifest of file paths and
   digests, and no task package bytes. Official Tasks carry no
   `task-provenance/v1`, because no sourced timestamp exists, so
   `core@0.1.0` states no paired comparison on this slate, and adding
   provenance later moves all 89 Task digests, which needs a new pin table
   under a new token and a new checker version.
10. **Whether the checker recomputes each reward.** Not in `check@0.2.1`: it
    does not recompute a reward from the carried `trial-result.json` and does
    not enforce `requiredRefs`. Decision 7's list is closed and whether a
    bundle carries those bytes by default was not verified; it can arrive
    later as a new capability with a later minimum reader, and bundles sealed
    before then will not have it.
11. **The capability token's name.** `terminal-bench-2-1-comparability`.
    Another suite gets its own token, because a token carries one minimum
    reader release.
12. **Retries, and more than one trial per task.** A Harbor job that ran with
    retries is refused by name. More than one trial per task is accepted once
    a real two-attempt record has imported cleanly; if it does not, the
    publishes wait for the fix.
13. **Analyses on the official slate.** Refused at `lock` in `core@0.1.0`;
    only the per-arm rate is reported. Widening this later accepts more
    drafts and changes no existing digest.
14. **This record.** It is added. It needs a code owner's approval and gates
    nothing but the closing of #4959.

## What this does not yet prove

- That any of it is built. When this record was written, with `next` at
  a5ca7a7bf9, only #4958 and #4960 of the work the rulings name were merged.
- That proposal 0002 is accepted. Until it is ruled under that repository's
  governance, the family's field names and vectors can change, and the
  change to `packages/task-execution/profiles` waits on it.
- That the ruling on proposal 0002 is independent. It is one person under
  two credentials (default 1).
- That a full-slate run fits the limits. The cap figure had not been
  measured when this record was written, and the issue's rate for a full
  slate came from an emulated host and is only indicative.
- That several trials per task, a retried trial or a trial with no reward
  read correctly from a real record. The issue records that the only real
  fixture is from Harbor 0.21.0, with one trial per task and no retries.
- That an anchored lock works for a stranger. The issue records that no dry
  run has anchored a lock against a real endpoint. Decision 5 requires one
  before publish.
- That a brought run is leaderboard-ready. Decision 2 says no brought run can
  show that today. The checker also cannot prove that a Harbor process wrote
  the rewards (default 6) and does not recompute them (default 10).

## Consequences

- The work is tracked as sub-issues of #4742. The new family in the task
  profiles is [#4973](https://github.com/Jinn-Network/mono/issues/4973); what
  the first checker release must carry is
  [#4972](https://github.com/Jinn-Network/mono/issues/4972); the full-slate
  limits are [#4975](https://github.com/Jinn-Network/mono/issues/4975); the
  re-pinned receipts are
  [#4974](https://github.com/Jinn-Network/mono/issues/4974). Decisions 1 and
  2 unblock #4936 and #4938, and decision 6 answers
  [#4939](https://github.com/Jinn-Network/mono/issues/4939).
- The order decision 1 fixes is: proposal 0002, then the platform change,
  then one canary publish, then the re-pinned receipts. No package version
  changes.
- The claimant walkthrough
  ([#4942](https://github.com/Jinn-Network/mono/issues/4942)) says that
  `quote` is a stopgap and that Harbor's oracle agent is the suggested
  control, and it names the two provider profile values and one example
  endpoint with the trust material a reader needs. This record names no
  endpoint.
- Left for a later version: `lock` accepting an unquoted draft (decision 4)
  and one-arm claims (decision 3,
  [#4948](https://github.com/Jinn-Network/mono/issues/4948)). The issue
  records that neither changes a digest of a claim already made; the first
  costs one later `core` version.
- This path is under CODEOWNERS. #4959 is closed after this record is
  merged. The record moves no files and changes no behavior.

## Alternatives rejected

The options the operator did not take, with the reason the issue or the
ruling gives.

- **The `deterministic-process` family for the official slate** (decision 1,
  as first recommended). The task packages state no image digest, platform,
  parser identity or test-transition list, so those fields of the block
  would be invented, and `linux/amd64` would be false for three packages.
- **One spec for the whole slate, named by the slate digest.** It says
  nothing about a task that its Task record does not already say.
- **A boolean `harbor-verifier-pass` measurement.** The interoperability
  profile, section 8.3, forbids reducing Harbor output to a private boolean,
  and it would seal values nobody measured.
- **Always calling the rate Terminal-Bench 2.1 accuracy.** A reader who
  compares it with a leaderboard figure is comparing two denominators under
  one name.
- **Grading a trial with no reward as a fail, to match Harbor's mean.** The
  reader would supply a measurement Harbor never wrote.
- **A placeholder for the endpoint in the walkthrough.** A stranger cannot
  finish the step without finding an endpoint alone.
- **The posted Run digest alone as the commitment.** It proves no ordering.
- **The Run announcement as the commitment.** It is not among the claimant
  verbs, it needs the claimant to serve a public source, and whether it
  accepts this slate was not verified.
- **Refusing `publish` when an arm has no judged cell.** It hides the run.
- **Having the platform aggregate withhold the rate.** It changes a platform
  package, so every receipt pinned to the current platform commit would be
  redone.
- **Publishing the checker as it is and adding the rest later.** Each later
  release needs a new version and receipt and a new pin in `core` and `cli`,
  and claims made in between keep the old page.
- **Leaving the bodies of #2851 and #4742 alone.** The walk would then fail
  steps 1, 2 and 7 by definition.

Not rejected, only deferred: one-arm claims, and `lock` accepting an
unquoted draft in the first publish.

## Ratification

The operator ruled on 2026-10-06 on design issue #4959, and the ruling was
recorded on that issue the same day by the coordinating agent on the
operator's instruction. The fourteen defaults are not rulings; they stand
unless the operator says otherwise. Ratified on code-owner approval of this
record by the operator credential that did not author it.

## Amends (at ratification)

- [DR-2026-08-17-b](./2026-08-17-official-suite-protocol.md) decision 6, on
  one point: for a trial with no reward, "(errors count as 0)" does not
  describe a rate Colophon states. The rest of that decision, and decision
  3, stand. That record carries the amendment line at decision 6.
- Does not amend: [DR-2026-09-04](./2026-09-04-colophon-surrounds-the-run.md).
  `quote` as a required claimant step is a stopgap against its decision 5,
  and that decision stands. Does not amend DR-2026-08-18-f (method operand),
  DR-2026-09-03 (the new family goes through a numbered proposal, as that
  record requires), the two-arm rule, or the rule that no endpoint ships as
  a default and no vendor name appears in source: the example endpoint is
  named in a walkthrough, not in source.
