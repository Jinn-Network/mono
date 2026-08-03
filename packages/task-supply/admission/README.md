# @jinn-network/task-admission

> Phase C maturity: semantic candidate, publication disabled. Its native requester use is not
> independent ratification; graduation requires approved authority, a second independent
> consumer, frozen conformance, packed external installation, and load-bearing live use.

Differential admission: *(candidate task + environment record) → `DifferentialAdmissionReceipt/3`*.

Given a candidate's sealed EvaluationSpec bytes and the sealed bytes of the environment record it
names, this package proves — per test path, twice on each side — that with the gold patch applied
every assertion the candidate declares fail-to-pass is *observed failing* on the empty side and
passing on the gold side, and every assertion it declares pass-to-pass passes on both. The proof
is a receipt: policy version, task binding, `goldPatchHash` (a digest; never patch bytes), the 2×2
observations, the derived transitions, and `environment.recordDigest`.

What the receipt does **not** claim: nothing about the environment beyond the record digest it
names, nothing about content safety, and nothing about assertions outside the candidate's declared
sets. It is a claim about this candidate's grader, and only that.

Three rules define the boundary (design §7.1):

- **Inline match is enforced.** The EvaluationSpec's inline `image`, `platform`, and `parser` must
  equal the referenced record's, or admission refuses with `env-record-mismatch`.
- **The candidate's declared grading is what gets proven.** The declared transitions must be the
  ones the sealed spec grades against, over the test material the candidate declares
  (`transitions-mismatch` / `invalid-candidate`), and must be the ones the observations prove
  (`transitions-mismatch`). A pair whose gold patch flips something *other* than what it declares
  is unsolvable, and does not earn a receipt.
- **Admission never reads attestations.** The receipt cites the environment record by digest and
  claims nothing about who attested it. Joining a receipt to attestations is the *consumer's*
  trust-policy decision.

Admission owns no container runtime: `runInEnvironment` is an injected port. It owns no key
material: `sealReceipt` takes a `DsseSigner`.

## Two families, two policies

`admitCandidate` implements the SWE differential: empty versus gold over declared test-path
transitions. `admitChainCandidate` implements the state-predicate differential: do-nothing
versus reference over the success **conjunction**. Individual predicates holding at baseline is
expected and is never a refusal — only the conjunction's flip from false (empty) to true
(reference) earns a receipt.
