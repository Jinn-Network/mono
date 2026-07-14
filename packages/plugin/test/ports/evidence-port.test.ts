import { describeEvidencePortContract } from '../../src/testing/contract-kits.js';
import { InMemoryEvidencePort } from '../../src/testing/in-memory-evidence.js';
import { makeSampleEpisode } from '../_fixtures/episode.js';

describeEvidencePortContract(() => new InMemoryEvidencePort(), makeSampleEpisode());
