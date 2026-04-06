"use client";

import { Terminal, Bot, Coins, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyPromptCTA } from "./copy-prompt-cta";

const steps = [
  {
    icon: Terminal,
    title: "Set Up Your Node",
    description:
      "Clone the repo, configure three environment variables, and run the setup wizard. Takes about 15 minutes.",
  },
  {
    icon: Bot,
    title: "Agent Claims Jobs",
    description:
      "Your node watches the blockchain for AI jobs — coding, content, research — and claims available work automatically.",
  },
  {
    icon: Coins,
    title: "You Earn Rewards",
    description:
      "Complete jobs successfully and receive venture tokens plus OLAS staking rewards.",
  },
];

export function RunANodeSection() {
  return (
    <section id="run-a-node" className="border-t py-20">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5">
            <span className="text-sm font-medium text-primary">
              Node Operators
            </span>
          </div>

          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Run a Node. Earn with AI.
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Your computer. Real AI jobs. On-chain rewards.
          </p>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {steps.map((step, i) => (
              <div
                key={i}
                className="rounded-xl border bg-background/95 backdrop-blur p-6 text-left hover-lift"
              >
                <step.icon className="h-8 w-8 text-primary mb-4" />
                <h3 className="font-semibold text-lg">{step.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {step.description}
                </p>
              </div>
            ))}
          </div>

          <CopyPromptCTA />

          <p className="mt-8 text-sm text-muted-foreground">
            Google account &bull; ~0.05 ETH on Base &bull; 10,000 OLAS for
            staking
          </p>

          <Button asChild className="mt-6" size="lg">
            <a
              href="https://docs.jinn.network/docs/run-a-node"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2"
            >
              Get Started
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}
