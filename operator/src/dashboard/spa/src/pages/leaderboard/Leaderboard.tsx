import { useState, type JSX } from 'react';
import { Card, CardContent } from '../../components/ui/card.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { TrainLeaderboardTable } from './TrainLeaderboardTable.js';
import { FrozenLeaderboardTable } from './FrozenLeaderboardTable.js';

type LeaderboardTab = 'train' | 'frozen';

/**
 * Leaderboard page — switches between Train and Frozen rollups for the
 * named SolverNet. Built on shadcn `<Tabs>` (Radix-backed, so the
 * `role="tab"` and `aria-selected` semantics asserted by the tests come
 * for free) inside a `<Card>` shell.
 */
export function LeaderboardPage({ solverNet }: { solverNet: string }): JSX.Element {
  const [tab, setTab] = useState<LeaderboardTab>('train');
  return (
    <div className="p-6">
      <Card>
        <CardContent className="p-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v as LeaderboardTab)}>
            <TabsList>
              <TabsTrigger value="train">Train</TabsTrigger>
              <TabsTrigger value="frozen">Frozen</TabsTrigger>
            </TabsList>
            <TabsContent value="train">
              <TrainLeaderboardTable solverNet={solverNet} />
            </TabsContent>
            <TabsContent value="frozen">
              <FrozenLeaderboardTable solverNet={solverNet} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
