import { describeCorpusPortContract } from '../../src/testing/contract-kits.js';
import { InMemoryCorpusPort } from '../../src/testing/in-memory-corpus.js';

describeCorpusPortContract(() => new InMemoryCorpusPort());
