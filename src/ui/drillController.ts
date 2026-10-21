/**
 * Opening Drill's logic — port of drill_tab.OpeningDrillTab's Setup / Plans /
 * Add lines views and the drill flow, without the widgets: pick a repertoire
 * and a variation, drill a line (the computer plays the other side, only the
 * line's own moves count), retry / reveal, show the full line and step
 * through it, the end-of-line recap. The session itself runs in the database
 * worker (drillServices.ts); this holds what the screen shows.
 * The Tree and My games views have controllers of their own (treeController.ts,
 * myGamesController.ts); this one owns the board and says whose it is.
 */
import { Board, type Color } from '../core/chess';
import type { Engine } from '../core/engine';
import { formatMoveList } from '../core/drill';
import * as openingNotes from '../core/openingNotes';
import type { PlayerColor } from '../core/models';
import type { DbClient } from '../data/client';
import type { DrillView, LichessStatus, RepertoireEntry, VariationEntry } from '../data/drillServices';
import type { LevelView } from '../data/level';
import type { MyDeviationView } from '../data/myGamesServices';
import type { Arrow } from './Board';
import { CoachIdeas } from './coachIdeas';
import { MyGamesController } from './myGamesController';
import type { OpeningData } from './openingData';
import { TreeController } from './treeController';
import { headOf, variationName } from './treeHelpers';

export const ADD_LINES = 'Add lines';
export const TREE = 'Tree';
export const MY_GAMES = 'My games';
export const VIEWS = ['Setup', 'Plans', TREE, MY_GAMES, ADD_LINES] as const;
export type View = (typeof VIEWS)[number];
export const OPPONENT_DELAY_MS = 300;     // before the computer's reply
export const AFTER_CORRECT_MS = 700;      // a right move stays on show this long

export type Tone = 'normal' | 'success' | 'error' | 'muted';

export interface PlansView {
  title: string;
  idea: string;
  sides: { heading: string; items: string[] }[];
  structure: string;
  watchOut: string[];
}

/** A question the screen asks in a dialog (the desktop's input / yes-no boxes). */
export type Prompt =
  | { kind: 'name'; title: string; text: string; suggestion: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; text: string; resolve: (v: boolean) => void };

export class DrillController {
  view: View = 'Setup';
  prompt: Prompt | null = null;
  title = '';                            // above the board (Drilling: … / Exploring: … / a deviation)
  tree: TreeController;
  myGames: MyGamesController;
  private showingDeviation = false;      // the board shows a My games deviation
  repertoires: RepertoireEntry[] = [];
  repertoire = '';                       // the Setup dropdown's label
  variations: VariationEntry[] = [];
  variation = 0;                         // index in variations
  preview = '';                          // the highlighted variation's moves
  plans: PlansView | null = null;
  lichess: LichessStatus | null = null;

  drill: DrillView | null = null;
  status: { text: string; tone: Tone } = { text: '', tone: 'muted' };
  moveNote = '';
  recap = '';
  showFullLine = false;
  previewIndex: number | null = null;    // stepping through the full line (null: the board follows the drill)
  awaitingRetry = false;                 // after a miss: Show correct move is offered (you can just play again)
  misses = 0;                            // bumped on each miss: the board puts the piece back
  offerRestart = false;                  // after Show correct move: Same line / New random line
  startLabel = 'Start drill';
  version = 0;

  private lineMissed = false;
  private followedAt = '';
  private kind: VariationEntry['kind'] = 'random';
  private token: object | null = null;   // a new line cancels the old one's pending replies
  private listeners = new Set<() => void>();

  constructor(
    private readonly client: DbClient,
    readonly openingData: OpeningData,
    private readonly onLevel: (level: LevelView) => void = () => {},
    engine: Engine | null = null,
  ) {
    this.tree = new TreeController(client, {
      setStatus: (text, tone) => this.setStatus(text, tone),
      setMoveNote: (text) => { this.moveNote = text; },
      setTitle: (text) => { this.title = text; this.showingDeviation = false; },
      changed: () => this.changed(),
      repertoires: () => this.repertoires,
      selected: () => this.selected(),
      lichessConnected: () => !!this.lichess?.connected,
      drill: () => (this.drill && !this.drill.finished ? this.drill : null),
      drillShown: () => this.drill !== null,
      stopDrill: () => this.stopDrill(),
      drillLine: (name, color, ids) => this.drillLine(name, color, ids),
      refreshRepertoires: () => this.refreshRepertoires(),
      askName: (title, text, suggestion) => new Promise((resolve) => this.ask({ kind: 'name', title, text, suggestion, resolve })),
      confirm: (title, text) => new Promise((resolve) => this.ask({ kind: 'confirm', title, text, resolve })),
      showMyDeviation: (d) => void this.openMyDeviation(d),
    }, engine);
    this.myGames = new MyGamesController(client, engine, () => this.changed(), (r) => this.tree.setReport(r));
    this.coachIdeas = new CoachIdeas(client, 'drill_ideas', engine, () => this.changed());
  }

  /** The Coach's 💡 Ideas once a line is finished: the position the board shows (the end, or a move of
   *  the full line you clicked). The screen calls this when the board changes. */
  readonly coachIdeas: CoachIdeas;

  explainIdeas(): void {
    const d = this.drill;
    void this.coachIdeas.explain(d?.finished && this.view !== TREE && !this.showingDeviation ? { fen: this.board().fen, me: d.myColor } : null);
  }

  private ask(p: Prompt): void {
    this.prompt = p;
    this.changed();
  }

  /** The screen answers a prompt. */
  answer(value: string | boolean | null): void {
    const p = this.prompt;
    this.prompt = null;
    if (p?.kind === 'name') p.resolve(value as string | null);
    else if (p?.kind === 'confirm') p.resolve(!!value);
    this.changed();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private changed(): void {
    if (this.view === TREE && this.drill && !this.drill.finished && this.tree.tree) {
      const at = this.drill.moves.join(' ');
      if (at !== this.followedAt) {
        this.followedAt = at;
        this.tree.followDrill();
      }
    }
    this.version += 1;
    for (const l of this.listeners) l();
  }

  private setStatus(text: string, tone: Tone = 'normal'): void {
    this.status = { text, tone };
  }

  // ---------- repertoires & variations ----------

  async init(): Promise<void> {
    await this.tree.init();
    await this.refreshRepertoires();
    // nothing to drill yet: open on the import buttons
    if (!this.repertoires.length) this.view = ADD_LINES;
    this.changed();
  }

  selected(): RepertoireEntry | null {
    return this.repertoires.find((r) => r.label === this.repertoire) ?? null;
  }

  async refreshRepertoires(): Promise<void> {
    this.repertoires = await this.client.service('repertoires');
    if (!this.repertoires.some((r) => r.label === this.repertoire)) this.repertoire = this.repertoires[0]?.label ?? '';
    await this.refreshVariations();
    if (!this.drill) {
      this.setStatus(this.repertoires.length ? 'Pick a repertoire and click Start drill.'
        : `No repertoires yet. Import a PGN file or paste a line (${ADD_LINES}) to begin.`, 'muted');
    }
    this.lichess = await this.client.service('lichessStatus');
    this.tree.invalidate();               // the repertoire or its lines changed: regrow the tree
    this.changed();
  }

  async setRepertoire(label: string): Promise<void> {
    this.repertoire = label;
    await this.refreshVariations();
    this.changed();
  }

  private async refreshVariations(): Promise<void> {
    const sel = this.selected();
    this.variations = sel ? await this.client.service('variations', sel.name, sel.color)
      : [{ kind: 'random', rootId: null, label: 'Any line (random)', repertoire: null }];
    this.variation = 0;
    await this.renderSelectedPlans();
    if (sel) this.openingData.start(sel.group ? null : sel.name);
  }

  async selectVariation(i: number): Promise<void> {
    this.variation = i;
    await this.renderSelectedPlans();
    this.changed();
  }

  /** Plans and the move preview for the highlighted variation (before drilling). */
  private async renderSelectedPlans(): Promise<void> {
    const sel = this.selected();
    const entry = this.variations[this.variation];
    this.preview = entry?.rootId ? await this.client.service('linePreview', entry.rootId) : '';
    if (sel) this.plans = plansFor(entry?.kind === 'line' ? entry.label : null, entry?.repertoire ?? sel.name, sel.color);
  }

  setView(v: View): void {
    const was = this.view;
    this.view = v;
    if (was === TREE && v !== TREE) this.tree.onHidden();
    if (v === TREE) {
      this.showingDeviation = false;
      void this.myGames.ensureReport();     // your deviations, for the tree's stars
      void this.tree.onShown();
    }
    if (v === MY_GAMES) void this.myGames.refresh();
    this.changed();
  }

  /** A deviation picked in My games (or a red star): it goes on the board. */
  async openMyDeviation(d: MyDeviationView): Promise<void> {
    if (this.view !== MY_GAMES) this.setView(MY_GAMES);
    if (this.drill && !this.drill.finished) this.stopDrill();
    this.showingDeviation = true;
    await this.myGames.open(d);
    this.changed();
  }

  /** My games → Show on the tree: the deviation as a temporary branch. */
  async myDeviationOnTree(): Promise<void> {
    const d = this.myGames.current;
    if (!d) return;
    this.view = TREE;
    this.showingDeviation = false;
    await this.tree.onShown();
    await this.tree.showMyDeviationOnTree(d, this.myGames.practicalBest(d));
    this.changed();
  }

  private stopDrill(): void {
    this.token = null;
    this.drill = null;
    this.awaitingRetry = false;
    this.showFullLine = false;
    this.previewIndex = null;
    this.recap = '';
    this.moveNote = '';
    void this.client.service('drillStop');
  }

  /** Drill exactly this line (from the tree), staying on the Tree view. */
  private async drillLine(name: string, color: PlayerColor, ids: string[]): Promise<void> {
    const view = await this.client.service('drillStartLine', name, color, ids);
    if (view) this.begin(view, 'line', true);
  }

  /** ← / →: through the full line, or along the tree's line while exploring. */
  arrowKey(delta: number): void {
    if (this.showFullLine) this.stepPreview(delta);
    else if (this.view === TREE && this.tree.exploring()) void this.tree.step(delta);
  }

  // ---------- the drill ----------

  async start(): Promise<void> {
    const sel = this.selected();
    if (!sel) {
      this.setStatus('Import and select a repertoire first.', 'muted');
      this.changed();
      return;
    }
    const entry: VariationEntry = this.variations[this.variation] ?? { kind: 'random', rootId: null, label: '', repertoire: null };
    const view = await this.client.service('drillStart', sel.name, sel.color, entry.kind === 'line' ? entry.rootId! : entry.kind);
    if (!view) {
      this.setStatus('That repertoire has no lines in it yet.', 'muted');
      this.changed();
      return;
    }
    this.begin(view, entry.kind);
  }

  /** From Stats' "Openings that fit your style": the opening into "Style suggestions"
   *  (once), selected, and a drill started (drill_tab.drill_suggestion). */
  async drillSuggestion(catalogIndex: number): Promise<void> {
    await this.drillNamed(await this.client.service('drillSuggestion', catalogIndex));
  }

  /** Stats → Results by opening → Practice: the opening as you play it (see openingPractice). */
  async practiceOpening(key: string): Promise<void> {
    const found = await this.client.service('openingPractice', key);
    if (!found) {
      this.setStatus("Couldn't find that opening's moves in your games.", 'muted');
      this.changed();
      return;
    }
    await this.drillNamed(found);
  }

  /** Select a repertoire's line by name and drill it. */
  private async drillNamed({ repertoire, color, lineName }: { repertoire: string; color: PlayerColor; lineName: string }): Promise<void> {
    await this.refreshRepertoires();
    await this.setRepertoire(`${repertoire} (${color})`);
    const i = this.variations.findIndex((v) => v.kind === 'line' && v.label === lineName);
    if (i >= 0) await this.selectVariation(i);
    await this.start();
  }

  async sameLine(): Promise<void> {
    if (!this.drill) return;
    this.begin(await this.client.service('drillRestart'), this.kind);
  }

  async newRandomLine(): Promise<void> {
    if (!this.drill) return;
    const view = await this.client.service('drillNewRandom');
    if (!view) return;
    this.variation = 0;                          // Setup shows "Any line (random)"
    this.begin(view, 'random');
  }

  private begin(view: DrillView, kind: VariationEntry['kind'], keepView = false): void {
    this.token = {};
    this.showingDeviation = false;
    this.drill = view;
    this.kind = kind;
    this.lineMissed = false;
    this.previewIndex = null;
    this.awaitingRetry = false;
    this.offerRestart = false;
    this.showFullLine = false;
    this.recap = '';
    this.moveNote = '';
    this.plans = plansFor(view.lineName, view.repertoire, view.myColor);
    if (!keepView) this.setView('Plans');
    this.title = `Drilling: ${view.lineName}`;
    this.startLabel = { random: 'New random line', weak: 'Next weak line' }[kind as string] ?? 'Drill again';
    this.updateLineLabel();
    void this.advance(this.token);
  }

  /** Plays the opponent's moves until it's your turn or the line is complete. */
  private async advance(token: object | null): Promise<void> {
    if (token !== this.token || !this.drill) return;
    if (this.drill.finished) {
      await this.showCompletion();
      return;
    }
    if (this.drill.myTurn) {
      this.setStatus('Your move.');
      this.changed();
      return;
    }
    const { san, share, view } = await this.client.service('drillOpponent');
    if (token !== this.token) return;
    this.drill = view;
    const howOften = share !== null ? ` (${Math.round(share * 100)}% of players at your level play it)` : '';
    this.setStatus(`Opponent played ${san}${howOften}. Your move.`);
    this.showMoveNote(san);
    this.changed();
    // your turn now: wait for your move. (Desktop checked again 0.3 s later regardless, and a
    // quick move made that check play the next reply at once, over your "Correct".)
    if (view.finished || !view.myTurn) setTimeout(() => void this.advance(token), OPPONENT_DELAY_MS);
  }

  private async showCompletion(): Promise<void> {
    const d = this.drill!;
    this.setStatus('End of line — nice work. Go again, or try a new random line.', 'success');
    this.recap = `${d.lineName}:\n${formatMoveList(d.path.map((n) => n.san))}`;
    this.awaitingRetry = false;
    this.showFullLine = false;
    this.previewIndex = null;
    this.changed();
    this.onLevel(await this.client.service('drillFinish', this.lineMissed));
  }

  /** A move on the board while drilling. */
  async onMove(uci: string): Promise<void> {
    if (this.view === TREE && this.tree.exploring()) {
      await this.tree.exploreMove(uci);
      return;
    }
    const d = this.drill;
    if (!d || d.finished || !d.myTurn || this.previewIndex !== null) return;
    const token = this.token;
    const { result, view } = await this.client.service('drillAttempt', uci);
    if (token !== this.token) return;
    this.drill = view;
    if (result.correct) {
      this.awaitingRetry = false;
      this.setStatus(`Correct — ${result.played_san}.`, 'success');
      this.showMoveNote(result.played_san);
      this.changed();
      setTimeout(() => void this.advance(token), AFTER_CORRECT_MS);
      return;
    }
    // nothing was pushed — the board is unchanged, so a retry just works
    this.lineMissed = true;
    const played = result.played_san ? `you played ${result.played_san}` : "that's not the move here";
    this.setStatus(result.in_book
      ? `Not this line — ${played}. That's book theory in a different line, but not the one you're drilling. Try again.`
      : `Not correct — ${played}. Try again.`, 'error');
    this.awaitingRetry = true;
    this.misses += 1;
    this.changed();
  }

  async reveal(): Promise<void> {
    if (!this.drill) return;
    this.lineMissed = true;
    this.offerRestart = true;
    const token = this.token;
    const { san, view } = await this.client.service('drillReveal');
    this.drill = view;
    this.awaitingRetry = false;
    if (san === null) {
      this.setStatus('Nothing left to reveal.');
      void this.advance(token);
      return;
    }
    this.setStatus(`Correct move was ${san}. Keep going, or start over with Same line.`);
    this.showMoveNote(san);
    this.changed();
    setTimeout(() => void this.advance(token), AFTER_CORRECT_MS);
  }

  /** The imported PGN's comment on the move just played. Moves without one leave
   *  the previous note up (it names its move), so a quick reply doesn't wipe yours. */
  private showMoveNote(san: string | null): void {
    this.updateLineLabel();
    const d = this.drill;
    const note = d && d.index ? d.path[d.index - 1].notes : null;
    if (note) this.moveNote = san ? `${san}: ${note}` : note;
  }

  /** Moves so far, or the whole line with Show full line (hidden by default: no answers given away). */
  private updateLineLabel(): void {
    const d = this.drill;
    if (!d || d.finished) return;          // the recap owns it then
    if (this.showFullLine) this.recap = '';           // drawn as move pairs (fullLine())
    else this.recap = d.index ? `Moves: ${formatMoveList(d.path.slice(0, d.index).map((n) => n.san))}` : '';
  }

  toggleFullLine(): void {
    this.showFullLine = !this.showFullLine;
    this.previewIndex = null;
    this.updateLineLabel();
    this.changed();
  }

  /** Show full line, as move pairs (the screen colours each pair): how far you've played,
   *  and the position on the board when you're stepping through it. */
  fullLine(): { pairs: { n: number; moves: { san: string; i: number }[] }[]; played: number; at: number } | null {
    const d = this.drill;
    if (!d || d.finished || !this.showFullLine) return null;
    const pairs: { n: number; moves: { san: string; i: number }[] }[] = [];
    d.path.forEach((node, i) => {
      if (i % 2 === 0) pairs.push({ n: i / 2 + 1, moves: [] });
      pairs[pairs.length - 1].moves.push({ san: node.san, i });
    });
    return { pairs, played: d.index, at: this.previewIndex ?? d.index };
  }

  /** A move clicked in the full line: the board after it (after `index` moves). */
  previewTo(index: number): void {
    const d = this.drill;
    if (!d || !this.showFullLine) return;
    this.stepPreview(index - (this.previewIndex ?? d.index));
  }

  /** ◀ / ▶ through the full line (shown with Show full line). */
  stepPreview(delta: number): void {
    const d = this.drill;
    if (!d || !this.showFullLine) return;
    const live = d.index;
    const current = this.previewIndex ?? live;
    const index = Math.max(0, Math.min(d.path.length, current + delta));
    this.previewIndex = index === live ? null : index;
    if (this.previewIndex === null) {
      this.setStatus(d.myTurn ? 'Back to the drill — your move.' : 'Back to the drill.');
    } else {
      const sans = d.path.map((n) => n.san);
      const last = index ? `${Math.floor((index + 1) / 2)}.${index % 2 ? '' : '..'} ${sans[index - 1]}` : '';
      this.setStatus(`Viewing the line: ${index ? `after ${last}` : 'starting position'} (${index}/${sans.length}). `
        + 'Step back to where you were, or Hide full line, to keep drilling.', 'muted');
    }
    this.changed();
  }

  /** The board: the drill's position, or the full-line position being stepped through. */
  board(): { fen: string; lastMove: string | null; orientation: Color; movable: Color | 'both' | null; arrows: Arrow[] } {
    if (this.view === TREE && this.tree.exploring()) {
      const b = this.tree.board;
      return { fen: b.fen, lastMove: b.lastMove, orientation: b.orientation, movable: 'both', arrows: b.arrows };
    }
    if (this.showingDeviation && this.myGames.board && !(this.drill && !this.drill.finished)) {
      const b = this.myGames.board;
      return { fen: b.fen, lastMove: null, orientation: b.orientation, movable: null, arrows: b.arrows };
    }
    const d = this.drill;
    if (!d) return { fen: Board.fromFen().fen(), lastMove: null, orientation: this.selected()?.color ?? 'white', movable: null, arrows: [] };
    const orientation = d.myColor;
    if (this.previewIndex !== null) {
      const b = Board.fromFen();
      for (const n of d.path.slice(0, this.previewIndex)) b.push(n.uci);
      return { fen: b.fen(), lastMove: this.previewIndex ? d.path[this.previewIndex - 1].uci : null, orientation, movable: null, arrows: [] };
    }
    const movable = !d.finished && d.myTurn ? d.myColor : null;     // after a miss too: just play again
    return { fen: d.fen, lastMove: d.moves.at(-1) ?? null, orientation, movable, arrows: [] };
  }

  /** The buttons under the board (_layout_buttons): which ones show. */
  buttons(): { toggle: boolean; steps: boolean; retry: boolean; restart: boolean; end: boolean } {
    const d = this.drill;
    if (!d || (this.view === TREE && this.tree.exploring()) || this.showingDeviation) return { toggle: false, steps: false, retry: false, restart: false, end: false };
    if (d.finished) return { toggle: false, steps: false, retry: false, restart: false, end: true };
    return {
      toggle: true,
      steps: this.showFullLine,
      retry: this.awaitingRetry && !this.showFullLine,
      restart: !(this.awaitingRetry && !this.showFullLine) && (this.showFullLine || this.offerRestart),
      end: false,
    };
  }

  lineTitle(): string {
    if (this.view === TREE && this.tree.exploring()) return this.title;
    if (this.showingDeviation && this.myGames.board && !(this.drill && !this.drill.finished)) return this.myGames.board.title;
    if (!this.drill) return '';
    // the opening's name is long and the same for all its lines: the variation first
    const name = this.drill.lineName;
    const head = headOf(name);
    return `Drilling: ${head ? `${variationName(name)} · ${head}` : name}`;
  }

  /** The commentary's status line: the deviation's while one is on the board. */
  statusLine(): { text: string; tone: Tone } {
    if (this.showingDeviation && this.myGames.board && !(this.drill && !this.drill.finished)) return { text: this.myGames.board.status, tone: 'normal' };
    return this.status;
  }

  // ---------- adding and editing lines ----------

  /** A PGN (file or pasted) into a repertoire; selects it so Start drill uses it. */
  async importPgn(text: string, name: string, color: PlayerColor): Promise<number> {
    const count = await this.client.service('importPgn', text, name, color);
    await this.refreshRepertoires();
    const label = `${name} (${color})`;
    if (this.repertoires.some((r) => r.label === label)) await this.setRepertoire(label);
    return count;
  }

  async deleteVariation(): Promise<string> {
    const entry = this.variations[this.variation];
    if (entry?.kind !== 'line' || !entry.rootId) return '';
    const { moves } = await this.client.service('lineSize', entry.rootId);
    await this.client.service('deleteBranch', [entry.rootId]);
    if (this.drill && this.drill.path[0]?.id === entry.rootId) this.drill = null;   // it was being drilled
    await this.refreshRepertoires();
    this.setStatus(`Deleted “${entry.label}” (${moves} moves).`, 'muted');
    this.changed();
    return entry.label;
  }

  async lichessChanged(): Promise<void> {
    this.lichess = await this.client.service('lichessStatus');
    const sel = this.selected();
    if (sel) this.openingData.start(sel.group ? null : sel.name);
    this.changed();
  }

  dispose(): void {
    this.tree.dispose();
    this.myGames.dispose();
    this.token = null;
    void this.client.service('drillStop');
  }
}

/** The opening's plan notes, your side first (_render_plans). */
export function plansFor(lineName: string | null, repertoire: string, myColor: PlayerColor): PlansView | null {
  const notes = openingNotes.notesFor(lineName, repertoire);
  if (!notes) return null;
  const sides = [{ side: 'WHITE', items: notes.white }, { side: 'BLACK', items: notes.black }];
  if (myColor === 'black') sides.reverse();
  return {
    title: notes.title,
    idea: notes.idea,
    sides: sides.map((s, i) => ({ heading: i === 0 ? `Your plans (${s.side})` : `Opponent's plans (${s.side})`, items: s.items })),
    structure: notes.structure,
    watchOut: notes.watch_out,
  };
}
