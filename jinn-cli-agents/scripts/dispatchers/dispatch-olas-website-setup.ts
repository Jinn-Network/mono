#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Dispatch script for Olas Website - Initial Project Setup
 * 
 * This script dispatches a job to set up the initial Next.js project structure
 * in the oaksprout/olas-website-1 repository.
 */

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

const objective = `Set up a modern Next.js website foundation for the Olas project in the oaksprout/olas-website-1 repository.`;

const context = `
You are setting up the initial project structure for the official Olas informational website.

**Blueprint Reference**: The complete blueprint for this website is located at \`blueprints/olas-website/\` in the jinn-cli-agents repository. Review it to understand:
- Constitutional principles (accuracy, community-centric, open, performant)
- Vision and mission
- Detailed requirements for content, UX/design, technical, and operations

**Repository**: oaksprout/olas-website-1 (external GitHub repository)

**Key Technical Requirements** (from TEC-001, TEC-002):
- Use Next.js with TypeScript and static export capability
- Implement component-based architecture with Tailwind CSS for styling
- Set up proper project structure: pages, components, content, public assets
- Configure for static site generation (SSG)
- Ensure type safety with TypeScript
- Set up development tooling (ESLint, Prettier, etc.)

**Performance Requirements** (from UXD-005, TEC-003):
- Configure for optimal performance (<2s FCP, <3s LCP targets)
- Set up code splitting and lazy loading foundations
- Optimize asset loading strategy
`;

const acceptanceCriteria = `
1. Next.js project is initialized with TypeScript and configured for static export
2. Tailwind CSS is configured and working
3. Basic project structure exists:
   - \`/pages\` or \`/app\` directory (depending on Next.js version)
   - \`/components\` for reusable UI components
   - \`/content\` for markdown content files
   - \`/public\` for static assets
   - \`/styles\` for global styles
4. Essential configuration files are in place:
   - \`next.config.js\` (or .ts) with static export config
   - \`tsconfig.json\` with appropriate settings
   - \`tailwind.config.js\` (or .ts)
   - \`.eslintrc.js\` (or .json)
   - \`.prettierrc\`
5. Package.json has necessary dependencies and scripts
6. README.md documents local development setup
7. A basic homepage renders successfully with placeholder content
8. Build command produces static HTML output
9. All code passes linting and type checking
10. Commit all changes with clear commit messages
`;

const deliverables = `
- Fully configured Next.js + TypeScript + Tailwind CSS project
- Basic project structure with organized directories
- Configuration files for build, linting, and formatting
- Documentation in README.md for developers
- Working dev server and build process
- Initial homepage that renders correctly
`;

const constraints = `
- Use latest stable versions of Next.js, TypeScript, and Tailwind CSS
- Follow the technical requirements specified in blueprints/olas-website/requirements/technical.md
- Configure for static export (SSG) - no server-side rendering required
- Use functional components with React hooks (no class components)
- Ensure all configuration follows Next.js and Tailwind best practices
`;

async function main() {
  console.log('Dispatching Olas Website Setup job...\n');

  try {
    const result = await dispatchNewJob({
      objective,
      context,
      acceptanceCriteria,
      jobName: 'olas-website-initial-setup',
      model: 'gemini-2.5-flash',
      enabledTools: [
        'get_file_contents',
        'search_code',
        'list_commits',
        'web_fetch'
      ],
      deliverables,
      constraints,
    });

    console.log('✅ Job dispatched successfully!\n');
    console.log('Request ID:', result.requestId);
    console.log('Transaction Hash:', result.txHash);
    if (result.ipfs_gateway_url) {
      console.log('IPFS URL:', result.ipfs_gateway_url);
    }
    console.log('\nThe agent will set up the Next.js project structure in the oaksprout/olas-website-1 repository.');
  } catch (error) {
    console.error('❌ Failed to dispatch job:', error);
    process.exit(1);
  }
}

main();

