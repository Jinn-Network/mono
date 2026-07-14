// packages/plugin/src/testing.ts
// ./testing subpath entry — in-memory adapters + contract kits (S1-F1).
export { InMemoryCorpusPort } from './testing/in-memory-corpus.js';
export { InMemoryEvidencePort } from './testing/in-memory-evidence.js';
export { InMemoryContributionPort } from './testing/in-memory-contribution.js';
export { InMemoryLocalLearningPort } from './testing/in-memory-local-learning.js';
export { InMemorySkillsPort } from './testing/in-memory-skills.js';
export {
  describeCorpusPortContract,
  describeEvidencePortContract,
  describeContributionPortContract,
  describeLocalLearningPortContract,
  describeSkillsPortContract,
} from './testing/contract-kits.js';
