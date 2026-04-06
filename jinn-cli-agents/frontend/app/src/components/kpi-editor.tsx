'use client';

import { useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { Plus, Trash2, Target, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { updateVentureKPIs, type KPIInvariant } from '@/app/actions';

type InvariantType = 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN';

const TYPE_LABELS: Record<InvariantType, string> = {
  FLOOR: 'At least (minimum)',
  CEILING: 'At most (maximum)',
  RANGE: 'Between (range)',
  BOOLEAN: 'Yes/No (boolean)',
};

interface KPIEditorProps {
  ventureId: string;
  ownerAddress: string;
  initialInvariants: KPIInvariant[];
}

function KPIDisplay({ invariants }: { invariants: KPIInvariant[] }) {
  if (invariants.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic py-4 text-center">
        No success criteria defined yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {invariants.map((inv) => (
        <div key={inv.id} className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30">
          <Target className="h-4 w-4 mt-0.5 text-primary shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{inv.metric || inv.condition}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{inv.assessment}</p>
            <span className="inline-block mt-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {inv.type}
              {inv.type === 'FLOOR' && inv.min != null && ` >= ${inv.min}`}
              {inv.type === 'CEILING' && inv.max != null && ` <= ${inv.max}`}
              {inv.type === 'RANGE' && inv.min != null && inv.max != null && ` ${inv.min}–${inv.max}`}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function KPIEditor({ ventureId, ownerAddress, initialInvariants }: KPIEditorProps) {
  const { user } = usePrivy();
  const address = user?.wallet?.address;
  const isOwner = address?.toLowerCase() === ownerAddress.toLowerCase();

  const [invariants, setInvariants] = useState<KPIInvariant[]>(initialInvariants);
  const [isAdding, setIsAdding] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Form state for new KPI
  const [newType, setNewType] = useState<InvariantType>('FLOOR');
  const [newMetric, setNewMetric] = useState('');
  const [newCondition, setNewCondition] = useState('');
  const [newMin, setNewMin] = useState('');
  const [newMax, setNewMax] = useState('');
  const [newAssessment, setNewAssessment] = useState('');

  function resetForm() {
    setNewType('FLOOR');
    setNewMetric('');
    setNewCondition('');
    setNewMin('');
    setNewMax('');
    setNewAssessment('');
    setIsAdding(false);
  }

  function addKPI() {
    const kpi: KPIInvariant = {
      id: `KPI-${String(invariants.length + 1).padStart(3, '0')}`,
      type: newType,
      assessment: newAssessment.trim(),
    };

    if (newType === 'BOOLEAN') {
      kpi.condition = newCondition.trim();
    } else {
      kpi.metric = newMetric.trim();
      if (newType === 'FLOOR' || newType === 'RANGE') {
        kpi.min = Number(newMin);
      }
      if (newType === 'CEILING' || newType === 'RANGE') {
        kpi.max = Number(newMax);
      }
    }

    setInvariants([...invariants, kpi]);
    resetForm();
  }

  function removeKPI(id: string) {
    setInvariants(invariants.filter((inv) => inv.id !== id));
  }

  async function handleSave() {
    if (!address) return;
    setIsSaving(true);
    try {
      const result = await updateVentureKPIs(ventureId, invariants, address);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success('KPIs updated');
      }
    } catch {
      toast.error('Failed to save KPIs');
    } finally {
      setIsSaving(false);
    }
  }

  const isNewValid = newType === 'BOOLEAN'
    ? newCondition.trim() && newAssessment.trim()
    : newMetric.trim() && newAssessment.trim() && (
      newType === 'FLOOR' ? newMin !== '' :
      newType === 'CEILING' ? newMax !== '' :
      newMin !== '' && newMax !== ''
    );

  const hasChanges = JSON.stringify(invariants) !== JSON.stringify(initialInvariants);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Target className="h-4 w-4" />
          Success Criteria (KPIs)
        </CardTitle>
        <CardDescription>
          Measurable goals that define what success looks like.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Read-only view for non-owners, or editable list for owners */}
        {!isOwner ? (
          <KPIDisplay invariants={invariants} />
        ) : (
          <>
            {/* Existing KPIs with remove buttons */}
            {invariants.length > 0 && (
              <div className="space-y-2">
                {invariants.map((inv) => (
                  <div key={inv.id} className="flex items-start gap-2 p-3 rounded-lg border bg-muted/30">
                    <Target className="h-4 w-4 mt-0.5 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{inv.metric || inv.condition}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{inv.assessment}</p>
                      <span className="inline-block mt-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {inv.type}
                        {inv.type === 'FLOOR' && inv.min != null && ` >= ${inv.min}`}
                        {inv.type === 'CEILING' && inv.max != null && ` <= ${inv.max}`}
                        {inv.type === 'RANGE' && inv.min != null && inv.max != null && ` ${inv.min}–${inv.max}`}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => removeKPI(inv.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {invariants.length === 0 && !isAdding && (
              <p className="text-sm text-muted-foreground italic text-center py-2">
                No KPIs yet. Add at least 2 to unlock token launch.
              </p>
            )}

            {/* Add KPI form */}
            {isAdding ? (
              <div className="space-y-3 p-3 rounded-lg border border-dashed">
                <div className="space-y-2">
                  <Label className="text-xs">Type</Label>
                  <Select value={newType} onValueChange={(v) => setNewType(v as InvariantType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.entries(TYPE_LABELS) as [InvariantType, string][]).map(([key, label]) => (
                        <SelectItem key={key} value={key}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {newType === 'BOOLEAN' ? (
                  <div className="space-y-2">
                    <Label className="text-xs">Condition</Label>
                    <Input
                      placeholder="e.g. Weekly newsletter published"
                      value={newCondition}
                      onChange={(e) => setNewCondition(e.target.value)}
                    />
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label className="text-xs">Metric</Label>
                      <Input
                        placeholder="e.g. Weekly active users"
                        value={newMetric}
                        onChange={(e) => setNewMetric(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      {(newType === 'FLOOR' || newType === 'RANGE') && (
                        <div className="space-y-2 flex-1">
                          <Label className="text-xs">Min</Label>
                          <Input
                            type="number"
                            placeholder="0"
                            value={newMin}
                            onChange={(e) => setNewMin(e.target.value)}
                          />
                        </div>
                      )}
                      {(newType === 'CEILING' || newType === 'RANGE') && (
                        <div className="space-y-2 flex-1">
                          <Label className="text-xs">Max</Label>
                          <Input
                            type="number"
                            placeholder="100"
                            value={newMax}
                            onChange={(e) => setNewMax(e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}

                <div className="space-y-2">
                  <Label className="text-xs">How to measure</Label>
                  <Input
                    placeholder="e.g. Count unique visitors from analytics dashboard"
                    value={newAssessment}
                    onChange={(e) => setNewAssessment(e.target.value)}
                  />
                </div>

                <div className="flex gap-2">
                  <Button size="sm" onClick={addKPI} disabled={!isNewValid}>Add</Button>
                  <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setIsAdding(true)}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add KPI
              </Button>
            )}

            {/* Save button */}
            {hasChanges && (
              <Button onClick={handleSave} disabled={isSaving} className="w-full">
                {isSaving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Save KPIs
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
