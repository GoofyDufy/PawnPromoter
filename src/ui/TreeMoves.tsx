/**
 * The repertoire as an indented move list (an easier-to-read alternative to
 * the tree drawing, like a Lichess study): each branch on its own line,
 * indented under the move it leaves from, its line's name at the end. Branches
 * fold; the branches along the selected position are always open. Click a move
 * to see it on the board. Each opening's name stands once, where its lines
 * branch off on their own; the leaves show just the variation. Marks beside a move: ★ red (you left your prep here),
 * ★ blue (your opponents did), ↗ grey (Lichess players' popular replies your
 * lines don't cover), ⚑ (where an opening starts).
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Branch, Node } from '../core/openingTree';
import type { TreeController } from './treeController';
import { endName, familyRoots } from './treeHelpers';

const keyOf = (b: Branch) => b.nodes[0].path.map((m) => m.move_uci).join(' ');

export function TreeMoves({ t, onContext }: { t: TreeController; onContext: (node: Node, x: number, y: number) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const tree = t.tree;

  // keep the selected move in view
  useEffect(() => {
    box.current?.querySelector('.tm-move.selected')?.scrollIntoView({ block: 'nearest' });
  });

  if (!tree) return <div className="tree-moves note">{t.lineLabel || 'No repertoire yet'}</div>;

  // the branches holding the selected position (and the focus line) stay open
  const onPath = new Set<Node>();
  for (let n = t.node; n; n = n.parent) onPath.add(n);
  const starts = new Map(t.starts.map(([name, n]) => [n, name]));
  const families = familyRoots(tree);

  const isOpen = (b: Branch, depth: number) => {
    const k = keyOf(b);
    if (b.nodes.some((n) => onPath.has(n)) || b.children.some((c) => c.nodes.some((n) => onPath.has(n)))) return true;
    if (open.has(k)) return true;
    if (closed.has(k)) return false;
    return depth < 1;                                   // first moves' branches open, the rest folded
  };
  const toggle = (b: Branch, depth: number) => {
    const k = keyOf(b);
    if (isOpen(b, depth)) {
      setClosed(new Set([...closed, k]));
      setOpen(new Set([...open].filter((x) => x !== k)));
    } else {
      setOpen(new Set([...open, k]));
      setClosed(new Set([...closed].filter((x) => x !== k)));
    }
  };

  const label = (n: Node, first: boolean) => {
    const ply = n.ply;
    const san = n.move!.move_san;
    if (ply % 2 === 1) return `${(ply + 1) / 2}.${san}`;
    return first ? `${ply / 2}...${san}` : san;
  };

  const marks = (n: Node): ReactNode[] => {
    const out: ReactNode[] = [];
    const mine = t.myDevs.get(n);
    const theirs = t.oppDevs.get(n);
    const devs = t.deviations.get(n);
    if (starts.has(n) && n.parent?.move) out.push(<span key="s" className="tm-mark start" title={`${starts.get(n)} starts here`}>⚑</span>);
    if (mine?.length) {
      out.push(<button key="m" type="button" className="tm-mark mine" title="You left your prep here — click for why"
        onClick={(e) => { e.stopPropagation(); void t.onStar(mine[0]); }}>★{mine.reduce((s, d) => s + d.games, 0)}</button>);
    }
    if (theirs?.length) {
      const top = [...theirs].sort((a, b) => b.games - a.games)[0];
      out.push(<button key="o" type="button" className="tm-mark theirs" title={`Your opponents left your prep here (${top.playedSan} ${top.games}×) — click to answer it`}
        onClick={(e) => { e.stopPropagation(); void t.onStar(top); }}>★{theirs.reduce((s, d) => s + d.games, 0)}</button>);
    }
    if (devs?.length && (t.showBefore || t.inside(n))) {
      out.push(<span key="d" className={`tm-mark wild ${t.inside(n) ? '' : 'before'}`}
        title={`Lichess players here also play: ${devs.map((d) => `${d.san} ${Math.round(d.share * 100)}%`).join(' · ')} — select the move, then pick one under the list`}>↗{devs.length}</span>);
    }
    return out;
  };

  const renderBranch = (b: Branch, depth: number): ReactNode => {
    const ends = b.end.line_ends;
    const hasKids = b.children.length > 0;
    const opened = hasKids && isOpen(b, depth);
    return (
      <div key={keyOf(b)} className="tm-branch">
        <div className="tm-row">
          {hasKids ? <button type="button" className="tm-fold" aria-label={opened ? 'Fold' : 'Unfold'} aria-expanded={opened}
            onClick={() => toggle(b, depth)}>{opened ? '▾' : '▸'}</button> : <span className="tm-fold" />}
          <span className="tm-moves">
            {b.nodes.map((n, i) => (
              <span key={i} className="tm-step">
                {families.has(n) && <span className="tm-family">{families.get(n)!.label}</span>}
                <button type="button" className={`tm-move ${n === t.node ? 'selected' : onPath.has(n) ? 'on-path' : ''}`}
                  onClick={() => void t.select(n)} onContextMenu={(e) => { e.preventDefault(); onContext(n, e.clientX, e.clientY); }}>
                  {label(n, i === 0)}</button>
                {marks(n)}
              </span>
            ))}
            {ends.length > 0 && <span className="tm-name">{endName(b.end, ends[0][0], ends[0][1], families)}{ends.length > 1 ? ` +${ends.length - 1}` : ''}</span>}
            {hasKids && !opened && <span className="tm-more note">({b.end.lines().length} lines)</span>}
          </span>
        </div>
        {opened && <div className="tm-children">{b.children.map((c) => renderBranch(c, depth + 1))}</div>}
      </div>
    );
  };

  const tops = tree.branches.filter((b) => b.parent === null);
  return (
    <div className="tree-moves" ref={box}>
      <div className="row tm-tools">
        <button type="button" className={`tm-move ${t.node === tree.root ? 'selected' : ''}`} onClick={() => void t.select(tree.root)}>Start</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost small" onClick={() => { setOpen(new Set(tree.branches.map(keyOf))); setClosed(new Set()); }}>Unfold all</button>
        <button type="button" className="btn ghost small" onClick={() => { setClosed(new Set(tree.branches.map(keyOf))); setOpen(new Set()); }}>Fold all</button>
      </div>
      {families.has(tree.root) && <div className="tm-family-head">{families.get(tree.root)!.label}</div>}
      {tops.map((b) => renderBranch(b, 0))}
      {t.draft.length > 0 && <div className="tm-draft">New branch: {t.draftSans().join(' ')}</div>}
      {t.node && (t.deviations.get(t.node)?.length ?? 0) > 0 && (
        <div className="tm-sidelines">
          <span className="note">Lichess players here also play:</span>
          {t.deviations.get(t.node)!.map((d) => (
            <button key={d.uci} type="button" className="chip" onClick={() => void t.onDeviation(t.node!, d.uci)}
              title="Start a new branch with this reply">{d.san} {Math.round(d.share * 100)}%</button>
          ))}
        </div>
      )}
    </div>
  );
}
