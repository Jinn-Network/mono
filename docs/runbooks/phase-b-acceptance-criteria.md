# Phase B acceptance criteria (ids 1–62)

This is the canonical enumeration behind the `acceptanceCriteria` field of the Phase B
closure manifest (`client/src/daemon/phase-b-closure-manifest.ts`), which requires exactly
62 entries with ids 1–62, every one `passed`, each carrying at least one evidence digest.
The manifest's ids are meaningless without this list; a live closure run attaches evidence
per criterion below.

**Provenance.** Authored as §17 of the SDD plan `phase-b-native-operator-vertical.md`
(work packages B0–B10, landed via PR
[#2363](https://github.com/Jinn-Network/mono/pull/2363)). The plan file itself was never
committed — it lived in a since-deleted worktree; this document commits the enumeration
verbatim as recovered from the authoring session record, with only formatting changes.
The committed SDD ledger for the same plan is
`.superpowers/sdd/phase-b-native-operator-vertical/progress.md`.

Phase B is complete only when all criteria are machine-verifiable:

1. A native `TaskSpecification` and `SubmissionRecord` enter through requester input without `SignedTaskV1`.
2. Task, EvaluationSpec, receipt, Submission, and requester envelope are sealed before posting.
3. Every original sealed byte sequence is retained and retrieved byte-for-byte.
4. Consumers verify advertised digest identity over retrieved bytes rather than reserialization.
5. Today-mode `TaskCreated` anchors the exact Task digest.
6. The signed requester source associates the full chain task identity with the exact Submission.
7. Requester DSSE payload equals the exact Submission bytes.
8. Admission receipt subjects equal the exact Task and EvaluationSpec digests.
9. Discovery/requester/admission/executor/evaluator identities persist across two cold restarts.
10. Required role keys are distinct and have effective-time trust bindings.
11. Executor binding succeeds using the configured persistent delivery identity.
12. Capability matching uses `backend.capabilities()`, launcher capability/probe, and preflight.
13. An unsupported profile or requirement is rejected before a claim intent exists.
14. Tier 4 claim policy applies network, profile, spend, deadline, capacity, and finality rules.
15. The claim is tied to the specified durable `engagementId` and `claimOperationId`.
16. Duplicate discovery entries create no duplicate claim or engagement.
17. Discovery consumption advances a durable per-source high-water mark.
18. A no-change polling cycle performs no full archive rescan.
19. Execution occurs through public `TaskExecutionBackend.submit/recover/observe/deliveries/fetchDelivery`.
20. Backend-stored Task/Submission bytes equal the requester originals.
21. The marketplace Attempt URI comes from `deriveMarketplaceAttemptUri`.
22. Execution evidence is captured as current `ExecutionEvidenceDocument` bytes.
23. Every `Delivery.evidenceRecords` reference resolves and verifies before settlement.
24. The native solution Delivery references the correct Task, Attempt, outputs, execution IDs, and evidence.
25. The production testnet entry supplies a persistent Delivery signer with no native fallback.
26. Evidence and Delivery bytes are publicly announced and retrievable.
27. Solution settlement is submitted once, canonically observed, and finalized.
28. Evaluation is derived from the exact subject Task and solution Delivery.
29. Evaluator-sealed public Submission remains grant-free.
30. Evaluator signing uses host-owned deployment authority, not requester capability grants.
31. Evaluation executes through `TaskExecutionBackend` and the evaluation harness.
32. The verdict is a valid DSSE envelope containing `ResultEvaluationStatement`.
33. The evaluation Delivery's output named `verdict` references the exact verdict envelope digest.
34. All named verdict checks, requester/admission/executor/evaluator bindings, and on-chain verdict correspondence pass.
35. Verdict settlement is separately submitted, observed, reconciled, and finalized.
36. A separate process discovers and retrieves the complete public evidence graph.
37. That consumer has a separate DB/state directory and no access to producer private stores.
38. The consumer independently verifies exact bytes, signatures, bindings, and record relationships.
39. Restarting at every designated checkpoint creates no duplicate post, claim, Delivery, evaluation, or settlement.
40. Two concurrent operator processes result in one worker and zero duplicate operations.
41. Transaction replacement remains one logical operation.
42. The accepted safe-chain reorg scenario restores canonical projection and saga state.
43. Reorg correction appends withdrawals/retractions and never rewrites signed history.
44. Every durable store has one declared lifecycle owner.
45. `BaseVenue` is opened once per process/state path.
46. Native composition contains no relative import into another package's source tree.
47. Clean acceptance installs catalog-generated tarballs outside the monorepo.
48. Dependency provenance contains no `file:`, `portal:`, workspace alias, or source-tree fallback.
49. Native mode contains no permissive capability fallback.
50. Native mode contains no legacy record as semantic authority.
51. Native mode cannot import/call Task/Submission or Delivery bridge functions.
52. All previously throwing native Delivery/evaluation/verdict ports have concrete implementations.
53. The Phase A exact-head gate and every affected domain/aggregate hosted check are green.
54. The architecture catalog marks every Phase B runtime package consistently with its accepted canary/packing status.
55. Base Sepolia chain/address assertions pass and the golden command refuses chain ID 8453.
56. The closure run publishes a complete sanitized artifact manifest and BaseScan links.
57. Every transitional component touched by Phase B has a deletion or graduation condition.
58. Every implementation PR has an explicit owner tier and independent review evidence.
59. Luna work is limited to bounded tasks with frozen contracts and attached test evidence.
60. Terra signs off every cross-package integration and the final vertical.
61. Sol is used only for the B2 identity/trust boundary and B7 evaluator/verdict boundary, unless a documented escalation fires.
62. All required Sol findings are resolved or explicitly block closure.

## Architecture-mutation tripwires

Architecture mutation tests should fail if native code reintroduces:

- `acceptLegacyCards: true`;
- `capabilityMatch: async () => ({ ok: true })`;
- `archive.since('')`;
- `ephemeral-discovery-key`;
- `synthesizeLegacyExecutionDocuments`;
- native bridge Delivery extensions;
- native gap functions that throw;
- a second venue open against the same path.
