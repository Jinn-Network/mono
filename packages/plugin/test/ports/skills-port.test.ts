import { describeSkillsPortContract } from '../../src/testing/contract-kits.js';
import { InMemorySkillsPort } from '../../src/testing/in-memory-skills.js';

describeSkillsPortContract(() => new InMemorySkillsPort());
