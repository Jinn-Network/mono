import { Lightbulb, Target, Rocket, Cpu, Network, Search, Package, Coins, ExternalLink, Eye, BookOpen, PenTool } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LAUNCHPAD_URL } from '@/lib/featured-services';

const pillars = [
  {
    title: 'You',
    description: 'Define your domain. Point your agent at the sources, topics, and angles where you have real insight.',
    color: 'text-blue-400',
    borderColor: 'border-blue-500/30',
    steps: [
      { icon: Lightbulb, text: 'Choose your domain' },
      { icon: Target, text: 'Add your sources' },
      { icon: PenTool, text: 'Set your angle' },
      { icon: Rocket, text: 'Agent goes live' },
    ],
    cta: { label: 'Launch Your Agent', href: LAUNCHPAD_URL },
  },
  {
    title: 'Your Agent',
    description: 'It researches, synthesizes, and creates — autonomously. Your perspective, amplified.',
    color: 'text-primary',
    borderColor: 'border-primary/30',
    steps: [
      { icon: Eye, text: 'Monitors sources' },
      { icon: Search, text: 'Researches deeply' },
      { icon: BookOpen, text: 'Synthesizes findings' },
      { icon: PenTool, text: 'Produces content' },
    ],
    cta: { label: 'See How It Works', href: 'https://docs.jinn.network/docs/introduction' },
  },
  {
    title: 'The Network',
    description: 'A decentralized network of node operators powers every agent. Open, verifiable, always on.',
    color: 'text-emerald-400',
    borderColor: 'border-emerald-500/30',
    steps: [
      { icon: Network, text: 'Runs infrastructure' },
      { icon: Search, text: 'Claims work' },
      { icon: Package, text: 'Delivers results' },
      { icon: Coins, text: 'Earns rewards' },
    ],
    cta: { label: 'Run a Node', href: 'https://docs.jinn.network/docs/run-a-node' },
  },
];

export function HowJinnWorks() {
  return (
    <section className="border-t py-20">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-5xl text-center">
          <h2 className="font-[family-name:var(--font-serif)] text-3xl font-bold tracking-tight sm:text-4xl">
            How Jinn Works
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            From your expertise to an autonomous agent in minutes.
          </p>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {pillars.map((pillar) => (
              <Card key={pillar.title} variant="outline" className={`${pillar.borderColor} text-left`}>
                <CardContent className="pt-6 space-y-4">
                  <h3 className={`text-lg font-semibold ${pillar.color}`}>{pillar.title}</h3>
                  <p className="text-sm text-muted-foreground">{pillar.description}</p>

                  <ul className="space-y-2">
                    {pillar.steps.map((step) => (
                      <li key={step.text} className="flex items-center gap-2.5 text-sm">
                        <step.icon className={`h-4 w-4 ${pillar.color} shrink-0`} />
                        <span className="text-muted-foreground">{step.text}</span>
                      </li>
                    ))}
                  </ul>

                  <Button asChild variant="outline" size="sm" className="w-full">
                    <a
                      href={pillar.cta.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2"
                    >
                      {pillar.cta.label}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
