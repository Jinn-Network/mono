import { describeContributionPortContract } from '../../src/testing/contract-kits.js';
import { InMemoryContributionPort } from '../../src/testing/in-memory-contribution.js';

describeContributionPortContract(() => new InMemoryContributionPort());
