import type { PortResult } from '../outcome.js';
import type { KnowledgeHit } from '../schemas/knowledge-hit.js';

export interface CorpusPort {
  search(query: string): Promise<PortResult<KnowledgeHit[]>>;
  get(ref: string): Promise<PortResult<KnowledgeHit | null>>;
}
