# @jinn-network/task-admission

Differential admission: *(candidate task + environment record) → `DifferentialAdmissionReceipt/3`*.

Given a candidate's sealed EvaluationSpec bytes and the sealed bytes of the environment record it
names, this package proves — per test path, twice on each side — that applying the gold patch
resolves the candidate's failing assertions and that the empty patch does not. The proof is a
receipt: policy version, task binding, `goldPatchHash` (a digest; never patch bytes), the 2×2
observations, the derived transitions, and `environment.recordDigest`.

Two rules define the boundary (design §7.1):

- **Inline match is enforced.** The EvaluationSpec's inline `image`, `platform`, and `parser` must
  equal the referenced record's, or admission refuses with `env-record-mismatch`.
- **Admission never reads attestations.** The receipt cites the environment record by digest and
  claims nothing about who attested it. Joining a receipt to attestations is the *consumer's*
  trust-policy decision.

Admission owns no container runtime: `runInEnvironment` is an injected port. It owns no key
material: `sealReceipt` takes a `DsseSigner`.
