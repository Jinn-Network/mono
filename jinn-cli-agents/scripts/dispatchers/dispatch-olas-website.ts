#!/usr/bin/env tsx
/**
 * Dispatch script for Olas Website Venture
 * 
 * This is the canonical root job for the Olas website venture. The job's 
 * objective is simple: ensure the oaksprout/olas-website-1 repository 
 * fulfills all assertions in the blueprint.
 * 
 * The blueprint is uploaded to IPFS and referenced in the job metadata.
 */

import 'dotenv/config';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { pushMetadataToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

// Target repository for the venture
const TARGET_REPO_URL = 'https://github.com/ritsukai/olas-website-1';
const TARGET_REPO_NAME = 'olas-website-1';

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

async function uploadBlueprint(): Promise<{ ipfsHash: string; gatewayUrl: string }> {
  console.log('📦 Uploading blueprint to IPFS...');
  
  const blueprintDir = join(process.cwd(), 'blueprints', 'olas-website');
  const files = await collectBlueprintFiles(blueprintDir);
  
  const blueprint = {
    version: '1.0',
    name: 'olas-website',
    repository: TARGET_REPO_URL,
    files: files.reduce((acc, f) => {
      acc[f.path] = f.content;
      return acc;
    }, {} as Record<string, string>),
  };

  const ipfsHashRaw = await pushMetadataToIpfs(JSON.stringify(blueprint, null, 2), 'blueprint');
  
  // Extract CIDv1 from the comma-separated response (format: "0xhex,cidv1")
  const ipfsHashStr = String(ipfsHashRaw);
  const ipfsHash = ipfsHashStr.includes(',') ? ipfsHashStr.split(',')[1].trim() : ipfsHashStr.trim();
  const gatewayUrl = `https://gateway.autonolas.tech/ipfs/${ipfsHash}`;
  
  console.log(`✅ Blueprint uploaded: ${gatewayUrl}\n`);
  console.log(`   CID: ${ipfsHash}\n`);
  return { ipfsHash, gatewayUrl };
}

const objective = `Ensure the ${TARGET_REPO_URL.replace('https://github.com/', '')} repository fulfills all assertions defined in the blueprint.`;

function buildContext(blueprintCid: string): string {
  const repoShortName = TARGET_REPO_URL.replace('https://github.com/', '');
  return `
You are the root job for this venture.

**Your Blueprint**: Available at https://gateway.autonolas.tech/ipfs/${blueprintCid}
- The blueprint is a JSON object containing all markdown documents
- Constitution: Core immutable principles (accuracy, community-centric, open, performant)
- Vision: Mission and strategic goals
- Requirements: Verifiable assertions for content, UX/design, technical, and operations

**Target Repository**: ${repoShortName} (external GitHub repository)

**Your Responsibility**: 
1. Fetch the blueprint from IPFS using web_fetch
2. Verify the current state of the repository against every assertion in the blueprint
3. Where assertions fail or are not yet addressed, dispatch jobs to bring the implementation into alignment

The blueprint uses a structured format:
- **Assertion**: A clear, verifiable statement
- **Examples**: Do/Don't guidance in table format
- **Commentary**: Context and rationale

Each requirement has a unique ID (e.g., CON-001, UXD-002, TEC-003, OPS-001) for tracking.
`;
}

const acceptanceCriteria = `
The venture reaches a successful state when:
1. All constitutional principles are upheld in the implementation
2. The vision is being actively pursued through the work
3. All requirement assertions are either:
   - Fully satisfied (implementation matches assertion)
   - In progress (child jobs dispatched to address them)
   - Documented as deferred with rationale
`;

const deliverables = `
- Child jobs dispatched to fulfill unmet venture requirements
`;

const constraints = ``;

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let model = 'gemini-2.5-flash'; // Default model
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1];
      i++;
      break;
    }
  }
  
  console.log('Dispatching Olas Website Venture (Root Job)...\n');
  console.log(`Target Repository: ${TARGET_REPO_URL}\n`);
  console.log(`Model: ${model}\n`);

  // Ensure CODE_METADATA_REPO_ROOT points to the target repository
  const workspaceDir = process.env.JINN_WORKSPACE_DIR || `${process.env.HOME}/jinn-repos`;
  const targetRepoPath = `${workspaceDir}/${TARGET_REPO_NAME}`;
  
  if (!process.env.CODE_METADATA_REPO_ROOT) {
    process.env.CODE_METADATA_REPO_ROOT = targetRepoPath;
    console.log(`Set CODE_METADATA_REPO_ROOT to: ${targetRepoPath}`);
    console.log('(This ensures code metadata is collected from the target repository)\n');
  } else {
    console.log(`Using CODE_METADATA_REPO_ROOT: ${process.env.CODE_METADATA_REPO_ROOT}\n`);
  }

  try {
    // Upload blueprint to IPFS first
    const { ipfsHash, gatewayUrl } = await uploadBlueprint();
    
    const result = await dispatchNewJob({
      objective,
      context: buildContext(ipfsHash),
      acceptanceCriteria,
      jobName: 'olas-website-venture',
      model: model,
      enabledTools: [
        'web_fetch',
        'get_file_contents',
        'search_code',
        'list_commits',
        'dispatch_new_job',
        'dispatch_existing_job',
        'create_artifact'
      ],
      deliverables,
      constraints,
    });

    // Parse the MCP tool response
    const response = JSON.parse(result.content[0].text);
    
    if (!response.meta?.ok) {
      console.error('❌ Dispatch failed:', response.meta?.message);
      process.exit(1);
    }
    
    const data = response.data;
    const requestId = Array.isArray(data.request_ids) ? data.request_ids[0] : data.request_id;
    
    console.log('✅ Root job dispatched successfully!\n');
    console.log('Blueprint IPFS:', `https://gateway.autonolas.tech/ipfs/${ipfsHash}`);
    console.log('Request ID:', requestId);
    console.log('Transaction Hash:', data.transaction_hash || data.txHash);
    if (data.ipfs_gateway_url) {
      console.log('Job Metadata IPFS:', data.ipfs_gateway_url);
    }
    console.log('\nRun the worker with:');
    console.log(`  MECH_TARGET_REQUEST_ID=${requestId} yarn dev:mech:single --single`);
    console.log(`\nOr to run all jobs in the workstream (single-job mode):`);
    console.log(`  yarn dev:mech:pretty --workstream=${requestId} --single`);
    console.log('\nThe venture will continuously ensure the Olas website fulfills its blueprint.');
    console.log('Check launcher_briefing artifacts for status updates.');
  } catch (error) {
    console.error('❌ Failed to dispatch job:', error);
    process.exit(1);
  }
}

main();

