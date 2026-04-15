#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Upload Olas Website Blueprint to IPFS
 * 
 * Uploads the entire blueprints/olas-website/ directory to IPFS
 * and returns the CID for reference in the root job.
 */

import { pushMetadataToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

interface BlueprintFile {
  path: string;
  content: string;
}

async function collectBlueprintFiles(dir: string, baseDir: string = dir): Promise<BlueprintFile[]> {
  const files: BlueprintFile[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    
    if (entry.isDirectory()) {
      const subFiles = await collectBlueprintFiles(fullPath, baseDir);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = await readFile(fullPath, 'utf-8');
      const relativePath = fullPath.substring(baseDir.length + 1);
      files.push({ path: relativePath, content });
    }
  }

  return files;
}

async function main() {
  console.log('📦 Uploading Olas Website Blueprint to IPFS...\n');

  const blueprintDir = join(process.cwd(), 'blueprints', 'olas-website');
  
  try {
    // Collect all markdown files
    const files = await collectBlueprintFiles(blueprintDir);
    console.log(`Found ${files.length} blueprint files:`);
    files.forEach(f => console.log(`  - ${f.path}`));
    
    // Create a structured blueprint manifest
    const blueprint = {
      version: '1.0',
      name: 'olas-website',
      repository: 'https://github.com/oaksprout/olas-website-1',
      files: files.reduce((acc, f) => {
        acc[f.path] = f.content;
        return acc;
      }, {} as Record<string, string>),
    };

    // Upload to IPFS
    console.log('\n📤 Uploading to IPFS...');
    const ipfsHashRaw = await pushMetadataToIpfs(JSON.stringify(blueprint, null, 2));
    
    // Extract CIDv1 from the comma-separated response (format: "0xhex,cidv1")
    const ipfsHash = ipfsHashRaw.includes(',') ? ipfsHashRaw.split(',')[1] : ipfsHashRaw;
    const gatewayUrl = `https://gateway.autonolas.tech/ipfs/${ipfsHash}`;

    console.log('\n✅ Blueprint uploaded successfully!\n');
    console.log(`IPFS Hash: ${ipfsHash}`);
    console.log(`Gateway URL: ${gatewayUrl}`);
    console.log('\nUse this URL in the root job context to reference the blueprint.');

    return { ipfsHash, gatewayUrl };
  } catch (error) {
    console.error('❌ Failed to upload blueprint:', error);
    process.exit(1);
  }
}

main();

