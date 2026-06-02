import { useMemo, useState, type JSX } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.js';
import { ScrollArea } from '../../components/ui/scroll-area.js';
import { cn } from '../../lib/utils.js';
import { canonicalHarnessName, HERMES_AGENT_HARNESS } from './harnessNames.js';

export interface CatalogPluginOption {
  name: string;
  version: string;
  source: string;
}

interface PluginOption extends CatalogPluginOption {
  defaultIncluded?: boolean;
  recommended?: boolean;
  description?: string;
}

export interface PluginPickerProps {
  available: CatalogPluginOption[];
  selected: string[];
  disabledDefaultPlugins?: string[];
  onChange: (plugins: string[], disabledDefaultPlugins: string[]) => void;
  rowTestId: string;
  searchTestId: string;
  /**
   * Selected harness. Determines which bundled plugins are surfaced as
   * defaults — e.g. Hermes owns its own learning loop (see harness.ts) so
   * `claude-code-learner` is dropped from the Hermes default set.
   */
  harness?: string;
}

const ALL_INCLUDED_PLUGINS: PluginOption[] = [
  {
    name: 'network-tools',
    version: '0.1.0',
    source: 'bundled',
    defaultIncluded: true,
    description: 'Jinn runtime tools',
  },
  {
    name: 'claude-code-learner',
    version: '0.1.0',
    source: 'bundled',
    defaultIncluded: true,
    description: 'Learner loop',
  },
];

function includedPluginsFor(harness: string | undefined): PluginOption[] {
  if (canonicalHarnessName(harness) === HERMES_AGENT_HARNESS) {
    return ALL_INCLUDED_PLUGINS.filter((p) => p.name !== 'claude-code-learner');
  }
  return ALL_INCLUDED_PLUGINS;
}

const DEFAULT_COMPATIBLE_PLUGINS = new Set([
  'swe-rebench-v2-runtime',
]);

const DISPLAY_NAMES: Record<string, string> = {
  'network-tools': 'Network Tools',
  'claude-code-learner': 'Learner',
  'swe-rebench-v2-runtime': 'SWE-rebench v2 Runtime',
  'jinn-prediction-plugin': 'Prediction Runtime',
};

const BUNDLED_PREFIX = 'bundled:';

function displayName(name: string): string {
  return DISPLAY_NAMES[name] ?? name;
}

function stripBundledPrefix(value: string): string {
  return value.startsWith(BUNDLED_PREFIX) ? value.slice(BUNDLED_PREFIX.length) : value;
}

function pluginConfigValue(option: CatalogPluginOption): string {
  return option.source === 'bundled' ? `${BUNDLED_PREFIX}${option.name}` : option.name;
}

function uniquePluginValues(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const name = stripBundledPrefix(value);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(value);
  }
  return out;
}

function buildOptions(
  available: CatalogPluginOption[],
  selected: string[],
  harness: string | undefined,
): PluginOption[] {
  const seen = new Set<string>();
  const out: PluginOption[] = [];
  for (const plugin of includedPluginsFor(harness)) {
    seen.add(plugin.name);
    out.push(plugin);
  }
  for (const plugin of available) {
    if (seen.has(plugin.name)) continue;
    seen.add(plugin.name);
    const defaultIncluded = DEFAULT_COMPATIBLE_PLUGINS.has(plugin.name);
    out.push({
      ...plugin,
      ...(defaultIncluded ? { defaultIncluded: true } : { recommended: true }),
      description: plugin.name === 'swe-rebench-v2-runtime'
        ? 'SWE-rebench v2 runtime'
        : 'Recommended for this SolverNet',
    });
  }
  for (const value of selected) {
    const name = stripBundledPrefix(value);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      version: 'configured',
      source: value.startsWith(BUNDLED_PREFIX) ? 'bundled' : 'custom',
      description: 'Already configured',
    });
  }
  return out;
}

function metaFor(option: PluginOption): string {
  const parts = [option.source, option.version];
  if (option.description) parts.push(option.description);
  return parts.join(' · ');
}

export function PluginPicker({
  available,
  selected,
  disabledDefaultPlugins = [],
  onChange,
  rowTestId,
  searchTestId,
  harness,
}: PluginPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<PluginOption | null>(null);
  const options = useMemo(
    () => buildOptions(available, selected, harness),
    [available, selected, harness],
  );
  const selectedSet = new Set(selected.map(stripBundledPrefix));
  const disabledDefaultSet = new Set(disabledDefaultPlugins.map(stripBundledPrefix));
  const activeSet = new Set(selectedSet);
  for (const option of options) {
    if (option.defaultIncluded && !disabledDefaultSet.has(option.name)) {
      activeSet.add(option.name);
    }
  }
  const selectedOptions = options.filter((option) => activeSet.has(option.name));
  const defaultCount = selectedOptions.filter((option) => option.defaultIncluded).length;
  const selectedCount = selectedOptions.length - defaultCount;
  const addableOptions = options.filter((option) => !activeSet.has(option.name));
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? addableOptions.filter((option) =>
        `${option.name} ${displayName(option.name)} ${option.source} ${option.description ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
    : addableOptions;

  const addOption = (option: PluginOption): void => {
    const nextDisabled = option.defaultIncluded
      ? disabledDefaultPlugins.filter((name) => stripBundledPrefix(name) !== option.name)
      : disabledDefaultPlugins;
    const nextSelected = option.defaultIncluded
      ? selected
      : uniquePluginValues([...selected, pluginConfigValue(option)]);
    onChange(nextSelected, nextDisabled);
    setOpen(false);
    setQuery('');
  };

  const removeOption = (option: PluginOption): void => {
    if (option.defaultIncluded) {
      setConfirmRemove(option);
      setOpen(false);
      setQuery('');
      return;
    }
    onChange(
      selected.filter((name) => stripBundledPrefix(name) !== option.name),
      disabledDefaultPlugins,
    );
  };

  const confirmRemoveDefault = (): void => {
    if (!confirmRemove) return;
    onChange(
      selected,
      uniquePluginValues([...disabledDefaultPlugins, confirmRemove.name]),
    );
    setConfirmRemove(null);
  };

  return (
    <div className="relative flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {selectedOptions.map((option) => (
          <span
            key={option.name}
            data-testid={`${rowTestId}-chip`}
            data-plugin={option.name}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-[5px] pl-2.5 font-mono text-[11px] text-foreground',
              option.defaultIncluded ? 'bg-sunken' : 'bg-transparent',
            )}
          >
            <span>
              {displayName(option.name)}
              <span className="text-dim">
                {option.defaultIncluded ? ' · default' : ' · selected'}
              </span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${displayName(option.name)}`}
              data-testid={`${rowTestId}-remove`}
              data-plugin={option.name}
              onClick={() => removeOption(option)}
              className="h-5 w-5 rounded-full p-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
            >
              <X aria-hidden="true" className="!size-3" />
            </Button>
          </span>
        ))}
      </div>

      {confirmRemove && (
        <div
          role="alertdialog"
          data-testid={`${rowTestId}-default-warning`}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-wane bg-card px-3 py-2.5 font-mono"
        >
          <span className="text-[12px] text-foreground">
            {displayName(confirmRemove.name)} is part of the default operator baseline.
            Removing it may break standard SolverNet workflows.
          </span>
          <span className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid={`${rowTestId}-default-warning-cancel`}
              onClick={() => setConfirmRemove(null)}
            >
              Keep
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid={`${rowTestId}-default-warning-confirm`}
              onClick={confirmRemoveDefault}
            >
              Remove
            </Button>
          </span>
        </div>
      )}

      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            data-testid={`${rowTestId}-trigger`}
            aria-haspopup="listbox"
            className="grid h-auto grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-border bg-background px-3 py-2.5 text-left font-mono text-[12px] normal-case tracking-normal text-foreground hover:bg-sunken hover:text-foreground"
          >
            <span className="min-w-0">
              Add plugin
              <span className="text-dim">
                {' '}
                · {defaultCount} default{selectedCount > 0 ? ` · ${selectedCount} selected` : ''}
              </span>
            </span>
            {open ? (
              <ChevronUp aria-hidden="true" className="!size-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown aria-hidden="true" className="!size-3.5 text-muted-foreground" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[min(28rem,90vw)] overflow-hidden p-0"
        >
          <Input
            type="search"
            autoFocus
            aria-label="Search plugins"
            data-testid={searchTestId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false);
                setQuery('');
              }
            }}
            placeholder="Search plugins"
            className="h-auto rounded-none border-0 border-b border-border bg-background px-3 py-2.5 text-[12px] focus-visible:ring-0"
          />
          <ScrollArea className="max-h-60">
            <div role="listbox" aria-label="Plugins" className="flex flex-col">
              {filtered.length === 0 ? (
                <span className="px-3.5 py-3 font-mono text-[12px] text-dim">
                  {addableOptions.length === 0 ? 'No plugins available to add.' : 'No matching plugins.'}
                </span>
              ) : (
                filtered.map((option, idx) => {
                  const active = activeSet.has(option.name);
                  const accentClass = option.defaultIncluded
                    ? 'text-dim'
                    : option.recommended
                      ? 'text-primary'
                      : 'text-muted-foreground';
                  return (
                    <Button
                      key={option.name}
                      type="button"
                      variant="ghost"
                      role="option"
                      aria-selected={active}
                      data-testid={rowTestId}
                      data-plugin={option.name}
                      data-plugin-active={active ? 'true' : 'false'}
                      data-plugin-default={option.defaultIncluded ? 'true' : 'false'}
                      onClick={() => addOption(option)}
                      className={cn(
                        'grid h-auto w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-none px-3 py-2.5 text-left font-mono normal-case tracking-normal transition-colors',
                        idx === 0 ? '' : 'border-t border-border',
                        active ? 'bg-sunken text-foreground' : 'bg-transparent text-foreground',
                        'hover:bg-sunken focus-visible:bg-sunken',
                      )}
                    >
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="text-[13px] text-foreground">{displayName(option.name)}</span>
                        <span className="text-[11px] text-dim">{metaFor(option)}</span>
                      </span>
                      <span className={cn('self-center text-[11px] uppercase', accentClass)}>
                        {option.defaultIncluded ? 'Default' : option.recommended ? 'Recommended' : 'Add'}
                      </span>
                    </Button>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}
