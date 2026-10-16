/**
 * Opening Drill → Tree: the repertoire as a living tree (drill_tab.py's tree
 * methods, without the widgets). Pick a scope (every opening of a colour, or
 * one repertoire), click a move to see it on the board, step along a line,
 * grow and save a new branch, answer Lichess players' popular replies or your
 * opponents' deviations, move where an opening starts, delete a branch,
 * Stockfish's ideas, and Drill this line. The drawing is TreeView.tsx.
 */
import { Board, type Color, WHITE } from '../core/chess';
import type { Engine } from '../core/engine';
import { type Idea, IdeasEngine } from '../core/engineIdeas';
import * as explorer from '../core/explorer';
import { formatMoveList } from '../core/drill';
import type { OpeningLine, PlayerColor } from '../core/models';
import * as openingTree from '../core/openingTree';
import type { Node, Tree } from '../core/openingTree';
import type { DbClient } from '../data/client';
import type { DrillView, RepertoireEntry } from '../data/drillServices';
import type { MyDeviationView, MyGamesReport, OpponentDeviationView } from '../data/myGamesServices';
import { IDEA_BRUSHES, ideaRows } from './analysis';
import type { Arrow } from './Board';
import { LIKELY_TEXT, moveLabel, posKey, shortName, variationName } from './treeHelpers';

export const ALL_SCOPE: Record<PlayerColor, string> = { white: 'All White openings', black: 'All Black openings' };
export const TOP_STARS = 3;            // moves named under the tree per star (the rest: "+N more")

export type Tone = 'normal' | 'success' | 'error' | 'muted';

/** What the tree needs from the drill screen around it. */
export interface TreeHost {
  setStatus(text: string, tone?: Tone): void;
  setMoveNote(text: string): void;
  setTitle(text: string): void;
  changed(): void;
  repertoires(): RepertoireEntry[];
  selected(): RepertoireEntry | null;
  lichessConnected(): boolean;
  drill(): DrillView | null;          // a live drill (null when none or finished)
  drillShown(): boolean;              // a drill (maybe finished) is on the board
  stopDrill(): void;
  drillLine(name: string, color: PlayerColor, ids: string[]): Promise<void>;
  refreshRepertoires(): Promise<void>;
  askName(title: string, text: string, suggestion: string): Promise<string | null>;
  confirm(title: string, text: string): Promise<boolean>;
  showMyDeviation(d: MyDeviationView): void;
}

export class TreeController {
  scope = '';
  scopeOptions: string[] = [];
  tree: Tree | null = null;
  node: Node | null = null;
  focus: OpeningLine[] = [];             // the line ◀ ▶ walk along
  draft: string[] = [];                  // a new branch played from node (not saved)
  pvAhead: string[] = [];                // the rest of a Stockfish line being stepped through
  starts: [string, Node][] = [];         // (repertoire, where its opening starts)
  deviations = new Map<Node, openingTree.Deviation[]>();
  myDevs = new Map<Node, MyDeviationView[]>();
  oppDevs = new Map<Node, OpponentDeviationView[]>();
  showBefore = true;
  mode: 'moves' | 'drawing' = 'moves';   // the move list (easier to read) or the tree drawing
  // filtering the openings shown: by name (search), and by opening (hide some)
  filterText = '';
  hiddenOpenings = new Set<string>();
  openingNames: string[] = [];           // the openings in this scope (one button each)
  lineCounts = { shown: 0, total: 0 };
  private allLines: OpeningLine[] = [];  // the scope's moves, before filtering
  private startPaths: Record<string, string[]> = {};
  ideasOn = false;
  zoom = true;
  sidelinesHidden = false;               // the drawing had no room for the selected position's sidelines
  ideas: Idea[] = [];
  ideasHeader = '';
  ideasRows: string[] = [];
  lineLabel = '';
  movesLabel = '';
  devLabel = '';
  /** The board while exploring. */
  board: { fen: string; lastMove: string | null; orientation: Color; arrows: Arrow[] } =
    { fen: Board.fromFen().fen(), lastMove: null, orientation: 'white', arrows: [] };
  report: MyGamesReport | null = null;

  private ideasEngine: IdeasEngine | null;
  private ideasFen: string | null = null;
  private refreshToken: object | null = null;
  private visible = false;               // the Tree view is showing

  constructor(private readonly client: DbClient, private readonly host: TreeHost, engine: Engine | null) {
    this.ideasEngine = engine ? new IdeasEngine(engine, (fen, depth, ideas) => this.onIdeas(fen, depth, ideas),
      (message) => { this.ideasHeader = message; this.ideasRows = []; this.host.changed(); }) : null;
  }

  async init(): Promise<void> {
    const s = await this.client.service('getSettings', ['tree_scope', 'tree_show_before', 'tree_ideas', 'tree_zoom', 'tree_view', 'tree_filter']);
    this.mode = s.tree_view === 'drawing' ? 'drawing' : 'moves';
    try {
      const f = JSON.parse(s.tree_filter || '{}');
      this.filterText = typeof f.text === 'string' ? f.text : '';
      this.hiddenOpenings = new Set(Array.isArray(f.hidden) ? f.hidden : []);
    } catch {
      /* no filter saved */
    }
    this.scope = s.tree_scope || '';
    this.showBefore = s.tree_show_before !== '0';
    this.ideasOn = s.tree_ideas === '1';
    this.zoom = s.tree_zoom !== '0';
  }

  /** The board is showing a tree position (not a drill). */
  exploring(): boolean {
    return this.visible && this.tree !== null && this.node !== null && !this.host.drillShown();
  }

  // ---------- scope ----------

  private options(): string[] {
    const reps = this.host.repertoires();
    const colors = (['white', 'black'] as PlayerColor[]).filter((c) => reps.some((r) => r.color === c));
    return [...colors.map((c) => ALL_SCOPE[c]), ...reps.filter((r) => !r.group).map((r) => r.label)];
  }

  /** [repertoire name or null for all of a colour, colour] — or null. */
  scopeValue(): [string | null, PlayerColor] | null {
    for (const [color, label] of Object.entries(ALL_SCOPE) as [PlayerColor, string][]) if (this.scope === label) return [null, color];
    const rep = this.host.repertoires().find((r) => r.label === this.scope && !r.group);
    return rep ? [rep.name, rep.color] : null;
  }

  private scopeRepertoires(): string[] {
    const scope = this.scopeValue();
    if (!scope) return [];
    const [name, color] = scope;
    return name ? [name] : this.host.repertoires().filter((r) => r.color === color && !r.group).map((r) => r.name);
  }

  /** The scope for what's being drilled (its own repertoire) — or, with no drill, what Setup has picked. */
  private scopeToMatch(): string | null {
    const d = this.host.drill();
    const options = this.options();
    if (d) {
      const label = `${d.repertoire} (${d.myColor})`;
      return options.includes(label) ? label : null;
    }
    const sel = this.host.selected();
    if (!sel) return null;
    if (sel.group) return ALL_SCOPE[sel.color];
    return options.includes(sel.label) ? sel.label : null;
  }

  async setScope(value: string): Promise<void> {
    this.scope = value;
    await this.client.service('setSettings', { tree_scope: value });
    this.clearDraft();
    await this.refresh();
  }

  /** The Tree view shown: the tree of what you're drilling (or picked in Setup). */
  async onShown(): Promise<void> {
    this.visible = true;
    const wanted = this.scopeToMatch();
    if (wanted !== null && wanted !== this.scope) {
      this.scope = wanted;
      this.clearDraft();
      await this.refresh();
    } else if (this.tree === null) {
      await this.refresh();
    } else if (this.host.drill()) {
      this.followDrill();
    } else if (this.node) {
      this.show(this.node, false);
    }
  }

  onHidden(): void {
    this.visible = false;
    this.clearIdeas();
  }

  /** The repertoire or its lines changed: regrow the tree next time it shows
   *  (or now, by whoever changed them from the tree). */
  invalidate(): void {
    this.tree = null;
  }

  async refresh(): Promise<void> {
    this.scopeOptions = this.options();
    if (!this.scopeOptions.includes(this.scope)) {
      const sel = this.host.selected();
      this.scope = sel ? ALL_SCOPE[sel.color] : this.scopeOptions[0] ?? '';
    }
    const scope = this.scopeValue();
    if (!scope) {
      this.tree = null;
      this.node = null;
      this.lineLabel = 'No repertoire yet';
      this.movesLabel = 'Add some lines (Add lines) to grow a tree.';
      this.devLabel = '';
      this.host.changed();
      return;
    }
    const [name, color] = scope;
    // everything is read first and the tree swapped in at once: a click on a tree that's
    // still loading can't be undone by the end of its loading; a newer refresh wins
    const token = {};
    this.refreshToken = token;
    const lines = await this.client.service('treeLines', name, color);
    const reps = this.scopeRepertoires();
    const paths = await this.client.service('treeStarts', reps, color);
    if (this.refreshToken !== token) return;
    this.allLines = lines;
    this.startPaths = paths;
    this.openingNames = [...new Set(lines.map((l) => l.repertoire_name))].sort();
    await this.rebuild(token, null);
  }

  /** The tree from the scope's moves, filtered; selects `keep` (moves) if it's still
   *  in the tree, else the start (or follows the drill). */
  private async rebuild(token: object, keep: string[] | null): Promise<void> {
    const scope = this.scopeValue();
    if (!scope) return;
    const color = scope[1];
    const lines = this.filtered();
    const tree = openingTree.buildFromLines(lines, color);
    const starts: [string, Node][] = [];
    for (const rep of this.scopeRepertoires()) {
      const node = tree.nodeForPath(this.startPaths[rep] ?? []);
      if (node && node.lines().length) starts.push([rep, node]);
    }
    const deviations = await this.deviationsFor(tree, color);
    if (this.refreshToken !== token) return;
    this.tree = tree;
    this.starts = starts;
    this.deviations = deviations;
    this.lineCounts = { shown: tree.leaves.length, total: openingTree.buildFromLines(this.allLines, color).leaves.length };
    this.focus = tree.leaves[0]?.[1] ?? [];
    this.updateMyDeviations();
    const kept = keep ? tree.nodeForPath(keep) : null;
    if (this.host.drill()) this.followDrill();     // don't touch a drill's board: just show where it is
    else if (kept) {
      this.focus = kept.lines()[0]?.[1] ?? this.focus;
      this.show(kept, false);
    } else this.show(tree.root, false);
  }

  /** Whole imported lines (a root and everything under it) whose opening is shown and whose
   *  name (or opening's name) contains the search text. */
  private filtered(): OpeningLine[] {
    const text = this.filterText.trim().toLowerCase();
    if (!text && !this.hiddenOpenings.size) return this.allLines;
    const byId = new Map(this.allLines.map((l) => [l.id, l]));
    const rootOf = new Map<string, OpeningLine>();
    const root = (l: OpeningLine): OpeningLine => {
      const known = rootOf.get(l.id);
      if (known) return known;
      const parent = l.parent_id ? byId.get(l.parent_id) : undefined;
      const r = parent ? root(parent) : l;
      rootOf.set(l.id, r);
      return r;
    };
    const shown = (r: OpeningLine) => !this.hiddenOpenings.has(r.repertoire_name)
      && (!text || (r.line_name ?? '').toLowerCase().includes(text) || r.repertoire_name.toLowerCase().includes(text));
    return this.allLines.filter((l) => shown(root(l)));
  }

  /** The filter changed: the tree again (keeping the position shown when it's still there). */
  private async applyFilter(): Promise<void> {
    await this.client.service('setSettings', { tree_filter: JSON.stringify({ text: this.filterText, hidden: [...this.hiddenOpenings] }) });
    if (this.draft.length) this.clearDraft();
    const token = {};
    this.refreshToken = token;
    await this.rebuild(token, this.node ? this.node.path.map((m) => m.move_uci) : null);
  }

  async setFilterText(text: string): Promise<void> {
    this.filterText = text;
    await this.applyFilter();
  }

  async toggleOpening(name: string): Promise<void> {
    if (this.hiddenOpenings.has(name)) this.hiddenOpenings.delete(name);
    else this.hiddenOpenings.add(name);
    await this.applyFilter();
  }

  /** Only this opening (click again: all of them). */
  async onlyOpening(name: string): Promise<void> {
    const others = this.openingNames.filter((n) => n !== name);
    const alreadyOnly = others.every((n) => this.hiddenOpenings.has(n)) && !this.hiddenOpenings.has(name);
    this.hiddenOpenings = alreadyOnly ? new Set() : new Set(others);
    await this.applyFilter();
  }

  async clearFilter(): Promise<void> {
    this.filterText = '';
    this.hiddenOpenings = new Set();
    await this.applyFilter();
  }

  filtering(): boolean {
    return !!this.filterText.trim() || this.openingNames.some((n) => this.hiddenOpenings.has(n));
  }

  // ---------- selecting and showing a position ----------

  /** A click in the tree: show that position (this ends a drill in progress).
   *  keepLine: stepping along a Stockfish line, not leaving it. */
  async select(node: Node, keepLine = false): Promise<boolean> {
    if (!keepLine) this.pvAhead = [];
    if (this.draft.length && !(await this.host.confirm('Discard new branch?', "You have a new branch that isn't saved. Discard it?"))) {
      return false;
    }
    this.clearDraft();
    if (this.host.drillShown()) this.host.stopDrill();
    const lines = node.lines();
    // keep following the current line if the new position is on it
    const onFocus = this.focus.length && this.focus.slice(0, node.ply).map((n) => n.move_uci).join(' ')
      === node.path.map((n) => n.move_uci).join(' ');
    if (!onFocus && lines.length) this.focus = lines[0][1];
    this.show(node, false);
    return true;
  }

  private focusName(): string | null {
    const key = this.focus.map((n) => n.id).join(' ');
    return this.tree?.leaves.find(([, path]) => path.map((n) => n.id).join(' ') === key)?.[0] ?? null;
  }

  private scopeName(): string {
    return this.scopeValue()?.[0] ?? '';
  }

  /** follow: called from a live drill (the board is the drill's). */
  show(node: Node, follow: boolean): void {
    this.node = node;
    const line = this.focusName();
    this.lineLabel = line ? variationName(line) : '';
    const board = Board.fromFen();
    const sans: string[] = [];
    for (const n of node.path) {
      const prefix = board.turn === WHITE ? `${board.fullmoveNumber}.` : !sans.length ? `${board.fullmoveNumber}...` : '';
      sans.push(prefix + board.san(n.move_uci));
      board.push(n.move_uci);
    }
    const count = node.lines().length;
    this.movesLabel = `${sans.length ? sans.join(' ') : 'Starting position'}   ·   ${count} line${count !== 1 ? 's' : ''} from here`;
    this.showNodeDeviations(node);
    if (follow) {
      this.host.changed();
      return;
    }
    this.board = { fen: board.fen(), lastMove: node.move?.move_uci ?? null, orientation: this.scopeValue()?.[1] ?? 'white', arrows: [] };
    this.requestIdeas(board);
    this.host.setTitle(line ? `Exploring: ${variationName(line)}` : 'Exploring');
    this.host.setStatus('Exploring the tree — Drill this line to practise it.', 'muted');
    this.host.setMoveNote(node.move?.notes ?? '');
    this.host.changed();
  }

  // ---------- Lichess deviations ----------

  /** Popular Lichess replies your lines don't cover, from the cached explorer data. */
  private async deviationsFor(tree: Tree, color: PlayerColor): Promise<Map<Node, openingTree.Deviation[]>> {
    if (!this.host.lichessConnected()) return new Map();
    const fens: string[] = [];
    const stack = [tree.root];
    while (stack.length) {
      const n = stack.pop()!;
      stack.push(...n.children);
      if (n.children.length) fens.push(n.board().fen());
    }
    const { stats } = await this.client.service('explorerStats', fens);
    return openingTree.deviations(tree, (fen) => (stats[fen] ? explorer.fromPlain(stats[fen]) : null), color);
  }

  async updateDeviations(): Promise<void> {
    const scope = this.scopeValue();
    this.deviations = this.tree && scope ? await this.deviationsFor(this.tree, scope[1]) : new Map();
    this.updateMyDeviations();
    if (this.node) this.showNodeDeviations(this.node);
    this.host.changed();
  }

  /** Stars from your games: red where you left your prep, blue where your opponent did. */
  updateMyDeviations(): void {
    const scope = this.scopeValue();
    this.myDevs = new Map();
    this.oppDevs = new Map();
    if (!this.tree || !scope || !this.report) return;
    const mine = scope[1];
    const yours = new Map<string, MyDeviationView[]>();
    const theirs = new Map<string, OpponentDeviationView[]>();
    for (const d of this.report.deviations) {
      if (d.color === mine) yours.set(posKey(d.fen), [...(yours.get(posKey(d.fen)) ?? []), d]);
    }
    for (const o of this.report.opponentDeviations) {
      if (o.color === mine) theirs.set(posKey(o.fen), [...(theirs.get(posKey(o.fen)) ?? []), o]);
    }
    const stack = [this.tree.root];
    while (stack.length) {
      const node = stack.pop()!;
      stack.push(...node.children);
      const board = node.board();
      const key = posKey(board.fen());
      if (board.turn === mine) {
        const found = yours.get(key);
        if (found) this.myDevs.set(node, found);
      } else {
        const found = theirs.get(key);
        if (found) this.oppDevs.set(node, found);
      }
    }
  }

  setReport(report: MyGamesReport | null): void {
    this.report = report;
    this.updateMyDeviations();
    if (this.node) this.showNodeDeviations(this.node);
    this.host.changed();
  }

  private myDevText(node: Node): string {
    const lines: string[] = [];
    const devs = [...(this.myDevs.get(node) ?? [])].sort((a, b) => b.games - a.games);
    if (devs.length) {
      const parts = devs.slice(0, TOP_STARS).map((d) => `${d.playedSan} ${d.games}×`);
      const more = devs.length > TOP_STARS ? ` +${devs.length - TOP_STARS} more` : '';
      lines.push(`★ You left your prep (red): ${parts.join(' · ')}${more} — click the star for why.`);
    }
    const opps = [...(this.oppDevs.get(node) ?? [])].sort((a, b) => b.games - a.games);
    if (opps.length) {
      const parts = opps.slice(0, TOP_STARS).map((o) => `${o.playedSan} ${o.games}× (${Math.round(o.record.score * 100)}%)`);
      const more = opps.length > TOP_STARS ? ` +${opps.length - TOP_STARS} more` : '';
      lines.push(`★ Opponents left your prep (blue): ${parts.join(' · ')}${more} — click the star to answer the top one.`);
    }
    return lines.join('\n');
  }

  inside(node: Node): boolean {
    return !this.starts.length || this.starts.some(([, start]) => openingTree.isInside(node, start));
  }

  private showNodeDeviations(node: Node): void {
    this.devLabel = this.lichessDeviationsText(node);
    const mine = this.myDevText(node);
    if (mine) this.devLabel = this.devLabel ? `${mine}\n${this.devLabel}` : mine;
  }

  private lichessDeviationsText(node: Node): string {
    if (!this.host.lichessConnected()) return 'Connect Lichess (Add lines → Connect Lichess…) to see where players leave these lines.';
    const devs = this.deviations.get(node) ?? [];
    const before = !this.inside(node);
    const reps = [...new Set(node.lines().map(([, p]) => p[0].repertoire_name))].sort();
    const which = reps.length === 1 ? reps[0] : 'openings';
    const pct = (s: number) => `${Math.round(s * 100)}%`;
    if (devs.length && before) {
      return `Before your ${which} start${reps.length === 1 ? 's' : ''} — other openings Lichess players choose here: `
        + devs.map((d) => `${d.san} ${pct(d.share)}`).join(' · ') + '.';
    }
    if (devs.length) {
      const where = this.sidelinesHidden ? '  — no room for them in the tree here: tick Zoom in to see and answer them.'
        : `  — click one in the tree to answer it (${LIKELY_TEXT}).`;
      return `Lichess players here also play: ${devs.map((d) => `${d.san} ${pct(d.share)}`).join(' · ')}${where}`;
    }
    let total = 0;
    for (const v of this.deviations.values()) total += v.length;
    return total ? `${total} popular deviation${total !== 1 ? 's' : ''} from these lines (grey rings — select one to see them).`
      : 'No popular deviations found yet (data downloads in the background).';
  }

  /** The drawing found no room for the sidelines (or found it again). */
  setSidelinesHidden(hidden: boolean): void {
    if (hidden === this.sidelinesHidden) return;
    this.sidelinesHidden = hidden;
    if (this.node) this.showNodeDeviations(this.node);
    this.host.changed();
  }

  // ---------- toggles ----------

  async setShowBefore(on: boolean): Promise<void> {
    this.showBefore = on;
    await this.client.service('setSettings', { tree_show_before: on ? '1' : '0' });
    this.host.changed();
  }

  async setMode(mode: 'moves' | 'drawing'): Promise<void> {
    this.mode = mode;
    this.sidelinesHidden = false;
    await this.client.service('setSettings', { tree_view: mode });
    if (this.node) this.showNodeDeviations(this.node);
    this.host.changed();
  }

  async setZoom(on: boolean): Promise<void> {
    this.zoom = on;
    await this.client.service('setSettings', { tree_zoom: on ? '1' : '0' });
    this.host.changed();
  }

  async setIdeas(on: boolean): Promise<void> {
    this.ideasOn = on;
    await this.client.service('setSettings', { tree_ideas: on ? '1' : '0' });
    if (on) {
      if (this.exploring()) this.requestIdeas(Board.fromFen(this.board.fen));
    } else {
      this.clearIdeas();
    }
    this.host.changed();
  }

  // ---------- Stockfish's ideas ----------

  private requestIdeas(board: Board): void {
    if (!this.ideasOn || !this.exploring()) return;
    if (!this.ideasEngine) {
      this.ideasHeader = 'Stockfish not found.';
      return;
    }
    this.ideasFen = board.fen();
    this.ideas = [];
    this.ideasHeader = 'Stockfish is thinking…';
    this.ideasRows = [];
    this.ideasEngine.analyse(this.ideasFen);
  }

  private onIdeas(fen: string, depth: number, ideas: Idea[]): void {
    if (fen !== this.ideasFen || !this.ideasOn || !this.exploring()) return;   // moved on, switched off, or drilling now
    this.ideas = ideas;
    if (!ideas.length) {
      this.ideasHeader = 'No moves — the game is over here.';
      this.ideasRows = [];
      this.board = { ...this.board, arrows: [] };
    } else {
      this.ideasHeader = `Stockfish, depth ${depth} — arrows as coloured below · click a line, then ▶`;
      this.ideasRows = ideaRows(fen, ideas);
      this.board = { ...this.board, arrows: ideas.map((i, k) => ({ from: i.move.slice(0, 2), to: i.move.slice(2, 4), brush: IDEA_BRUSHES[k] })) };
    }
    this.host.changed();
  }

  private clearIdeas(): void {
    this.ideasFen = null;
    this.ideas = [];
    this.ideasHeader = '';
    this.ideasRows = [];
    this.board = { ...this.board, arrows: [] };
  }

  showsIdeas(): boolean {
    return this.ideasOn && this.exploring() && !!this.ideasHeader;
  }

  /** A Stockfish line clicked: play its first move; ▶ plays on along it. */
  async followIdea(i: number): Promise<void> {
    if (i >= this.ideas.length || !this.exploring()) return;
    const pv = this.ideas[i].pv;
    await this.playLineMove(pv[0], pv.slice(1));
  }

  /** A move while exploring — into the tree if your lines have it, else a new
   *  branch — keeping `ahead` (the rest of a Stockfish line) for ▶. */
  private async playLineMove(move: string, ahead: string[]): Promise<void> {
    const node = this.node!;
    if (!this.draft.length) {
      const child = node.children.find((c) => c.move!.move_uci === move);
      if (child) {
        await this.select(child, true);
        this.pvAhead = [...ahead];
        this.noteFollowing();
        return;
      }
    }
    const board = this.draftBoard();
    if (!board.isLegal(move)) return;
    this.draft.push(move);
    this.pvAhead = [...ahead];
    this.showDraft();
    this.noteFollowing();
  }

  private noteFollowing(): void {
    if (this.pvAhead.length) {
      this.host.setStatus(`Following Stockfish's line — ▶ for the next move (${this.pvAhead.length} more)`
        + (this.draft.length ? ', Save branch to keep it.' : '.'), 'muted');
      this.host.changed();
    }
  }

  // ---------- stepping ----------

  /** ◀ / ▶ (or ← / →, or the wheel): back to the parent, or on along the current
   *  line. With a new branch: ◀ takes back its last move. */
  async step(delta: number): Promise<void> {
    if (!this.tree || !this.node) return;
    if (delta > 0 && this.pvAhead.length) {              // on along Stockfish's line
      await this.playLineMove(this.pvAhead[0], this.pvAhead.slice(1));
      return;
    }
    const following = this.pvAhead.length > 0 || this.draft.length > 0;
    if (this.draft.length) {
      if (delta < 0) {
        const back = this.draft.pop()!;
        if (following) this.pvAhead.unshift(back);       // ▶ plays it again
        const keep = [...this.pvAhead];
        if (this.draft.length) this.showDraft();
        else this.discardDraft();
        this.pvAhead = keep;
        this.noteFollowing();
      }
      return;
    }
    const node = this.node;
    if (delta < 0 && this.pvAhead.length && node.parent) {
      const keep = [node.move!.move_uci, ...this.pvAhead];
      await this.select(node.parent, true);
      this.pvAhead = keep;
      this.noteFollowing();
      return;
    }
    let target: Node | null;
    if (delta < 0) target = node.parent;
    else {
      const next = this.focus[node.ply];
      target = node.children.find((c) => next && c.move!.move_uci === next.move_uci) ?? node.children[0] ?? null;
    }
    if (target) await this.select(target);
  }

  // ---------- growing a new branch ----------

  private draftBoard(): Board {
    const board = this.node!.board();
    for (const m of this.draft) board.push(m);
    return board;
  }

  /** A move on the board while exploring: follow it if it's in the repertoire, else start (or extend) a new branch. */
  async exploreMove(move: string): Promise<void> {
    if (!this.node) return;
    const board = this.draftBoard();
    if (!board.isLegal(move)) return;
    if (this.pvAhead.length && move === this.pvAhead[0]) {         // the move Stockfish's line goes on with
      await this.playLineMove(move, this.pvAhead.slice(1));
      return;
    }
    this.pvAhead = [];                                              // a different move: off Stockfish's line
    if (!this.draft.length) {
      const child = this.node.children.find((c) => c.move!.move_uci === move);
      if (child) {
        await this.select(child);
        return;
      }
    }
    this.draft.push(move);
    this.showDraft();
  }

  /** '7.b3', 'b6', '8.Bb2' — Black's move numbered only when it comes first. */
  draftSans(): string[] {
    const board = this.node!.board();
    return this.draft.map((m, i) => {
      const n = board.fullmoveNumber;
      const prefix = board.turn === WHITE ? `${n}.` : i === 0 ? `${n}...` : '';
      const san = prefix + board.san(m);
      board.push(m);
      return san;
    });
  }

  private showDraft(): void {
    const board = this.draftBoard();
    this.board = { fen: board.fen(), lastMove: this.draft.at(-1) ?? null, orientation: this.board.orientation, arrows: [] };
    this.requestIdeas(board);
    const sans = this.draftSans();
    this.lineLabel = 'New branch';
    this.movesLabel = sans.join(' ');
    this.host.setTitle('Exploring: new branch');
    this.host.setStatus('New branch — play moves for both sides, then Save branch. ◀ takes a move back.', 'muted');
    this.host.setMoveNote('');
    void this.draftReplies(board);
    this.host.changed();
  }

  /** At the end of a new branch: what players at your level play here (cached data only). */
  private async draftReplies(board: Board): Promise<void> {
    this.devLabel = '';
    if (!this.host.lichessConnected()) return;
    const fen = board.fen();
    const { describe, stats } = await this.client.service('explorerStats', [fen]);
    if (this.draftBoard().fen() !== fen) return;
    const s = stats[fen] ? explorer.fromPlain(stats[fen]) : null;
    if (!s || !s.games) return;
    const usual = [...s.moves].sort((a, b) => b.games - a.games).slice(0, 5);
    const scope = this.scopeValue();
    const myTurn = scope !== null && board.turn === scope[1];
    this.devLabel = `Players ${describe} ${myTurn ? 'usually play' : 'usually reply'} here: `
      + usual.map((m) => `${board.san(m.uci)} ${Math.round((m.games / s.games) * 100)}%`).join(' · ')
      + ' — play one on the board to grow the branch.';
    this.host.changed();
  }

  private clearDraft(): void {
    this.draft = [];
  }

  discardDraft(): void {
    this.pvAhead = [];
    this.clearDraft();
    if (this.node) this.show(this.node, false);
  }

  /** The new branch into the repertoire of the line it branches off, as its own line. */
  async saveDraft(): Promise<void> {
    const selection = this.lineRepertoire();
    if (!this.draft.length || !selection || !this.node) return;
    const [repName, color] = selection;
    const board = Board.fromFen();
    const sans: string[] = [];
    for (const m of [...this.node.path.map((n) => n.move_uci), ...this.draft]) {
      sans.push(board.san(m));
      board.push(m);
    }
    const ucis = [...board.moveStack];
    const line = this.focusName();
    const base = line ? shortName(line, repName) : repName;
    const suggestion = `${base} — ${this.draftSans()[0]}`;
    const typed = await this.host.askName('Save new branch', `Name for this line (leave empty for “${suggestion}”):`, suggestion);
    if (typed === null) return;                       // cancelled: keep the branch
    const name = (typed.trim() || suggestion).replaceAll('"', "'");
    const pgn = `[Event "${repName} - ${name}"]\n\n${formatMoveList(sans)} *\n`;
    await this.client.service('importPgn', pgn, repName, color);
    this.clearDraft();
    await this.host.refreshRepertoires();             // regrows the tree with the new line
    if (!this.tree) await this.refresh();
    const created = this.tree?.nodeForPath(ucis) ?? null;
    if (created) {
      this.focus = created.lines()[0]?.[1] ?? this.focus;
      this.show(created, false);
    }
    this.host.setStatus(`Saved “${name}” to ${repName}.`, 'success');
    this.host.changed();
  }

  /** [repertoire, colour] of the line the tree is following. */
  private lineRepertoire(): [string, PlayerColor] | null {
    const scope = this.scopeValue();
    if (!scope) return null;
    if (this.focus.length) return [this.focus[0].repertoire_name, scope[1]];
    const reps = this.scopeRepertoires();
    return reps.length ? [reps[0], scope[1]] : null;
  }

  async drillThisLine(): Promise<void> {
    const selection = this.lineRepertoire();
    if (!selection || !this.focus.length) return;
    this.clearIdeas();
    await this.host.drillLine(selection[0], selection[1], this.focus.map((n) => n.id));
  }

  /** While drilling, the tree's marker moves along with the board. */
  followDrill(): void {
    const d = this.host.drill();
    if (!this.tree || !d) return;
    const node = this.tree.nodeForPath(d.moves);
    if (node) {
      const ids = d.path.map((n) => n.id);
      const leaf = this.tree.leaves.find(([, path]) => path.map((n) => n.id).join(' ') === ids.join(' '));
      if (leaf) this.focus = leaf[1];
      this.show(node, true);
    }
  }

  // ---------- Lichess replies and your opponents' moves ----------

  /** A Lichess sideline clicked: start a new branch with that reply. */
  async onDeviation(node: Node, uci: string): Promise<void> {
    if (!(await this.select(node)) || this.node !== node) return;
    this.draft = [uci];
    this.showDraft();
    this.host.setStatus('Their reply is on the board — play your answer, then Save branch.', 'muted');
    this.host.changed();
  }

  /** A star clicked: yours opens its why (My games); an opponent's starts a branch with their move. */
  async onStar(dev: MyDeviationView | OpponentDeviationView): Promise<void> {
    if ('prefix' in dev) {
      this.host.showMyDeviation(dev);
      return;
    }
    const target = this.findPosition(dev.fen);
    if (!target || !(await this.select(target)) || this.node !== target) return;
    this.draft = [dev.playedUci];
    this.showDraft();
    const usual = dev.usualReply ? ` You usually answered ${dev.usualReply}.` : '';
    this.host.setStatus(`Your opponents played ${dev.playedSan} here ${dev.games}× (your prep expects ${dev.prepSans.join('/')}); `
      + `you scored ${Math.round(dev.record.score * 100)}%.${usual} Play your answer, then Save branch.`, 'muted');
    this.host.changed();
  }

  /** Your deviation (from My games) on all of that colour's openings, as a temporary branch. */
  async showMyDeviationOnTree(d: MyDeviationView, best: string | null): Promise<boolean> {
    const wanted = ALL_SCOPE[d.color as PlayerColor];
    if (this.scope !== wanted || !this.tree) await this.setScope(wanted);
    const node = this.findPosition(d.fen);
    if (!node) {
      this.host.setStatus("That position isn't on this tree (your prep reaches it by another move order) — open it from Setup instead.", 'muted');
      this.host.changed();
      return false;
    }
    if (!(await this.select(node)) || this.node !== node) return true;
    this.draft = [d.playedUci];
    this.showDraft();
    const tip = best ? ` Works best at your level: ${best} — ◀ and play it to compare.` : '';
    this.host.setStatus(`Your game move ${d.playedSan} as a temporary branch (your prep: ${d.prepSans.join('/')}). `
      + `Play on for both sides, ◀ to step back, Save branch to keep it, Discard to drop it.${tip}`, 'muted');
    this.host.changed();
    return true;
  }

  private findPosition(fen: string): Node | null {
    const key = posKey(fen);
    const stack = this.tree ? [this.tree.root] : [];
    while (stack.length) {
      const n = stack.pop()!;
      if (posKey(n.board().fen()) === key) return n;
      stack.push(...n.children);
    }
    return null;
  }

  // ---------- the right-click menu ----------

  /** The repertoires whose lines pass through here (for "starts here"). */
  contextRepertoires(node: Node): string[] {
    const reps = [...new Set(node.lines().map(([, p]) => p[0].repertoire_name))].sort();
    return reps.length ? reps : this.scopeRepertoires();
  }

  /** The first move of the branch this position is on (where it leaves the other lines). */
  branchStart(node: Node): Node | null {
    for (const b of this.tree?.branches ?? []) if (b.nodes.includes(node)) return b.nodes[0];
    return null;
  }

  async setOpeningStart(repertoire: string, node: Node | null): Promise<void> {
    const scope = this.scopeValue();
    if (!scope || !this.tree) return;
    await this.client.service('setOpeningStart', repertoire, scope[1], node ? node.path.map((m) => m.move_uci) : null);
    const paths = await this.client.service('treeStarts', [repertoire], scope[1]);
    const start = this.tree.nodeForPath(paths[repertoire] ?? []);
    this.starts = [...this.starts.filter(([r]) => r !== repertoire), ...(start ? [[repertoire, start] as [string, Node]] : [])];
    if (this.node) this.showNodeDeviations(this.node);
    this.host.changed();
  }

  /** Removes this move and everything after it from every line through it. */
  async deleteBranch(node: Node): Promise<void> {
    const lines = node.lines();
    if (!lines.length) return;
    const names = [...new Set(lines.map(([name]) => name))].sort();
    const shown = names.slice(0, 8).map((n) => `  • ${n}`).join('\n') + (names.length > 8 ? `\n  … and ${names.length - 8} more` : '');
    const others = node.parent ? node.parent.lines().length - lines.length : 0;
    const keep = others ? `\n\nThe moves before it stay, along with the ${others} other line(s) through them.` : '';
    if (!(await this.host.confirm('Delete branch', `Delete ${moveLabel(node)} and everything after it?\n\nThis removes ${lines.length} `
      + `line(s):\n${shown}${keep}\n\nThis can't be undone (re-import the PGN file to get lines back).`))) return;
    const ply = node.ply;
    const ids = [...new Set(lines.filter(([, path]) => path.length >= ply).map(([, path]) => path[ply - 1].id))];
    const removed = await this.client.service('deleteBranch', ids);
    const parentPath = node.path.slice(0, -1).map((m) => m.move_uci);
    this.clearDraft();
    await this.host.refreshRepertoires();
    if (!this.tree) await this.refresh();
    if (this.tree) {
      const back = this.tree.nodeForPath(parentPath) ?? this.tree.root;
      this.focus = back.lines()[0]?.[1] ?? [];
      this.show(back, false);
    }
    this.host.setStatus(`Deleted ${lines.length} line(s) (${removed} moves).`, 'muted');
    this.host.changed();
  }

  dispose(): void {
    this.ideasEngine?.stop();
  }
}
