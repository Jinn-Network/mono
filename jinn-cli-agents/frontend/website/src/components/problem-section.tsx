import { Check, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

const withoutJinn = [
  'AI is learning to do what you do — faster and cheaper',
  'Your expertise gets fed into models you don\'t control',
  'Industries are being reshaped before people can adapt',
  'Waiting and hoping isn\'t a strategy',
];

const withJinn = [
  'Turn what you know into an AI agent you own',
  'Your agent researches and creates content autonomously',
  'Your expertise compounds — it doesn\'t get given away',
  'You capture the value, not a corporation',
];

export function ProblemSection() {
  return (
    <section id="problem" className="py-20">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="font-[family-name:var(--font-serif)] text-3xl font-bold tracking-tight sm:text-4xl">
            AI Is Changing Everything. Are You Ready?
          </h2>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <Card variant="outline" className="border-red-500/30 text-left">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-red-400 mb-4">What&apos;s Happening Now</h3>
                <ul className="space-y-3">
                  {withoutJinn.map((item) => (
                    <li key={item} className="flex items-center gap-3 text-sm text-muted-foreground">
                      <X className="h-4 w-4 text-red-400 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card variant="outline" className="border-emerald-500/30 text-left">
              <CardContent className="pt-6">
                <h3 className="font-semibold text-emerald-400 mb-4">What You Can Do About It</h3>
                <ul className="space-y-3">
                  {withJinn.map((item) => (
                    <li key={item} className="flex items-center gap-3 text-sm text-muted-foreground">
                      <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          <p className="mt-8 text-lg font-medium text-primary">
            Your knowledge is valuable. It&apos;s time to own it.
          </p>
        </div>
      </div>
    </section>
  );
}
