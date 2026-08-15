import {
  Card,
  CardContent,
  CardHeader,
} from '../../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Badge } from '../../components/ui/badge.js';
import { Separator } from '../../components/ui/separator.js';
import { PLUGIN_SHAPE_FIELDS, PLUGIN_MODES } from './shape-fields.js';

import type { JSX } from 'react';

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';

/**
 * ShapeCatalogue — reference card on the /build page enumerating the
 * `SolverPluginManifest` fields (driven by `PLUGIN_SHAPE_FIELDS`) and the
 * two exclusive modes (`PLUGIN_MODES`).
 *
 * Migrated to shadcn primitives: outer `<Card>` wraps the surface, the
 * field grid is a `<Table>` with required/optional shown via `<Badge>`
 * (default for required, outline for optional), and each mode is its own
 * inner `<Card>` rendered in a two-column grid.
 *
 * The `data-field-required` attribute on each row is preserved verbatim
 * for the existing snapshot test.
 */
export function ShapeCatalogue(): JSX.Element {
  return (
    <Card className="p-6">
      <CardHeader className="mb-5 flex flex-col gap-1 p-0">
        <span className={eyebrow}>Reference</span>
        <h2 className="m-0 font-serif text-[28px] leading-[1.2] text-foreground">
          Plug-in shape
        </h2>
      </CardHeader>

      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {PLUGIN_SHAPE_FIELDS.map((f) => (
              <TableRow key={f.name} data-field-required={f.required ? 'true' : 'false'}>
                <TableCell className="font-mono text-[13px] text-primary">{f.name}</TableCell>
                <TableCell className="font-mono text-[13px] text-muted-foreground">{f.type}</TableCell>
                <TableCell>
                  <Badge variant={f.required ? 'default' : 'outline'}>
                    {f.required ? 'yes' : 'no'}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-[13px] text-muted-foreground">{f.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Separator className="my-8" />

        <div className="mb-4 flex flex-col gap-1">
          <span className={eyebrow}>Modes</span>
          <h3 className="m-0 font-serif text-[22px] leading-[1.25] text-foreground">
            Two modes
          </h3>
          <p className="m-0 mt-1 max-w-[72ch] font-mono text-[13px] leading-[1.7] text-muted-foreground">
            The validator enforces exactly two exclusive modes. Mixing is rejected.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {PLUGIN_MODES.map((m, idx) => (
            <Card key={m.id} className="flex flex-col gap-2.5 bg-[var(--bg-sunken)] p-4">
              <span className={eyebrow}>{idx === 0 ? 'Mode · 01' : 'Mode · 02'}</span>
              <h4 className="m-0 font-mono text-[15px] font-medium tracking-[-0.01em] text-foreground">
                {m.label}
              </h4>
              <p className="m-0 font-mono text-[12px] leading-[1.6] text-muted-foreground">
                {m.requires}
              </p>
              <pre className="m-0 overflow-x-auto rounded-sm border border-border bg-background px-3 py-2.5 font-mono text-[12px] leading-[1.5] text-primary">
                <code>{m.example}</code>
              </pre>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
