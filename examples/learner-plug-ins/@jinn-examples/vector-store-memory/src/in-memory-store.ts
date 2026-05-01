// Deterministic in-memory vector store. Real builders swap for Pinecone,
// Weaviate, pgvector, FAISS-on-disk, etc. Embeddings here are a deterministic
// hash-bag — not real semantic embeddings, but stable enough for offline tests.
export interface VectorEntry {
  id: string;
  vector: readonly number[];
  metadata: Record<string, unknown>;
  createdAt: number;
}

const DIM = 16;

export function deterministicEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[i % DIM] += text.charCodeAt(i);
  }
  // L2 normalise
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export class InMemoryStore {
  private entries: VectorEntry[] = [];

  embed(
    id: string,
    text: string,
    metadata: Record<string, unknown> = {},
  ): VectorEntry {
    const entry: VectorEntry = {
      id,
      vector: deterministicEmbed(text),
      metadata,
      createdAt: Date.now(),
    };
    this.entries = this.entries.filter((e) => e.id !== id);
    this.entries.push(entry);
    return entry;
  }

  query(
    query: string,
    k: number,
  ): Array<{ id: string; score: number; metadata: Record<string, unknown> }> {
    const q = deterministicEmbed(query);
    return this.entries
      .map((e) => ({
        id: e.id,
        // dot product on L2-normalised = cosine similarity
        score: e.vector.reduce((s, x, i) => s + x * (q[i] ?? 0), 0),
        metadata: e.metadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.entries.length;
    // Strictly newer than cutoff survives; entries at-or-before cutoff are pruned.
    // With maxAgeMs=0 this prunes everything embedded in this ms or earlier.
    this.entries = this.entries.filter((e) => e.createdAt > cutoff);
    return before - this.entries.length;
  }

  size(): number {
    return this.entries.length;
  }
}
