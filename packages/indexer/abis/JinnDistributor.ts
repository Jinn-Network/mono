/**
 * JinnDistributor ABI slice — only the `Claimed` event the indexer needs.
 * Sourced from contracts/src/jinn/distribution/JinnDistributor.sol and
 * cross-checked against client/src/earning/contracts.ts (JINN_DISTRIBUTOR_ABI).
 *
 * JinnDistributor lives on Sepolia L1 (chain 11155111) — the JINN DAO chain —
 * NOT on Base. It distributes JINN across three weighted channels
 * (wCreation / wRestorationDelivery / wEvaluationDelivery); the per-channel split
 * is computed inside claim() and is NOT in the event — the indexer reconstructs
 * it from per-operator JinnRouter activity counts. The Claimed event carries the
 * cumulative entitlement and this-claim's minted delta.
 */
export const JINN_DISTRIBUTOR_ABI = [
  {
    type: 'event',
    name: 'Claimed',
    inputs: [
      { name: 'serviceId', type: 'uint256', indexed: true },
      { name: 'multisig', type: 'address', indexed: true },
      { name: 'operatorMinted', type: 'uint256', indexed: false },
      { name: 'daoMinted', type: 'uint256', indexed: false },
      { name: 'totalEntitledOperator', type: 'uint256', indexed: false },
      { name: 'totalEntitledDao', type: 'uint256', indexed: false },
    ],
  },
] as const;
