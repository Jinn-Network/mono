/**
 * JinnRouter ABI slice — only the events and function surfaces that the
 * indexer needs. Sourced from operator/src/adapters/mech/types.ts.
 *
 * NOTE: the V3 JinnRouter (task-coordinator-router-v3) is the current
 * testnet contract. The mainnet deployment uses the same event signatures.
 * TaskFinalized does not exist as a standalone event. The current tokenless
 * router finalizes in TaskCoordinator.recordVerdict on the first delivered
 * verdict when TaskCreated omits requiredVerdicts. `TaskBudgetRefunded` *does*
 * exist and is now indexed -> `Task.refunded`. `VerdictDeliveryClaimed` carries
 * the per-verdict outcome (`verdictCode`: 0=None, 1=Pass, 2=Fail, 3=Invalid,
 * 4=Unresolved). The Task.finalized schema column starts as false and is
 * updated by the VerdictDeliveryClaimed handler. See README.md
 * §Schema-version policy for the limitation note.
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
      // Tokenless-OLAS pivot (DR-2026-06-30): trimmed TaskCreated emits maxClaims
      // as uint32 and no longer emits requiredVerdicts (the recorder finalizes on
      // the first verdict — loop completion — not on a required-verdict count).
      { name: 'maxClaims', type: 'uint32', indexed: false },
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
  // ── Solution delivery (marks delivery / starts evaluation; not final) ─────
  // VerdictDeliveryClaimed finalizes after verdict delivery.
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
  // ── Verdict delivery (verdict outcome — VerdictCode {None,Pass,Fail,Invalid,Unresolved}) ──
  {
    type: 'event',
    name: 'VerdictDeliveryClaimed',
    inputs: [
      { name: 'evaluator', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: false },
      { name: 'verdictIndex', type: 'uint32', indexed: false },
      { name: 'verdictCode', type: 'uint8', indexed: false },
    ],
  },
  // ── Task budget refund (creator's unspent solution/verdict budget returned) ──
  {
    type: 'event',
    name: 'TaskBudgetRefunded',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'solutionAmount', type: 'uint256', indexed: false },
      { name: 'verdictAmount', type: 'uint256', indexed: false },
    ],
  },
  // ── Task creation function (for claimWindowStart/End via createTask args) ─
  {
    name: 'taskCoordinator',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
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
