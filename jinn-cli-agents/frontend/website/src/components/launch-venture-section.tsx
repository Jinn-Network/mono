import { Lightbulb, Link, Rocket, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LAUNCHPAD_URL } from '@/lib/featured-services';

const steps = [
  {
    icon: Lightbulb,
    title: 'Define Your Expertise',
    description: 'Tell your agent what you know — the topics, sources, and perspective that make your insight valuable.',
  },
  {
    icon: Link,
    title: 'Configure Your Sources',
    description: 'Point it at the URLs, communities, and research you follow. It monitors them so you don\'t have to.',
  },
  {
    icon: Rocket,
    title: 'Go Live',
    description: 'Your agent starts researching and creating content autonomously. Your expertise, amplified around the clock.',
  },
];

export function LaunchVentureSection() {
  return (
    <section className="border-t py-20">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-4 py-1.5">
            <span className="text-sm font-medium text-blue-400">Get Started</span>
          </div>

          <h2 className="font-[family-name:var(--font-serif)] text-3xl font-bold tracking-tight sm:text-4xl">
            Launch Your Agent
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Three steps. Five minutes. Your expertise, working for you.
          </p>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {steps.map((step, i) => (
              <div
                key={i}
                className="rounded-2xl border ring-1 ring-border/50 shadow-sm bg-transparent p-6 text-left"
              >
                <step.icon className="h-8 w-8 text-blue-400 mb-4" />
                <h3 className="font-semibold text-lg">{step.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{step.description}</p>
              </div>
            ))}
          </div>

          <Button asChild className="mt-8" size="lg">
            <a
              href={LAUNCHPAD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2"
            >
              Launch Your Agent
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}
