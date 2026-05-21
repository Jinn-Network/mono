import { keccak256, stringToHex } from 'viem';

export const TASK_CLAIM_EMITTER_ABI = [
  {
    type: 'event',
    name: 'ClaimTicket',
    anonymous: false,
    inputs: [
      { name: 'claimId', type: 'uint256', indexed: true },
      { name: 'serviceId', type: 'uint256', indexed: true },
      { name: 'taskCreationWeight', type: 'uint256', indexed: false },
      { name: 'solutionDeliveryWeight', type: 'uint256', indexed: false },
      { name: 'verdictDeliveryWeight', type: 'uint256', indexed: false },
      { name: 'multisig', type: 'address', indexed: true },
      { name: 'claimer', type: 'address', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'claimSnapshotHashes',
    stateMutability: 'view',
    inputs: [{ name: 'claimId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

export const MOCK_MESSENGER_ABI = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'fixtures',
    stateMutability: 'view',
    inputs: [{ name: 'claimId', type: 'uint256' }],
    outputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'taskCreationWeight', type: 'uint256' },
      { name: 'solutionDeliveryWeight', type: 'uint256' },
      { name: 'verdictDeliveryWeight', type: 'uint256' },
      { name: 'multisig', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'setFixture',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'claimId', type: 'uint256' },
      {
        name: 'f',
        type: 'tuple',
        components: [
          { name: 'serviceId', type: 'uint256' },
          { name: 'taskCreationWeight', type: 'uint256' },
          { name: 'solutionDeliveryWeight', type: 'uint256' },
          { name: 'verdictDeliveryWeight', type: 'uint256' },
          { name: 'multisig', type: 'address' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export const JINN_DISTRIBUTOR_ABI = [
  {
    type: 'function',
    name: 'messenger',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'operatorRatio',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'daoRatio',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'wTaskCreation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'wSolutionDelivery',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'wVerdictDelivery',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'wCreation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'wRestorationDelivery',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'wEvaluationDelivery',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalClaimedOperator',
    stateMutability: 'view',
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalClaimedDao',
    stateMutability: 'view',
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'proof', type: 'bytes' }],
    outputs: [],
  },
] as const;

export const CLAIM_TICKET_TOPIC0 = keccak256(
  stringToHex(
    'ClaimTicket(uint256,uint256,uint256,uint256,uint256,address,address)',
  ),
);
