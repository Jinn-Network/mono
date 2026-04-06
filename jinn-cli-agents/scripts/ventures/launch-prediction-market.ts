#!/usr/bin/env tsx
/**
 * Launch Prediction Market Fund Venture
 * 
 * Dispatches the initial job for the Prediction Market Fund venture.
 * Links the venture to the repository: https://github.com/ritsukai/prediction-market-fund
 * 
 * Usage:
 *   export CODE_METADATA_REPO_ROOT=/path/to/your/local/prediction-market-fund
 *   ./scripts/ventures/launch-prediction-market.ts
 */

import 'dotenv/config';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

async function loadBlueprint(filename: string): Promise<string> {
    const blueprintPath = join(process.cwd(), 'blueprints', filename);
    const content = await readFile(blueprintPath, 'utf-8');
    return content;
}

function parseDispatchResponse(result: any): { jobDefinitionId: string; requestId: string } {
    const response = JSON.parse(result.content[0].text);

    if (!response.meta?.ok) {
        throw new Error(`Dispatch failed: ${response.meta?.message}`);
    }

    const data = response.data;
    const requestId = Array.isArray(data.request_ids) ? data.request_ids[0] : data.request_id;
    const jobDefinitionId = data.jobDefinitionId;

    if (!jobDefinitionId) {
        throw new Error('No jobDefinitionId in response');
    }

    return { jobDefinitionId, requestId };
}

async function main() {
    console.log('╔═══════════════════════════════════════════════════════════════════════╗');
    console.log('║  🚀 Launching Prediction Market Fund Venture                         ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════╝');

    // Verify repo context is set
    if (!process.env.CODE_METADATA_REPO_ROOT) {
        console.warn('\n⚠️  WARNING: CODE_METADATA_REPO_ROOT is not set.');
        console.warn('   The agent will not know which repository to work on.');
        console.warn('   Please set it to your local clone of https://github.com/ritsukai/prediction-market-fund');
        console.warn('   Example: export CODE_METADATA_REPO_ROOT=../prediction-market-fund\n');
        // We don't exit here to allow testing, but in production this is critical
    } else {
        console.log(`\n📂 Linked Repository: ${process.env.CODE_METADATA_REPO_ROOT}`);
    }

    try {
        const blueprint = await loadBlueprint('prediction-market-fund.json');
        const message = process.argv[2];

        console.log('\n📋 Dispatching initial job...');
        if (message) {
            console.log(`   Message: "${message}"`);
        }

        const result = await dispatchNewJob({
            jobName: 'prediction-market-fund-initial',
            blueprint,
            message,
            model: 'gemini-2.5-pro',
            enabledTools: [
                'web_search',
                'create_artifact',
                'write_file', // Official Gemini CLI tool name
                'read_file',
                'replace', // Official Gemini CLI tool for editing files
                'list_directory',
                'run_shell_command', // Official Gemini CLI tool name for shell execution
                'dispatch_new_job' // Needed for delegation
            ],
            skipBranch: false, // We WANT a branch for this venture to start coding
        });

        const { jobDefinitionId, requestId } = parseDispatchResponse(result);

        console.log('✅ Venture launched successfully!\n');
        console.log('═══════════════════════════════════════════════════════════════════════');
        console.log(`   Job Definition ID: ${jobDefinitionId}`);
        console.log(`   Request ID: ${requestId}`);
        console.log('═══════════════════════════════════════════════════════════════════════');

        console.log('\n🔧 Next Steps:');
        console.log('\n1. Start the worker:');
        console.log(`   MECH_TARGET_REQUEST_ID=${requestId} yarn dev:mech --single`);

        console.log('\n2. Monitor the agent:');
        console.log(`   http://localhost:3000/requests/${requestId}`);

    } catch (error) {
        console.error('\n❌ Failed to launch venture:', error);
        process.exit(1);
    }
}

main();
