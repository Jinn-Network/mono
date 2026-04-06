#!/usr/bin/env tsx
/**
 * Test search_similar_situations directly
 */

import { searchSimilarSituations } from 'jinn-node/agent/mcp/tools/search_similar_situations.js';

async function main() {
  console.log('🔍 Testing search_similar_situations...\n');
  
  const testQuery = 'OLAS staking contract gas optimization security';
  console.log(`Query: "${testQuery}"\n`);
  
  try {
    const result = await searchSimilarSituations({
      query_text: testQuery,
      k: 5
    });
    
    const response = JSON.parse(result.content[0].text);
    console.log('Response meta:', response.meta);
    console.log('Results count:', response.data?.length || 0);
    
    if (response.data && response.data.length > 0) {
      console.log('\n📊 Results:');
      response.data.forEach((match: any, idx: number) => {
        console.log(`\n${idx + 1}. ${match.nodeId}`);
        console.log(`   Score: ${(match.score * 100).toFixed(2)}%`);
        console.log(`   Summary: ${match.summary?.substring(0, 80)}...`);
      });
    } else {
      console.log('\n❌ No results found!');
    }
  } catch (error: any) {
    console.error(`\n❌ Error: ${error.message}`);
    console.error(error.stack);
  }
}

main();

