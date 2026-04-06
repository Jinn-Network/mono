#!/usr/bin/env tsx
// @ts-nocheck
import 'dotenv/config';
import { createBlueprintBuilder } from 'jinn-node/worker/prompt/BlueprintBuilder.js';
import type { IpfsMetadata } from 'jinn-node/worker/types.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
    console.log('🏗️ Building Verification Prompt using BlueprintBuilder...\n');

    // 1. Create Builder with default providers
    const builder = createBlueprintBuilder({
        enableBeadsAssertions: true, // Ensure beads are enabled
        debug: true
    });

    // Mock Context Provider
    class MockContextProvider {
        name = 'mock-context';
        enabled() { return true; }
        async provide(ctx: any) {
            const children = ctx.metadata.additionalContext?.hierarchy || [];
            return {
                hierarchy: {
                    children,
                    totalJobs: children.length,
                    completedJobs: children.filter((c: any) => c.status === 'COMPLETED').length,
                    activeJobs: 0
                }
            };
        }
    }
    builder.registerContextProvider(new MockContextProvider());

    // 2. Mock Metadata reflecting a Verification Run
    // LOAD BLUEPRINT FROM FILE
    const blueprintPath = join(__dirname, '../../blueprints/local-arcade.json');
    const { readFileSync } = await import('fs');
    const blueprintJson = readFileSync(blueprintPath, 'utf8');

    // 2. Mock Metadata reflecting a Verification Run
    const metadata: IpfsMetadata = {
        jobName: 'simulate-verification',
        // The original job blueprint
        blueprint: blueprintJson, // Use real blueprint
        // Coding context (triggers Beads)
        codeMetadata: {
            repo: {
                remoteUrl: 'https://github.com/jinn-repos/local-arcade.git'
            },
            branch: {
                name: 'job/e2e-test-1',
                headCommit: 'e2e-test-hash',
                status: { isDirty: false }
            },
            baseBranch: 'main',
            jobDefinitionId: 'mock-job-def',
            capturedAt: new Date().toISOString()
        },
        // Verification Context
        additionalContext: {
            verificationRequired: true,
            verificationAttempt: 1,
            // Completed children context
            hierarchy: [
                {
                    requestId: 'mock-child-req-1',
                    jobName: 'Implement Snake Game',
                    status: 'COMPLETED',
                    branchName: 'feat/snake-game',
                    isIntegrated: true,
                    summary: 'Implemented Snake game.'
                },
                {
                    requestId: 'mock-child-req-2',
                    jobName: 'Implement 2048',
                    status: 'COMPLETED',
                    branchName: 'feat/2048',
                    isIntegrated: true,
                    summary: 'Implemented 2048.'
                }
            ] as any[] // Cast as any[] to avoid strict enum check since codebase uses 'COMPLETED'
        }
    };

    // 3. Build the Blueprint
    const requestId = 'mock-verification-request-id';
    const result = await builder.build(requestId, metadata);

    // 4. Output the Result
    console.log('✅ Blueprint Built Successfully!');
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log(JSON.stringify(result.blueprint, null, 2));
    console.log('═══════════════════════════════════════════════════════════════════════');

    // Also print brief analysis
    const assertionIds = result.blueprint.assertions.map(a => a.id);
    console.log('\n🔍 Validation - Injected Assertions:');
    if (assertionIds.includes('SYS-VERIFY-001')) console.log('  ✅ SYS-VERIFY-001 (Verification Directive) found');
    else console.log('  ❌ SYS-VERIFY-001 missing');

    if (assertionIds.includes('SYS-BEADS-001')) console.log('  ✅ SYS-BEADS-001 (Beads Instructions) found');
    else console.log('  ❌ SYS-BEADS-001 missing');

    if (assertionIds.includes('SYS-PARENT-ROLE-001')) console.log('  ✅ SYS-PARENT-ROLE-001 (Parent Role) found');
    else console.log('  ❌ SYS-PARENT-ROLE-001 missing');

    if (!assertionIds.includes('SYS-DELEGATE-001')) console.log('  ✅ SYS-DELEGATE-001 (Delegation) correctly suppressed');
    else console.log('  ❌ SYS-DELEGATE-001 found (should be suppressed)');
}

main().catch(console.error);
