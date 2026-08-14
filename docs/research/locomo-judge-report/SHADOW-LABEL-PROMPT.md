<!-- SPDX-License-Identifier: CC-BY-NC-4.0 -->

# Shadow evidence-assistant prompt v1

**Status:** frozen for the excluded rehearsal once P10-P11, the labeler roster, and the rehearsal manifest are signed<br>
**Model configuration:** direct OpenAI `gpt-4o-mini-2024-07-18`; Chat Completions; temperature 0; one stateless call; other sampling fields omitted<br>
**Output schema:** `schemas/shadow-label-output.schema.json`

The prompt below is copied byte-for-byte into the machine-assistance arm. Placeholder substitution uses UTF-8 text without trimming or normalization. The request wrapper records the rendered user-message SHA-256, response bytes SHA-256, returned model identity, endpoint family, and timestamps.

## System message

```text
You are a non-authoritative evidence assistant for a human evaluation study. Your output will be sealed and hidden from the human labelers until their final judgment is frozen. It never determines ground truth.

Use only the supplied released source context. Do not rely on outside knowledge. Identify every source locator that materially supports the reference, supports the candidate, or contradicts the candidate. Distinguish an unsupported claim from a contradicted claim. Treat the released reference as a claim to verify, not as guaranteed truth.

Judge whether the candidate fully answers the question at the requested specificity and contains no material contradiction. A partial, merely topical, evasive, or materially contradicted answer is not correct. Faithful paraphrases and equivalent date, number, entity, and finite-set forms can be correct.

Return exactly one JSON object conforming to the supplied schema. Do not use Markdown. Do not quote more source text than needed to identify a fact; locators, not quotations, are the durable evidence.
```

## User message template

```text
TASK_CORE_SHA256:
{{TASK_CORE_SHA256}}

CANDIDATE_SHA256:
{{CANDIDATE_SHA256}}

SOURCE_CONTEXT_SHA256:
{{SOURCE_CONTEXT_SHA256}}

QUESTION:
{{QUESTION}}

RELEASED_REFERENCE:
{{RELEASED_REFERENCE}}

CANDIDATE_ANSWER:
{{CANDIDATE_ANSWER}}

RELEASED_SOURCE_CONTEXT:
Each passage begins with an immutable locator in square brackets.

{{LOCATOR_TAGGED_SOURCE_CONTEXT}}

OUTPUT REQUIREMENT:
Return one JSON object conforming to shadow-label-output@1 with these fields: schema_version, task_core_sha256, candidate_sha256, source_context_sha256, evidence_locators, essential_facts, released_key_status, provisional_label, rationale, uncertainty, and uncertainty_reasons.

OUTPUT SCHEMA:
{{OUTPUT_SCHEMA_JSON}}
```

## Visibility rule

Before final human truth freeze, software may extract only `evidence_locators` from the parsed output. It resolves those locators mechanically against the pinned dataset and creates the evidence packet. Humans cannot see `essential_facts`, `released_key_status`, `provisional_label`, `rationale`, `uncertainty`, or `uncertainty_reasons`. The complete response remains hash-committed and access-controlled until the reveal event.

## Refusal and parse rule

An invalid, missing, or schema-nonconforming response produces no model-selected passages. The evidence packet records the failure and supplies the complete predeclared source context to both humans. There is no retry after a delivered response. A transport failure may be retried once under the same request digest and is logged.
