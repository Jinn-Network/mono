'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePrivy } from '@privy-io/react-auth';
import { defineStepper } from '@stepperize/react';
import { Loader2, Plus, X, ArrowRight, ArrowLeft, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { createVenture } from '@/app/actions';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function toOutputTopic(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

const { useStepper } = defineStepper(
  { id: 'name', title: 'Name', description: 'Name your agent' },
  { id: 'sources', title: 'Sources', description: 'Define your sources' },
  { id: 'configure', title: 'Configure', description: 'Configure content' },
  { id: 'review', title: 'Review', description: 'Review & launch' },
);

const LOOKBACK_OPTIONS = [
  { value: '24 hours', label: '24 hours' },
  { value: '3 days', label: '3 days' },
  { value: '7 days', label: '7 days' },
  { value: '30 days', label: '30 days' },
];

const CADENCE_OPTIONS = [
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 9 * * *', label: 'Daily (9 AM UTC)' },
  { value: '0 9 * * 1', label: 'Weekly (Monday 9 AM UTC)' },
];

export function CreateVentureForm() {
  const router = useRouter();
  const { user } = usePrivy();
  const address = user?.wallet?.address;
  const stepper = useStepper();

  // Form state
  const [name, setName] = useState('');
  const [sources, setSources] = useState<string[]>(['']);
  const [lookbackPeriod, setLookbackPeriod] = useState('24 hours');
  const [contentBrief, setContentBrief] = useState('');
  const [formatBrief, setFormatBrief] = useState('');
  const [outputFormat, setOutputFormat] = useState('markdown');
  const [dispatchCron, setDispatchCron] = useState('0 9 * * *');
  const [isSaving, setIsSaving] = useState(false);

  // Format rules (advanced)
  const [showFormatRules, setShowFormatRules] = useState(false);
  const [minWords, setMinWords] = useState<string>('');
  const [maxWords, setMaxWords] = useState<string>('');
  const [requiredSections, setRequiredSections] = useState<string[]>([]);
  const [requiredCitations, setRequiredCitations] = useState<string>('');
  const [newSection, setNewSection] = useState('');

  const steps = stepper.lookup.getAll();
  const currentStepIndex = stepper.state.current.index;
  const totalSteps = steps.length;

  function addSource() {
    setSources([...sources, '']);
  }

  function removeSource(index: number) {
    setSources(sources.filter((_, i) => i !== index));
  }

  function updateSource(index: number, value: string) {
    const updated = [...sources];
    updated[index] = value;
    setSources(updated);
  }

  const validSources = sources.filter((s) => s.trim());

  function canProceed(): boolean {
    switch (stepper.state.current.data.id) {
      case 'name':
        return name.trim().length > 0;
      case 'sources':
        return validSources.length > 0;
      case 'configure':
        return true; // all optional with defaults
      case 'review':
        return true;
      default:
        return false;
    }
  }

  async function handleSubmit() {
    if (!address) return;

    setIsSaving(true);
    try {
      const slug = slugify(name);
      // Build formatRules if any are set
      const formatRules: Record<string, unknown> = {};
      if (minWords) formatRules.minWords = parseInt(minWords, 10);
      if (maxWords) formatRules.maxWords = parseInt(maxWords, 10);
      if (requiredCitations) formatRules.requiredCitations = parseInt(requiredCitations, 10);
      if (requiredSections.length > 0) formatRules.requiredSections = requiredSections;

      const result = await createVenture({
        name: name.trim(),
        slug,
        owner_address: address,
        template: {
          sources: validSources,
          lookbackPeriod,
          outputTopic: toOutputTopic(name),
          contentBrief: contentBrief.trim() || 'Summarize notable developments.',
          formatBrief: formatBrief.trim() || 'Clear, professional prose. Organize thematically.',
          outputFormat,
          dispatchCron: dispatchCron.trim() || '0 9 * * *',
          ...(Object.keys(formatRules).length > 0 ? { formatRules } : {}),
        },
      });

      if (result.error) {
        toast.error(result.error);
      } else if (!result.data?.slug) {
        toast.error('Venture creation failed — please try again.');
      } else {
        toast.success('Content agent created!');
        router.push(`/ventures/${result.data.slug}`);
      }
    } catch {
      toast.error('Failed to create content agent');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className="max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle>Create a Content Agent</CardTitle>
        <CardDescription>
          Set up an agent that turns your knowledge into continuous, high-quality content.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Step indicator */}
        <div className="flex items-center gap-2">
          {steps.map((step, i) => (
            <div key={step.id} className="flex items-center gap-2 flex-1">
              <div className={`
                flex items-center justify-center h-8 w-8 rounded-full text-sm font-medium shrink-0
                ${i < currentStepIndex ? 'bg-primary text-primary-foreground' : ''}
                ${i === currentStepIndex ? 'bg-primary text-primary-foreground ring-2 ring-primary/30' : ''}
                ${i > currentStepIndex ? 'bg-muted text-muted-foreground' : ''}
              `}>
                {i < currentStepIndex ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <span className={`text-xs hidden sm:inline ${i === currentStepIndex ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                {step.title}
              </span>
              {i < totalSteps - 1 && (
                <Separator className="flex-1" />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: Name */}
        {stepper.state.current.data.id === 'name' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">What should we call your agent?</Label>
              <Input
                id="name"
                placeholder="e.g. Chess Opening Theory, Rare Disease Research, AI Engineering Digest"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                This name identifies your agent and its output.
              </p>
            </div>
          </div>
        )}

        {/* Step 2: Sources */}
        {stepper.state.current.data.id === 'sources' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>What sources should your agent monitor?</Label>
              <p className="text-xs text-muted-foreground">
                Add the URLs, communities, and references you follow. Your agent monitors them for you.
              </p>
            </div>
            <div className="space-y-3">
              {sources.map((source, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    placeholder="https://example.com or a topic description"
                    value={source}
                    onChange={(e) => updateSource(i, e.target.value)}
                    autoFocus={i === sources.length - 1}
                  />
                  {sources.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeSource(i)}
                      className="shrink-0"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={addSource} className="gap-1">
              <Plus className="h-3 w-3" />
              Add source
            </Button>
          </div>
        )}

        {/* Step 3: Configure */}
        {stepper.state.current.data.id === 'configure' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="lookback">How far back should it look?</Label>
              <Select value={lookbackPeriod} onValueChange={setLookbackPeriod}>
                <SelectTrigger id="lookback">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOOKBACK_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="brief">What&apos;s your perspective?</Label>
              <Textarea
                id="brief"
                placeholder="e.g. Focus on practical applications over theory. I believe the London System is underrated for club players."
                value={contentBrief}
                onChange={(e) => setContentBrief(e.target.value)}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Optional. This is what makes your agent&apos;s output uniquely yours — your take, your editorial angle.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="format">What style and format?</Label>
              <Textarea
                id="format"
                placeholder="e.g. Professional tone, structured as an executive summary with bullet points. Keep under 1500 words."
                value={formatBrief}
                onChange={(e) => setFormatBrief(e.target.value)}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Optional. Controls tone, structure, and length.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="outputFormat">Output format</Label>
              <Select value={outputFormat} onValueChange={setOutputFormat}>
                <SelectTrigger id="outputFormat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="markdown">Markdown</SelectItem>
                  <SelectItem value="structured-json">Structured JSON</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="cadence">How often should the agent run?</Label>
              <Select value={dispatchCron} onValueChange={setDispatchCron}>
                <SelectTrigger id="cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CADENCE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setShowFormatRules(!showFormatRules)}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                <span className={`transition-transform ${showFormatRules ? 'rotate-90' : ''}`}>&#9656;</span>
                Output rules (optional)
              </button>
              <p className="text-xs text-muted-foreground -mt-1">
                Set constraints your agent must follow — word limits, required sections, citation minimums.
              </p>

              {showFormatRules && (
                <div className="space-y-4 pl-2 border-l-2 border-border/50">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="minWords" className="text-xs">Min words</Label>
                      <Input
                        id="minWords"
                        type="number"
                        placeholder="e.g. 500"
                        value={minWords}
                        onChange={(e) => setMinWords(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="maxWords" className="text-xs">Max words</Label>
                      <Input
                        id="maxWords"
                        type="number"
                        placeholder="e.g. 2000"
                        value={maxWords}
                        onChange={(e) => setMaxWords(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="requiredCitations" className="text-xs">Min citations</Label>
                    <Input
                      id="requiredCitations"
                      type="number"
                      placeholder="e.g. 3"
                      value={requiredCitations}
                      onChange={(e) => setRequiredCitations(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs">Required sections</Label>
                    {requiredSections.map((section, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="text-sm text-muted-foreground flex-1 truncate py-1">{section}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => setRequiredSections(requiredSections.filter((_, j) => j !== i))}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Input
                        placeholder="e.g. Executive Summary"
                        value={newSection}
                        onChange={(e) => setNewSection(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newSection.trim()) {
                            e.preventDefault();
                            setRequiredSections([...requiredSections, newSection.trim()]);
                            setNewSection('');
                          }
                        }}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!newSection.trim()}
                        onClick={() => {
                          setRequiredSections([...requiredSections, newSection.trim()]);
                          setNewSection('');
                        }}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 4: Review */}
        {stepper.state.current.data.id === 'review' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border/50 p-4 space-y-3">
              <div>
                <span className="text-xs text-muted-foreground">Name</span>
                <p className="font-medium">{name}</p>
              </div>
              <Separator />
              <div>
                <span className="text-xs text-muted-foreground">Sources ({validSources.length})</span>
                <ul className="mt-1 space-y-1">
                  {validSources.map((s, i) => (
                    <li key={i} className="text-sm text-muted-foreground truncate">{s}</li>
                  ))}
                </ul>
              </div>
              <Separator />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-xs text-muted-foreground">Lookback</span>
                  <p className="text-sm">{lookbackPeriod}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Format</span>
                  <p className="text-sm">{outputFormat}</p>
                </div>
              </div>
              <Separator />
              <div>
                <span className="text-xs text-muted-foreground">Cadence</span>
                <p className="text-sm">{CADENCE_OPTIONS.find(o => o.value === dispatchCron)?.label || dispatchCron}</p>
              </div>
              {contentBrief && (
                <>
                  <Separator />
                  <div>
                    <span className="text-xs text-muted-foreground">Content brief</span>
                    <p className="text-sm text-muted-foreground">{contentBrief}</p>
                  </div>
                </>
              )}
              {formatBrief && (
                <>
                  <Separator />
                  <div>
                    <span className="text-xs text-muted-foreground">Style brief</span>
                    <p className="text-sm text-muted-foreground">{formatBrief}</p>
                  </div>
                </>
              )}
              {(minWords || maxWords || requiredCitations || requiredSections.length > 0) && (
                <>
                  <Separator />
                  <div>
                    <span className="text-xs text-muted-foreground">Output rules</span>
                    <div className="mt-1 space-y-1 text-sm text-muted-foreground">
                      {minWords && <p>Min words: {minWords}</p>}
                      {maxWords && <p>Max words: {maxWords}</p>}
                      {requiredCitations && <p>Min citations: {requiredCitations}</p>}
                      {requiredSections.length > 0 && <p>Required sections: {requiredSections.join(', ')}</p>}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between pt-2">
          <Button
            variant="outline"
            onClick={() => stepper.navigation.prev()}
            disabled={stepper.state.isFirst}
            className="gap-1"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>

          {stepper.state.isLast ? (
            <Button
              onClick={handleSubmit}
              disabled={isSaving || !canProceed()}
              className="gap-1"
            >
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              Launch Agent
            </Button>
          ) : (
            <Button
              onClick={() => stepper.navigation.next()}
              disabled={!canProceed()}
              className="gap-1"
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
