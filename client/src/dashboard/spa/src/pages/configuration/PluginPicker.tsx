import { useMemo, useState } from 'react';
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', position: 'relative' }}>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {selectedOptions.map((option) => (
          <span
            key={option.name}
            data-testid={`${rowTestId}-chip`}
            data-plugin={option.name}
            style={{
              border: '1px solid var(--border)',
              borderRadius: '999px',
              padding: '5px 7px 5px 9px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              color: 'var(--fg)',
              background: option.defaultIncluded ? 'var(--bg-sunken)' : 'transparent',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>
              {displayName(option.name)}
              <span style={{ color: 'var(--fg-dim)' }}>
                {option.defaultIncluded ? ' · default' : ' · selected'}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Remove ${displayName(option.name)}`}
              data-testid={`${rowTestId}-remove`}
              data-plugin={option.name}
              onClick={() => removeOption(option)}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--fg-muted)',
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '12px',
                lineHeight: 1,
                padding: '1px 3px',
              }}
            >
              x
            </button>
          </span>
        ))}
      </div>

      {confirmRemove && (
        <div
          role="alertdialog"
          data-testid={`${rowTestId}-default-warning`}
          style={{
            border: '1px solid var(--wane)',
            borderRadius: '8px',
            background: 'var(--bg-elevated)',
            padding: '10px 12px',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: '12px',
            alignItems: 'center',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--fg)' }}>
            {displayName(confirmRemove.name)} is part of the default operator baseline.
            Removing it may break standard SolverNet workflows.
          </span>
          <span style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              data-testid={`${rowTestId}-default-warning-cancel`}
              onClick={() => setConfirmRemove(null)}
              style={{
                border: '1px solid var(--border)',
                borderRadius: '6px',
                background: 'transparent',
                color: 'var(--fg-muted)',
                padding: '6px 9px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              Keep
            </button>
            <button
              type="button"
              data-testid={`${rowTestId}-default-warning-confirm`}
              onClick={confirmRemoveDefault}
              style={{
                border: '1px solid var(--wane)',
                borderRadius: '6px',
                background: 'transparent',
                color: 'var(--wane)',
                padding: '6px 9px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              Remove
            </button>
          </span>
        </div>
      )}

      <button
        type="button"
        data-testid={`${rowTestId}-trigger`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            setQuery('');
          }
        }}
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '9px 11px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          color: 'var(--fg)',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          gap: '12px',
          alignItems: 'center',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ minWidth: 0 }}>
          Add plugin
          <span style={{ color: 'var(--fg-dim)' }}>
            {' '}
            · {defaultCount} default{selectedCount > 0 ? ` · ${selectedCount} selected` : ''}
          </span>
        </span>
        <span style={{ color: 'var(--fg-muted)' }}>{open ? '^' : 'v'}</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            zIndex: 30,
            border: '1px solid var(--border)',
            borderRadius: '8px',
            background: 'var(--bg-elevated)',
            boxShadow: '0 14px 34px rgba(0, 0, 0, 0.35)',
            overflow: 'hidden',
          }}
        >
          <input
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
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'var(--bg)',
              border: 'none',
              borderBottom: '1px solid var(--border)',
              padding: '10px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              color: 'var(--fg)',
              outline: 'none',
            }}
          />
          <div
            role="listbox"
            aria-label="Plugins"
            style={{
              maxHeight: '240px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {filtered.length === 0 ? (
              <span
                style={{
                  padding: '12px 14px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '12px',
                  color: 'var(--fg-dim)',
                }}
              >
                {addableOptions.length === 0 ? 'No plugins available to add.' : 'No matching plugins.'}
              </span>
            ) : (
              filtered.map((option, idx) => {
                const active = activeSet.has(option.name);
                return (
                  <button
                    key={option.name}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-testid={rowTestId}
                    data-plugin={option.name}
                    data-plugin-active={active ? 'true' : 'false'}
                    data-plugin-default={option.defaultIncluded ? 'true' : 'false'}
                    onClick={() => addOption(option)}
                    style={{
                      border: 'none',
                      borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                      background: active ? 'var(--bg-sunken)' : 'transparent',
                      color: 'var(--fg)',
                      padding: '10px 12px',
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                      gap: '12px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontSize: '13px', color: 'var(--fg)' }}>
                        {displayName(option.name)}
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>
                        {metaFor(option)}
                      </span>
                    </span>
                    <span
                      style={{
                        color: option.defaultIncluded ? 'var(--fg-dim)' : option.recommended ? 'var(--accent-sky)' : 'var(--fg-muted)',
                        fontSize: '11px',
                        alignSelf: 'center',
                        textTransform: 'uppercase',
                        letterSpacing: 0,
                      }}
                    >
                      {option.defaultIncluded ? 'Default' : option.recommended ? 'Recommended' : 'Add'}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
