#!/usr/bin/env tsx

import { getFileContents } from 'jinn-node/agent/mcp/tools/github_tools.js';
import { config } from 'dotenv';

config();

async function test() {
  console.log('Testing GitHub tools...\n');
  
  const result = await getFileContents({ 
    owner: 'oaksprout', 
    repo: 'jinn-gemini', 
    path: 'README.md' 
  });
  
  const data = JSON.parse(result.content[0].text);
  
  if (data.type === 'file') {
    console.log('✅ SUCCESS: GitHub tools work!');
    console.log(`   File: ${data.path}`);
    console.log(`   Size: ${data.size} bytes`);
    console.log(`   Content preview: ${data.content.substring(0, 100)}...`);
  } else if (data.error) {
    console.log('❌ FAILED:', data.error);
  }
}

test().catch(console.error);

