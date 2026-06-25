const fs = require('node:fs');

const path = process.env.JINN_CODEX_ADAPTER_PATCH_TARGET ||
  '/app/dist/harnesses/impls/learner/adapters/codex-code.js';

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`[patch-codex-session-start-context] expected ${label} not found`);
  }
  return source.replace(before, after);
}

let source = fs.readFileSync(path, 'utf8');

const hasBridge = source.includes('function sessionStartContextFromHookStdout') &&
  source.includes('JINN_HARNESS_MODE: inputs.mode ??');
if (hasBridge) {
  source = source.replace(
    "const hook = spawnSync('bash', [join(pluginRoot, 'hooks', 'session-start')], {",
    "const hook = spawnSync('/bin/bash', [join(pluginRoot, 'hooks', 'session-start')], {",
  );
  fs.writeFileSync(path, source);
  console.log('[patch-codex-session-start-context] already present');
  process.exit(0);
}

source = replaceOnce(
  source,
  'function buildInitialPrompt(inputs) {',
  'function buildInitialPrompt(inputs, sessionStartContext = \'\') {',
  'buildInitialPrompt signature',
);

source = replaceOnce(
  source,
  "        `- mode = ${inputs.mode}`,\n        inputs.taskBody",
  "        `- mode = ${inputs.mode}`,\n        sessionStartContext.trim()\n            ? `\\nSession start context:\\n${sessionStartContext.trim()}`\n            : '',\n        inputs.taskBody",
  'session-start context prompt insertion point',
);

source = replaceOnce(
  source,
  "function captureLogError(err) {\n    return err instanceof Error ? err : new Error(String(err));\n}\n",
  `function captureLogError(err) {
    return err instanceof Error ? err : new Error(String(err));
}
function sessionStartContextFromHookStdout(stdout) {
    for (const line of stdout.split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean)) {
        try {
            const parsed = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                continue;
            const hookSpecificOutput = parsed['hookSpecificOutput'];
            if (!hookSpecificOutput || typeof hookSpecificOutput !== 'object' || Array.isArray(hookSpecificOutput)) {
                continue;
            }
            const record = hookSpecificOutput;
            if (record['hookEventName'] !== 'SessionStart')
                continue;
            const additionalContext = record['additionalContext'];
            if (typeof additionalContext === 'string' && additionalContext.trim()) {
                return additionalContext.trim();
            }
        }
        catch {
        }
    }
    return '';
}
`,
  'session-start context parser insertion point',
);

source = replaceOnce(
  source,
  "    async runTask(inputs, pluginRoot) {\n        const prompt = buildInitialPrompt(inputs);\n        const baseEnv = {",
  "    async runTask(inputs, pluginRoot) {\n        const baseEnv = {",
  'prompt construction before baseEnv',
);

source = replaceOnce(
  source,
  '            IMPL_STATE_DIR: inputs.implStateDir,\n            WORKING_DIR: inputs.workingDir,',
  '            IMPL_STATE_DIR: inputs.implStateDir,\n            JINN_HARNESS_MODE: inputs.mode ?? \'train\',\n            WORKING_DIR: inputs.workingDir,',
  'JINN_HARNESS_MODE env insertion point',
);

source = replaceOnce(
  source,
  '        const env = buildAgentEnv(baseEnv);\n        if (this.runSessionStartHook) {',
  '        const env = buildAgentEnv(baseEnv);\n        let sessionStartContext = \'\';\n        if (this.runSessionStartHook) {',
  'sessionStartContext local insertion point',
);

source = replaceOnce(
  source,
  "            if (hook.status !== 0) {\n                throw new Error(`codex-code adapter: session-start hook failed: ${(hook.stderr || hook.stdout || '').slice(0, 500)}`);\n            }\n        }\n        const prepared = prepareCodexPluginWorkspace({",
  "            if (hook.status !== 0) {\n                const detail = hook.stderr || hook.stdout || hook.error?.message || '';\n                throw new Error(`codex-code adapter: session-start hook failed: ${detail.slice(0, 500)}`);\n            }\n            sessionStartContext = sessionStartContextFromHookStdout(hook.stdout?.toString() ?? '');\n        }\n        const prompt = buildInitialPrompt(inputs, sessionStartContext);\n        const prepared = prepareCodexPluginWorkspace({",
  'hook output capture insertion point',
);

source = replaceOnce(
  source,
  "const hook = spawnSync('bash', [join(pluginRoot, 'hooks', 'session-start')], {",
  "const hook = spawnSync('/bin/bash', [join(pluginRoot, 'hooks', 'session-start')], {",
  'absolute session-start shell',
);

fs.writeFileSync(path, source);
console.log('[patch-codex-session-start-context] installed SessionStart additionalContext bridge');
