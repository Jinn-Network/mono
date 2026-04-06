/**
 * Test pagination upstreamLimit fix for JINN-248
 * 
 * Verifies that composeSinglePageResponse correctly returns has_more=false
 * when offset reaches database limit, preventing false pagination signals.
 */

import { describe, it, expect } from 'vitest';
import { composeSinglePageResponse, encodeCursor } from 'jinn-node/agent/mcp/tools/shared/context-management.js';

describe('pagination upstreamLimit fix', () => {
  it('returns has_more=false when offset reaches upstreamLimit', () => {
    // Simulate database returning 100 items (its hard limit)
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
      name: `Item ${i}`,
      content: 'x'.repeat(100), // 100 chars each
    }));

    // Client-side token budget can only fit ~5 items
    const result = composeSinglePageResponse(items, {
      startOffset: 95, // Near end of database page
      pageTokenBudget: 2000, // Small budget
      upstreamLimit: 100, // Database hard limit
      truncateChars: 100,
    });

    // Should return items 95-99 (5 items fit in budget)
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.length).toBeLessThanOrEqual(5);
    
    // Key assertion: has_more should be FALSE because offset >= upstreamLimit
    // Without fix, this would be TRUE (misleading agent to paginate)
    expect(result.meta.has_more).toBe(false);
    expect(result.meta.next_cursor).toBeUndefined();
  });

  it('returns has_more=true when offset < upstreamLimit and items remain', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
      content: 'x'.repeat(100),
    }));

    const result = composeSinglePageResponse(items, {
      startOffset: 0,
      pageTokenBudget: 2000, // Only fits ~5 items
      upstreamLimit: 100,
      truncateChars: 100,
    });

    // Should return first ~5 items
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.length).toBeLessThan(100);
    
    // has_more should be TRUE because offset < upstreamLimit
    expect(result.meta.has_more).toBe(true);
    expect(result.meta.next_cursor).toBeDefined();
  });

  it('returns has_more=false when all items fit in budget (no upstreamLimit)', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `item-${i}`,
      content: 'small',
    }));

    const result = composeSinglePageResponse(items, {
      startOffset: 0,
      pageTokenBudget: 50000, // Large budget - fits all items
      truncateChars: 100,
      // No upstreamLimit set
    });

    expect(result.data.length).toBe(10);
    expect(result.meta.has_more).toBe(false);
    expect(result.meta.next_cursor).toBeUndefined();
  });

  it('prevents pagination loop scenario: offset=5, upstreamLimit=100, budget exhausted', () => {
    // Simulate agent receiving cursor for offset=5 after first page
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
      content: 'x'.repeat(200),
    }));

    // First call: offset=0
    const page1 = composeSinglePageResponse(items, {
      startOffset: 0,
      pageTokenBudget: 3000,
      upstreamLimit: 100,
      truncateChars: 200,
    });

    expect(page1.meta.has_more).toBe(true);
    expect(page1.meta.next_cursor).toBeDefined();

    // Second call: offset=5 (from cursor)
    const page2 = composeSinglePageResponse(items, {
      startOffset: 5,
      pageTokenBudget: 3000,
      upstreamLimit: 100,
      truncateChars: 200,
    });

    // Should still show has_more because offset=10 < upstreamLimit=100
    expect(page2.meta.has_more).toBe(true);
    
    // Eventually reaches database limit...
    const page20 = composeSinglePageResponse(items, {
      startOffset: 95,
      pageTokenBudget: 3000,
      upstreamLimit: 100,
      truncateChars: 200,
    });

    // NOW has_more should be false (offset >= upstreamLimit)
    expect(page20.meta.has_more).toBe(false);
    expect(page20.meta.next_cursor).toBeUndefined();
  });

  it('handles exact boundary: offset=100, upstreamLimit=100', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
    }));

    const result = composeSinglePageResponse(items, {
      startOffset: 100, // Exactly at limit
      pageTokenBudget: 10000,
      upstreamLimit: 100,
    });

    // No items returned (offset beyond array)
    expect(result.data.length).toBe(0);
    
    // has_more should be FALSE (offset >= upstreamLimit)
    expect(result.meta.has_more).toBe(false);
    expect(result.meta.next_cursor).toBeUndefined();
  });

  it('upstreamLimit does not affect pagination when undefined', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `item-${i}`,
      content: 'x'.repeat(200),
    }));

    const result = composeSinglePageResponse(items, {
      startOffset: 10,
      pageTokenBudget: 3000,
      truncateChars: 200,
      // upstreamLimit: undefined (not set)
    });

    // Key assertion: When upstreamLimit is not set, pagination works normally
    // based only on items.length, not limited by upstreamLimit
    const itemsReturned = result.data.length;
    expect(itemsReturned).toBeGreaterThan(0);
    expect(result.meta.has_more).toBe(true); // 10 + itemsReturned < 200 (more items exist)
    expect(result.meta.next_cursor).toBeDefined();
    
    // If upstreamLimit WERE set to 100, this would return false at offset > 100
    // But without it, pagination continues until items.length is exhausted
  });
});

