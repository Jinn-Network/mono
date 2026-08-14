<!-- SPDX-License-Identifier: CC-BY-NC-4.0 -->

# Labeler identity and conflict roster

**Status:** incomplete; blocks the excluded rehearsal<br>
**Profile:** `HUMAN-ATTESTATION-PROFILE.md`<br>
**Approval authority:** operator

Each evaluator IRI must resolve under the identity-binding policy chosen for the rehearsal. Each DSSE key fingerprint must identify the public key used to sign that person's Jinn Result Evaluation envelopes. One person may hold multiple non-conflicting roles generally, but Labeler 1 and Labeler 2 must be different people and keys for every item. The signed roster is the operator's real-person trust attestation; DSSE and Agent IRI verification prove key control and declared agent-distinctness, not party independence.

| Role | Human name or approved pseudonym | Evaluator IRI | DSSE key ID | Public-key fingerprint | Identity-binding evidence | Conflicts | Approved scope |
|---|---|---|---|---|---|---|---|
| Candidate author / Labeler 1 | `[REQUIRED]` | `[REQUIRED ABSOLUTE IRI]` | `[REQUIRED]` | `[REQUIRED]` | `[REQUIRED]` | `[REQUIRED, MAY BE NONE]` | rehearsal / development / confirmatory |
| Labeler 2 | `[REQUIRED]` | `[REQUIRED ABSOLUTE IRI]` | `[REQUIRED]` | `[REQUIRED]` | `[REQUIRED]` | `[REQUIRED, MAY BE NONE]` | rehearsal / development / confirmatory |
| Bank custodian | `[REQUIRED]` | `[REQUIRED ABSOLUTE IRI OR N/A]` | `[REQUIRED IF SIGNING]` | `[REQUIRED IF SIGNING]` | `[REQUIRED]` | `[REQUIRED, MAY BE NONE]` | source allocation, shadow embargo, reveal log |

## Required operator declaration

- [ ] I attest that the two primary evaluator identities represent distinct humans, and I have verified that they use distinct signing keys.
- [ ] I have reviewed candidate authorship, dial481 contribution, employment, financial, benchmark-author, and vendor relationships as potential conflicts.
- [ ] I approve the identity-binding evidence and evaluator IRIs for the stated scope.
- [ ] I understand that DSSE signature validity proves control of a key, while this roster supplies the separate human identity and trust decision.

**Operator:** `[REQUIRED]`<br>
**Approved at:** `[REQUIRED RFC 3339 UTC]`<br>
**Signature or signed-commit identity:** `[REQUIRED]`

Any roster change after rehearsal selection requires an amendment, new manifest, and new rehearsal questions unless the change only removes a person before they saw an item.
