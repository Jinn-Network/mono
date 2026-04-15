#!/usr/bin/env tsx
import 'dotenv/config';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { getMechAddress, getMechChainConfig, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';
import { randomUUID } from 'node:crypto';
import { collectLocalCodeMetadata } from 'jinn-node/agent/shared/code_metadata.js';

// Configuration
const REPO_ROOT = process.env.CODE_METADATA_REPO_ROOT || '/Users/adrianobradley/jinn-repos/local-arcade';
const BRANCH_NAME = process.env.BRANCH_NAME || 'e2e-test-1';
const BASE_BRANCH = process.env.BASE_BRANCH || 'main'; // or develop
const MODEL = 'gemini-2.5-pro';

async function main() {
    console.log('🧪 Simulating Verification Job...');
    console.log(`📂 Repo: ${REPO_ROOT}`);
    console.log(`🌿 Branch: ${BRANCH_NAME}`);

    // 1. Setup Mech/Chain
    const mechAddress = getMechAddress();
    const chainConfig = getMechChainConfig();
    const privateKey = getServicePrivateKey();

    if (!mechAddress || !privateKey) {
        throw new Error('Missing mech address or private key in .operate config');
    }

    // 2. Prepare Code Metadata
    console.log('📦 Collecting code metadata...');
    // We assume the branch already exists and has the code we want to verify.
    // We mock the metadata collection slightly to force it to point to this existing branch.
    // In a real dispatch, ensureJobBranch would verify/create it.
    // Here we assume it exists as "precompleted".

    // We construct CodeMetadata manually to ensure it points exactly where we want
    // This mimics result of collectLocalCodeMetadata for an existing branch
    const codeMetadata = {
        repo: {
            root: REPO_ROOT,
            // remoteUrl: '...' // Optional if local path works
        },
        branchName: BRANCH_NAME,
        baseBranch: BASE_BRANCH
    };

    // 3. Prepare Verification Blueprint
    const blueprint = JSON.stringify({
        assertions: [
            {
                id: "JOB-VERIFY-APP",
                assertion: "Verify that the application is running specifically on the configured port and the UI is interactive.",
                examples: {
                    do: [
                        "Use `browser_automation` to navigate to the localhost URL",
                        "Take screenshots of the landing page",
                        "Click on interactive elements (buttons, links) to verify responsiveness"
                    ],
                    dont: [
                        "Assume it works safely by just checking the file system",
                        "Skip UI interaction"
                    ]
                },
                commentary: "We need to ensure the merged code actually runs and displays the UI correctly."
            }
        ]
    });

    // 4. Construct IPFS Payload with Verification Context
    const jobDefinitionId = randomUUID();
    const ipfsJsonContents = [{
        blueprint,
        jobName: 'simulate-verification-ui',
        model: MODEL,
        enabledTools: [
            'browser_automation', // The key tool we want to test
            'run_shell_command',
            'read_file',
            'write_file',
            'list_directory',
            'npm_run_script' // If needed to start the app
        ],
        jobDefinitionId,
        nonce: randomUUID(),
        // INJECT VERIFICATION CONTEXT HERE
        additionalContext: {
            verificationRequired: true,
            verificationAttempt: 1,
            // Mock hierarchy to trigger "Parent Role" context (optional but realistic)
            hierarchy: [
                {
                    requestId: 'mock-child-req-1',
                    jobName: 'Implement Snake Game',
                    status: 'COMPLETED',
                    branchName: 'feat/snake-game', // Already merged
                    isIntegrated: true
                },
                {
                    requestId: 'mock-child-req-2',
                    jobName: 'Implement 2048',
                    status: 'COMPLETED',
                    branchName: 'feat/2048', // Already merged
                    isIntegrated: true
                }
            ]
        },
        codeMetadata
    }];

    // 5. Dispatch
    console.log('🚀 Dispatching to marketplace...');
    const result = await marketplaceInteract({
        prompts: [blueprint], // Legacy field, actual blueprint in ipfsJsonContents
        priorityMech: mechAddress,
        tools: ipfsJsonContents[0].enabledTools,
        ipfsJsonContents,
        chainConfig,
        keyConfig: { source: 'value', value: privateKey },
        postOnly: true,
        responseTimeout: 61,
    });

    if (result && result.request_ids && result.request_ids.length > 0) {
        const requestId = result.request_ids[0];
        console.log('✅ Dispatch successful!');
        console.log(`🆔 Request ID: ${requestId}`);
        console.log(`🆔 Job Definition ID: ${jobDefinitionId}`);
        console.log('\nRun the worker to process this verification job:');
        console.log(`MECH_TARGET_REQUEST_ID=${requestId} yarn dev:mech --single`);
    } else {
        console.error('❌ Dispatch failed (no request ID returned)');
        console.log(JSON.stringify(result, null, 2));
    }
}

main().catch(console.error);
