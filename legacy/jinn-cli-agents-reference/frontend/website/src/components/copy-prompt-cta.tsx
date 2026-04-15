"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

const OPENCLAW_PROMPT =
  "Run `npx clawhub install jinn-node` to install the jinn-node skill, then run /jinn-node to set up a Jinn worker node";

const CODING_AGENT_PROMPT =
  "Clone https://github.com/Jinn-Network/jinn-node.git then read AGENTS.md and help me set up a Jinn node";

function CopyablePrompt({
  label,
  prompt,
}: {
  label: string;
  prompt: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium text-muted-foreground">{label}</p>
      <button
        onClick={handleCopy}
        className="group w-full rounded-lg border border-primary/30 bg-muted/20 p-4 font-mono text-sm flex items-center justify-between gap-3 transition-colors hover:border-primary/50 hover:bg-muted/30 cursor-pointer text-left"
      >
        <span className="flex-1 text-foreground/90">{prompt}</span>
        <span className="flex-shrink-0 text-muted-foreground group-hover:text-primary transition-colors">
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </span>
      </button>
      {copied && (
        <p className="mt-1 text-xs text-green-500 text-center">
          Copied to clipboard
        </p>
      )}
    </div>
  );
}

export function CopyPromptCTA() {
  return (
    <div className="mt-10 w-full max-w-2xl mx-auto space-y-4">
      <CopyablePrompt label="OpenClaw agent" prompt={OPENCLAW_PROMPT} />
      <CopyablePrompt
        label="Any coding agent (Claude Code, Cursor, Windsurf, etc.)"
        prompt={CODING_AGENT_PROMPT}
      />
      <p className="text-sm text-muted-foreground text-center">
        Or follow the{" "}
        <a
          href="https://docs.jinn.network/docs/run-a-node"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          manual setup guide
        </a>
      </p>
    </div>
  );
}
