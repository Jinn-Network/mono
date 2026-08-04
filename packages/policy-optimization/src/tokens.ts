// SPDX-License-Identifier: MIT

/**
 * Format tokens, the closed vocabularies, and the on-disk names of the campaign state layer.
 *
 * Authority: `docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md` ("the
 * product design"), §5.1 and §5.2.
 *
 * These are **product-convention format tokens**, not record kinds and not media types (product
 * design §5.1: "a product convention, not a record kind"). Nothing in this package publishes a
 * schema, registers a media type, or claims a tier-2 surface.
 */

/** Product §5.1 — the campaign document's `formatToken`. */
export const CAMPAIGN_FORMAT_TOKEN = "network.jinn.policy-optimization.campaign/1.0" as const;

/**
 * The journal entry envelope's `formatToken`.
 *
 * FINDING F-C7a-1 (README): the product design names the campaign document's token and the
 * journal's event list, but no token for the journal entries themselves. One is added here rather
 * than left implicit — the journal is a host-persisted document this package both writes and
 * re-reads across restarts, and a versionless envelope has no way to refuse a future revision's
 * bytes. It is host-local state, never network truth (§5.2), so the addition is a product
 * convention and not a protocol surface.
 */
export const CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN =
  "network.jinn.policy-optimization.campaign-journal-entry/1.0" as const;

/**
 * The namespaced extension key (TEP §21.3) a **derived wave Benchmark** carries.
 *
 * §6.2's task selection can only be expressed as a Benchmark restricted to the selected items
 * (records §7.3: a Run's cell set is the full cartesian product of its Benchmark's items). The
 * restriction inherits the parent's `name` and `version`, so without this key two different item
 * sets would circulate under one label with nothing on either record to distinguish them. It names
 * the parent slate, the campaign, and the wave — enough for a reader who resolved a Run's Benchmark
 * to see what it is.
 */
export const WAVE_DERIVATION_EXTENSION_KEY =
  "network.jinn.policy-optimization.wave-derivation" as const;

/**
 * Product §5.1 — the v0 mutation surface. Harness and model are frozen per campaign;
 * `isolationPolicy` is excluded because the axis is vacuous (substrate §4.3), and an axis nobody
 * can vary is not a search dimension.
 */
export const V0_MUTATION_SURFACE = ["loadout"] as const;

/**
 * Substrate §4.1 — the four core axes, mirrored (not imported as a value) so this package can
 * state the "every core axis is either frozen or mutable" rule. Pinned against
 * `@jinn-network/policy-identity`'s `CORE_AXES` by a test, so a drift fails rather than splitting
 * the rule across two lists.
 */
export const CORE_AXES = ["harness", "model", "loadout", "isolationPolicy"] as const;

/** Product §5.2 — the lifecycle, in order. */
export const CAMPAIGN_LIFECYCLE_PHASES = ["DRAFT", "EXPLORING", "CONFIRMING", "CLOSED"] as const;

/**
 * Product §5.2 — the journal's event list, verbatim and closed. An event type not on this list is
 * refused: the journal is the non-derivable ordering of product decisions, and an unrecognized
 * decision kind is exactly the thing a reader cannot reconstruct from records.
 */
export const CAMPAIGN_JOURNAL_EVENT_TYPES = [
  "created",
  "candidate-admitted",
  "candidate-rejected",
  "wave-planned",
  "allocation-decided",
  "run-sealed",
  "matrix-assembled",
  "report-recorded",
  "frontier-updated",
  "promotion-run-sealed",
  "closed",
] as const;

/**
 * The frozen evidence bundle's `formatToken` (product §7.1's `evidence` argument; substrate §5.1's
 * `evidenceProvenance`).
 *
 * FINDING F-C7c-2 (README): neither design names a token for the bundle *document*. The substrate
 * names its three members as the manifest's `evidenceProvenance` block, and the product names
 * "frozen evidence bundle reference" as a proposer argument, but the thing the reference addresses
 * has no declared identity. One is added here on C7a's precedent (F-C7a-1): the bundle is a
 * host-persisted document this package seals, hands to proposers, and later re-checks a manifest
 * against, and a versionless envelope has no way to refuse a future revision's bytes. Product
 * convention, not a protocol surface.
 */
export const EVIDENCE_BUNDLE_FORMAT_TOKEN =
  "network.jinn.policy-optimization.evidence-bundle/1.0" as const;

/**
 * Product §7.4's transfer security gradient, in escalating order of risk:
 * "prompts < skills (injection surface) < hooks/tool configs (arbitrary code execution) < harness
 * forks (their runtime)".
 *
 * The order is load-bearing, not decorative: `hostilePayloadClasses` is the tail of this list, so
 * a class added in the middle is automatically non-hostile and a class added at the end is
 * automatically hostile. Getting a new class silently classified as safe is the failure this
 * ordering prevents.
 */
export const PAYLOAD_CLASSES = ["prompt", "skill", "hook-or-tool-config", "harness-code"] as const;

/**
 * The classes that are **code-execution consent** at admission for cross-operator candidates
 * (§7.3, §7.4): "the smoke canary and every subsequent cell *run* the payload".
 */
export const HOSTILE_PAYLOAD_CLASSES = ["hook-or-tool-config", "harness-code"] as const;

/** The population registry's file name inside a campaign directory. JSON, rewritten atomically. */
export const CAMPAIGN_POPULATION_FILENAME = "population.json" as const;

/** The population registry document's `formatToken`. Host-local state; see F-C7c-2's reasoning. */
export const CAMPAIGN_POPULATION_FORMAT_TOKEN =
  "network.jinn.policy-optimization.population/1.0" as const;

/** The sealed campaign document's file name inside a campaign directory. */
export const CAMPAIGN_DOCUMENT_FILENAME = "campaign.json" as const;

/** The append-only journal's file name inside a campaign directory. JSON Lines, one entry per line. */
export const CAMPAIGN_JOURNAL_FILENAME = "journal.jsonl" as const;
