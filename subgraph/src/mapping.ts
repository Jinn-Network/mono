// Subgraph mapping placeholder.
//
// PR #37 wired this subgraph against guessed ABIs and an NFT-per-CID entity
// model. Per DR docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md,
// the rebuilt Jinn-specific subgraph (operator-rooted; synthesized
// Operator + Execution + Validation + Feedback entities from
// IdentityRegistry / ValidationRegistry / ReputationRegistry events) lands
// under bead jinn-mono-fud against the real `0x8004…` ABIs.
//
// This stub keeps the package buildable while the per-CID handlers are
// removed. No event handlers are registered.

export {};
