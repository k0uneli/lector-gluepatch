'use client';

import clsx from 'clsx';
import TargetText from '@/components/TargetText';
import { foldWord, stripMarks, type Paradigm } from '@/lib/languages';
import { useActiveLanguage } from '@/utils/hooks';

/** Renders every table of a paradigm; cells holding `highlight` are marked. */
export default function ParadigmTables({
  paradigm,
  highlight,
}: {
  paradigm: Paradigm;
  highlight?: string;
}) {
  const pack = useActiveLanguage();
  const key = (form: string) => stripMarks(foldWord(form, pack));
  const target = highlight ? key(highlight) : null;

  return (
    <div className="space-y-5" data-testid="paradigm-tables">
      {paradigm.tables.map((table, t) => (
        <section key={`${table.title}-${t}`}>
          {table.title && (
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {table.title}
            </h3>
          )}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              {table.columns.some(Boolean) && (
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-1.5" />
                    {table.columns.map((col) => (
                      <th
                        key={col}
                        scope="col"
                        className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.label} className="border-t border-border first:border-t-0">
                    <th
                      scope="row"
                      className="px-3 py-1.5 text-left text-xs font-medium whitespace-nowrap text-muted-foreground"
                    >
                      {row.label}
                    </th>
                    {row.cells.map((cell, c) => {
                      const hit = !!target && cell.forms.some((f) => key(f) === target);
                      return (
                        <td
                          key={c}
                          data-testid="paradigm-cell"
                          data-highlight={hit || undefined}
                          className={clsx(
                            'px-3 py-1.5',
                            hit && 'bg-[var(--primary-soft)] font-semibold text-primary',
                          )}
                        >
                          {cell.forms.length > 0 ? (
                            <TargetText>{cell.forms.join(', ')}</TargetText>
                          ) : (
                            <span className="text-muted-foreground/60" aria-label="not listed">
                              —
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {paradigm.other.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Other forms
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {paradigm.other.map((o) => (
              <div key={o.label} className="contents">
                <dt className="text-xs text-muted-foreground">{o.label}</dt>
                <dd>
                  <TargetText>{o.forms.join(', ')}</TargetText>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        From the on-device dictionary. A dash marks a form it does not list.
      </p>
    </div>
  );
}
