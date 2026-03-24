# Jinn Protocol Specification

> Version: 0.1.0-draft
> Date: 2026-03-23
> Author: Oak

## 1. Overview

Jinn is a training protocol for state restoration. It defines a loop in which desired states are created, restoration is attempted, results are evaluated, and knowledge produced in the process is made available to future participants. The network's capacity to restore state increases over time as knowledge accumulates.

The protocol defines the loop — its concepts, their relationships, and the constraints that make the loop trustworthy. What the loop optimises for is decided by its governing body. How the loop executes is determined by its implementation.

## 2. The Loop

The protocol is a loop with four stages:

```
Creation → Restoration → Evaluation → Knowledge
    ↑                                      │
    └──────────────────────────────────────┘
```

Each stage produces an input to the next. Knowledge feeds back into creation — the network can take on harder desired states because it has learned from previous ones.

### 2.1 Creation

A desired state is defined and published with a fee. The desired state expresses what should be true. The fee is a demand signal — someone is willing to pay for this state to be restored.

The creator is responsible for defining the desired state clearly enough that its restoration can be verified. A poorly defined state produces ambiguous evaluations and wastes the creator's fee.

### 2.2 Restoration

A participant attempts to make the desired state true. The protocol does not constrain how restoration is performed. Different states require different approaches. The network's capacity to restore state grows as participants discover and refine approaches over time.

### 2.3 Evaluation

An independent party verifies whether the desired state has been restored. Evaluation produces a signal: restored or not restored.

Evaluation is the source of trust in the protocol. It determines whether fees are released, whether participants are rewarded, and whether knowledge can be assessed for quality.

### 2.4 Knowledge

Restoration produces knowledge — what was tried, what was observed, what worked, what didn't. This knowledge is captured and made available to other participants for use in future restoration attempts.

Knowledge produced during restoration should be available to other participants. Creators of knowledge may set terms of access. How knowledge is shared — the mechanisms of capture, publication, and distribution — is a client concern, not a protocol mechanism. The governing body may choose to incentivise knowledge sharing through its distribution strategy, but this is optional.

Quality of knowledge is not determined at creation. It is inferred over time by correlating which knowledge was used in restoration attempts and how those attempts were evaluated.

## 3. Roles

The loop involves three distinct roles:

- **Creator** — defines desired states and funds their restoration
- **Restorer** — attempts to make desired states true
- **Evaluator** — independently verifies whether restoration succeeded

A single entity may participate in multiple roles across different desired states, but independence between roles on the same desired state is a property the governing body should be able to enforce.

## 4. Incentives

The loop requires energy to sustain itself. Four activities must be incentivisable:

1. **Creation** — producing well-defined desired states that advance the network's capacity
2. **Restoration** — doing the work, regardless of outcome
3. **Successful restoration** — achieving the desired state, optionally rewarded more than restoration alone
4. **Evaluation** — producing the trust signal that enables everything else

The protocol requires that an implementation can express incentives for all four activities. What weight each receives and how incentives are distributed is a governance concern.

## 5. Governing Body

The protocol requires a governing body that can:

- Express what it considers legitimate evaluation
- Direct incentives toward activities and standards it endorses
- Withdraw incentives from activities and standards it does not endorse
- Adjust these positions over time as the network evolves

The form of the governing body — DAO, multisig, token vote, or any other structure — is an implementation concern. The protocol requires the capability, not the mechanism.