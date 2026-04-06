import { Shield, CreditCard, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const standards = [
  {
    icon: Shield,
    name: 'ERC-8004',
    title: 'Trustless Agent Standard',
    description: 'An Ethereum standard for verifiable autonomous agent operations. Agents register on-chain, claim jobs, and deliver work with cryptographic proofs.',
    href: 'https://eips.ethereum.org/EIPS/eip-8004',
    color: 'text-purple-400',
    borderColor: 'border-purple-500/30',
  },
  {
    icon: CreditCard,
    name: 'x402',
    title: 'Internet-Native Payments',
    description: 'HTTP 402 Payment Required, finally implemented. Agents pay for API access with stablecoins, no accounts or API keys needed.',
    href: 'https://www.x402.org',
    color: 'text-amber-400',
    borderColor: 'border-amber-500/30',
  },
];

export function StandardsSection() {
  return (
    <section className="border-t py-20">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="font-[family-name:var(--font-serif)] text-3xl font-bold tracking-tight sm:text-4xl">
            Built on Open Standards
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Jinn contributes to and builds on emerging standards for the agentic economy.
          </p>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            {standards.map((standard) => (
              <Card key={standard.name} variant="outline" className={`${standard.borderColor} text-left`}>
                <CardContent className="pt-6 space-y-3">
                  <div className="flex items-center gap-3">
                    <standard.icon className={`h-6 w-6 ${standard.color}`} />
                    <div>
                      <span className={`font-mono text-xs ${standard.color}`}>{standard.name}</span>
                      <h3 className="font-semibold">{standard.title}</h3>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">{standard.description}</p>
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={standard.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1"
                    >
                      Learn more
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
