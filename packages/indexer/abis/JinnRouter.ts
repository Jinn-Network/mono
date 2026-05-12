/**
 * JinnRouter ABI slice — only the events and function surfaces that the
 * indexer needs. Sourced from client/src/adapters/mech/types.ts.
 *
 * NOTE: the V3 JinnRouter (task-coordinator-router-v3) is the current
 * testnet contract. The mainnet deployment uses the same event signatures.
 * TaskFinalized and TaskRefunded do not exist as standalone events on
 * JinnRouter at v0.1 — task completion state is derived from
 * SolutionDeliveryClaimed / VerdictDeliveryClaimed + canClaimTask simulation.
 * The Task.finalized and Task.refunded schema columns start as false and are
 * updated when a SolutionDeliveryClaimed event indicates all attempts resolved.
 * See README.md §Schema-version policy for the limitation note.
 */
export const JINN_ROUTER_ABI = [
  // ── Task creation ─────────────────────────────────────────────────────────
  {
    name: 'TaskCreated',
    type: 'event',
    inputs: [
      { name: 'creator', type: 'address', indexed: true },
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'manifestDigest', type: 'bytes32', indexed: true },
      { name: 'taskCidDigest', type: 'bytes32', indexed: false },
      { name: 'maxClaims', type: 'uint16', indexed: false },
      { name: 'requiredVerdicts', type: 'uint16', indexed: false },
      { name: 'solutionBudget', type: 'uint256', indexed: false },
      { name: 'verdictBudget', type: 'uint256', indexed: false },
    ],
  },
  // ── Task attempts ─────────────────────────────────────────────────────────
  {
    name: 'TaskAttemptCreated',
    type: 'event',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'operator', type: 'address', indexed: false },
      { name: 'priorityMech', type: 'address', indexed: false },
      { name: 'deliveryRate', type: 'uint256', indexed: false },
    ],
  },
  // ── Solution delivery (used to mark tasks finalized) ──────────────────────
  {
    name: 'SolutionDeliveryClaimed',
    type: 'event',
    inputs: [
      { name: 'operator', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: false },
    ],
  },
  // ── Task creation function (for claimWindowStart/End via createTask args) ─
  {
    name: 'createTask',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'taskCidDigest', type: 'bytes32' },
      { name: 'manifestDigest', type: 'bytes32' },
      {
        name: 'policy',
        type: 'tuple',
        components: [
          { name: 'claimWindowStart', type: 'uint64' },
          { name: 'claimWindowEnd', type: 'uint64' },
          { name: 'submissionDeadline', type: 'uint64' },
          { name: 'claimLeaseTtlSeconds', type: 'uint32' },
          { name: 'maxClaims', type: 'uint16' },
          { name: 'maxClaimsPerOperator', type: 'uint16' },
          { name: 'policyHook', type: 'address' },
          {
            name: 'evaluationPolicy',
            type: 'tuple',
            components: [
              { name: 'requiredVerdicts', type: 'uint16' },
              { name: 'passThreshold', type: 'uint16' },
              { name: 'evaluationDeadline', type: 'uint64' },
              { name: 'maxVerdictsPerEvaluator', type: 'uint16' },
              { name: 'disallowSolverSelfEvaluation', type: 'bool' },
            ],
          },
        ],
      },
      { name: 'solutionMaxDeliveryRate', type: 'uint256' },
      { name: 'verdictMaxDeliveryRate', type: 'uint256' },
      { name: 'responseTimeout', type: 'uint256' },
    ],
    outputs: [{ name: 'taskId', type: 'uint256' }],
  },
] as const;
