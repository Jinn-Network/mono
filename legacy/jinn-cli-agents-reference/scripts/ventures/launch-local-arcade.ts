#!/usr/bin/env tsx
/**
 * Launch Local Arcade Venture
 * 
 * Dispatches the initial job for the Local Arcade venture.
 * This venture creates a self-contained arcade with three classic games
 * (Snake, 2048, Minesweeper) that runs entirely offline.
 * 
 * Usage:
 *   ./scripts/ventures/launch-local-arcade.ts [options] [message]
 * 
 * Options:
 *   --repo <path>   Path to local repository clone (enables parallel workstreams)
 * 
 * Examples:
 *   # Use default repo from CODE_METADATA_REPO_ROOT
 *   ./scripts/ventures/launch-local-arcade.ts "First arcade"
 * 
 *   # Use specific repo path for parallel runs
 *   ./scripts/ventures/launch-local-arcade.ts --repo ~/jinn-repos/arcade-run-1 "First test"
 *   ./scripts/ventures/launch-local-arcade.ts --repo ~/jinn-repos/arcade-run-2 "Second test"
 */

import 'dotenv/config';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';

interface ParsedArgs {
    repoPath?: string;
    message?: string;
}

function parseArgs(args: string[]): ParsedArgs {
    const result: ParsedArgs = {};
    let i = 0;

    while (i < args.length) {
        if (args[i] === '--repo' && i + 1 < args.length) {
            result.repoPath = resolve(args[i + 1]);
            i += 2;
        } else if (!args[i].startsWith('--')) {
            result.message = args[i];
            i++;
        } else {
            i++;
        }
    }

    return result;
}

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
    console.log('║  🎮 Launching Local Arcade Venture                                    ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════╝');

    // Parse CLI arguments
    const { repoPath, message } = parseArgs(process.argv.slice(2));

    // Set repo path: CLI arg takes precedence over env var
    const effectiveRepoPath = repoPath || process.env.CODE_METADATA_REPO_ROOT;

    if (repoPath) {
        // Override env var if --repo was specified
        process.env.CODE_METADATA_REPO_ROOT = repoPath;
        console.log(`\n📂 Repository (from --repo): ${repoPath}`);
    } else if (process.env.CODE_METADATA_REPO_ROOT) {
        console.log(`\n📂 Repository (from env): ${process.env.CODE_METADATA_REPO_ROOT}`);
    } else {
        console.log('\n📂 No repository specified - agent will determine the output location');
    }

    try {
        const blueprint = await loadBlueprint('local-arcade.json');

        console.log('\n📋 Dispatching initial job...');
        if (message) {
            console.log(`   Message: "${message}"`);
        }

        const result = await dispatchNewJob({
            jobName: 'local-arcade-initial',
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
        if (effectiveRepoPath) {
            console.log(`   CODE_METADATA_REPO_ROOT=${effectiveRepoPath} \\`);
            console.log(`     yarn dev:mech --workstream=${requestId}`);
        } else {
            console.log(`   yarn dev:mech --workstream=${requestId}`);
        }

        console.log('\n2. Monitor the agent:');
        console.log(`   http://localhost:3000/requests/${requestId}`);

    } catch (error) {
        console.error('\n❌ Failed to launch venture:', error);
        process.exit(1);
    }
}

main();

