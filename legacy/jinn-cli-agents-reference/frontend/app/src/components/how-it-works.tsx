'use client';

import { useState } from 'react';
import { X, Lightbulb, Target, Heart, Rocket, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';

const steps = [
  {
    icon: Lightbulb,
    label: '1. Post Idea',
    description: 'Share your concept with the community.',
    color: 'bg-blue-500/10 text-blue-400',
  },
  {
    icon: Target,
    label: '2. Define Goals',
    description: 'Set measurable success criteria.',
    color: 'bg-purple-500/10 text-purple-400',
  },
  {
    icon: Heart,
    label: '3. Rally Support',
    description: 'Gather likes and comments.',
    color: 'bg-pink-500/10 text-pink-400',
  },
  {
    icon: Rocket,
    label: '4. Launch',
    description: 'Launch a token to fund execution.',
    color: 'bg-amber-500/10 text-amber-400',
  },
  {
    icon: Zap,
    label: '5. Execute',
    description: 'AI agents do the work.',
    color: 'bg-emerald-500/10 text-emerald-400',
  },
];

export function HowItWorks() {
    const [isVisible, setIsVisible] = useState(true);

    if (!isVisible) return null;

    return (
        <div className="relative rounded-xl border border-border/50 bg-secondary/20 p-6 backdrop-blur-sm">
            <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => setIsVisible(false)}
            >
                <X className="h-4 w-4" />
                <span className="sr-only">Dismiss</span>
            </Button>

            <div className="mb-4">
                <h3 className="font-semibold text-foreground">How it works</h3>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-5">
                {steps.map((step) => (
                    <div key={step.label} className="space-y-2 p-3 rounded-lg hover:bg-white/5 transition-colors">
                        <div className="flex items-center gap-2 text-sm font-medium text-primary">
                            <div className={`p-1.5 rounded-full ${step.color}`}>
                                <step.icon className="h-4 w-4" />
                            </div>
                            {step.label}
                        </div>
                        <p className="text-xs text-muted-foreground pl-9">{step.description}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}
