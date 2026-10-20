/**
 * A table of rows (stats_tab.py's Treeview sections): click a column heading
 * to sort (again to reverse; numbers like "54%" or "2.1" sort as numbers),
 * click a row to select it, double-click to act on it.
 */
import { useMemo, useState } from 'react';
import type { Table } from '../data/statsServices';

function sortValue(text: string): [number, number | string] {
  const n = Number(text.replace(/%$/, '').replace('−', '-'));
  return text !== '' && Number.isFinite(n) ? [0, n] : [1, text.toLowerCase()];
}

export function DataTable({ table, selected, onSelect, onOpen, maxRows, wide = [0], action }: {
  table: Table;
  /** A button at the end of each row (rows with an id). */
  action?: { label: string; onClick: (id: string) => void };
  selected?: string | null;
  onSelect?: (id: string) => void;
  onOpen?: (id: string) => void;
  maxRows?: number;
  /** Columns that take the spare width (names, lines). */
  wide?: number[];
}) {
  const [sort, setSort] = useState<{ col: number; reverse: boolean } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const out = [...table.rows].sort((a, b) => {
      const [ka, kb] = [sortValue(a.cells[sort.col]), sortValue(b.cells[sort.col])];
      return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
    });
    return sort.reverse ? out.reverse() : out;
  }, [table, sort]);
  return (
    <div className="data-table" style={maxRows ? { maxHeight: `${2.2 + maxRows * 1.75}em` } : undefined}>
      <table>
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th key={i} className={wide.includes(i) ? 'wide' : ''}
                onClick={() => setSort(sort?.col === i ? { col: i, reverse: !sort.reverse } : { col: i, reverse: false })}
                aria-sort={sort?.col === i ? (sort.reverse ? 'descending' : 'ascending') : undefined}>
                {c}{sort?.col === i ? (sort.reverse ? ' ▾' : ' ▴') : ''}
              </th>
            ))}
            {action && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} className={`${r.tone ?? ''} ${r.id && r.id === selected ? 'selected' : ''} ${onSelect && r.id ? 'clickable' : ''}`}
              onClick={() => r.id && onSelect?.(r.id)} onDoubleClick={() => r.id && onOpen?.(r.id)}>
              {r.cells.map((c, j) => <td key={j} className={wide.includes(j) ? 'wide' : c.startsWith('▰') || c.startsWith('▱') ? 'bar' : ''}>{c}</td>)}
              {action && <td className="row-action">{r.id && (
                <button type="button" className="btn secondary small" onClick={(e) => { e.stopPropagation(); action.onClick(r.id!); }}>{action.label}</button>
              )}</td>}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={table.columns.length + (action ? 1 : 0)} className="note">Nothing here yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
