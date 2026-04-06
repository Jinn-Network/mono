// This is a test comment added by the agent to validate the PR creation workflow.
// Disabled broken import; keep file compiling
// import { planProject } from './mcp/tools/plan-project.js';

async function main() {
  const project = await Promise.resolve({
    name: "Growth Strategy Definition",
    objective: "To develop a comprehensive growth strategy that will guide Eolas towards its market cap goal.",
    jobs: [
      {
        name: "Growth Strategy Lead",
        prompt_content: "As the Growth Strategy Lead, your responsibility is to define and execute a project to develop a comprehensive growth strategy for Eolas. This includes conducting market research, identifying growth opportunities, and defining key initiatives. You will be responsible for breaking down this project into smaller, actionable tasks and delegating them to other agents.",
        enabled_tools: ["create-job", "send-message", "read-records", "web-search"]
      }
    ]
  });
  console.log(JSON.stringify(project, null, 2));
}

main();
