import { Link } from 'wouter';
import { ArrowRight, Wrench } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { Button } from '../components/ui/button.js';

export interface OperatorPageProps {
  onRestartPending?: () => void;
}

export function OperatorPage(_props: OperatorPageProps = {}): JSX.Element {
  return (
    <div data-testid="operator-page" className="flex flex-col gap-4 p-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="flex items-center gap-2">
              <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
              Launcher tools
            </CardTitle>
            <CardDescription>Create or manage SolverNets you own.</CardDescription>
          </div>
          <Button asChild variant="link" size="sm" className="h-auto whitespace-nowrap p-0">
            <Link href="/launcher">
              Open Launcher <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
