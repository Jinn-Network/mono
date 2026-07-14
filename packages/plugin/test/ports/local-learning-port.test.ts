import { describeLocalLearningPortContract } from '../../src/testing/contract-kits.js';
import { InMemoryLocalLearningPort } from '../../src/testing/in-memory-local-learning.js';

describeLocalLearningPortContract(() => new InMemoryLocalLearningPort());
