/**
 * Game Review (game_review_tab.py, without the widgets): step through one of
 * your analyzed games with an evaluation graph, your mistakes marked, move
 * badges (≡ prep, ⚑ left prep, !! amazing, ! only move, ✓ best, ?! ? ??),
 * Stockfish's better move as an arrow, where the game left your prep, and
 * accuracy — all from the saved analysis. Analyze turns the board into the
 * shared analysis board from the move shown; "Stockfish's top moves" shows
 * its lines as you click through.
 */
import { MATE_CP, MIN_CHANCES_LOST, winChances } from '../core/analyzer';
import { phase } from '../core/stats';
import { Board, type Color } from '../core/chess';
import type { Engine } from '../core/engine';
import { pySigned } from '../core/format';
import type { DbClient } from '../data/client';
import type { AmazingView, EvalRow, ReviewGame, ReviewGameRow } from '../data/reviewServices';
import * as coach from '../core/coach';
import * as explain from '../core/explain';
import * as openingCommentary from '../core/openingCommentary';
import { Analysis, ideaChips } from './analysis';
import { beforeLast, CoachIdeas } from './coachIdeas';
import type { Arrow } from './Board';

export const GRAPH_CLAMP = 600;                 // the graph shows evaluations within ±6 pawns
export const ERROR = '#b8402c';
export const WARNING = '#d08a1e';
export const INFO = '#3b5b84';
export const MARKS: [number, string, string, string][] = [[300, '??', 'Blunder', ERROR], [150, '?', 'Mistake', WARNING], [80, '?!', 'Inaccuracy', INFO]];
export const AMAZING_COLOR = '#E05599';         // !! a sound sacrifice
export const BEST_COLOR = '#2c7a4c';
export const ONLY_COLOR = '#14A693';            // ! the only move that keeps your position
export const BOOK_COLOR = '#8A8F98';            // ≡ a move inside your prep
export const LEFT_PREP = '#8B5CF6';             // ⚑ the move that left your prep
const COACH_DEPTH = 12;                         // Stockfish's line for the Coach's "one move too early"
const TURNING_CHANCES = 0.3;                    // a drop this big (winning chances) can be the game's turning point

export type Tone = 'normal' | 'success' | 'muted' | { color: string };

export function loss(ev: EvalRow | undefined): number | null {
  if (!ev || ev.cp_after === null) return null;
  return Math.max(0, Math.min(ev.cp_before, MATE_CP) - Math.max(ev.cp_after, -MATE_CP));
}

/** [symbol, label, colour] for one of your moves, or null if it was fine. */
export function mark(ev: EvalRow | undefined): [string, string, string] | null {
  const l = loss(ev);
  if (l === null) return null;
  for (const [threshold, symbol, label, color] of MARKS) if (l >= threshold) return [symbol, label, color];
  return null;
}

export function pawns(cp: number | null): string {
  if (cp === null) return '?';
  if (Math.abs(cp) >= MATE_CP) return cp > 0 ? 'mate' : '−mate';
  return pySigned(cp / 100, 1);
}


/** "gains space": a pawn moving into the opponent's half (not a capture). */
function spaceNote(board: Board, move: string): string | null {
  const piece = board.pieceAt(move.charCodeAt(0) - 97 + 8 * (move.charCodeAt(1) - 49));
  if (piece?.role !== 'pawn' || board.isCapture(move)) return null;
  const rank = Number(move[3]);
  const deep = piece.color === 'white' ? rank >= 5 : rank <= 4;
  return deep ? 'gains space' : null;
}

const CENTRE = new Set([27, 28, 35, 36]);                                  // d4 e4 d5 e5
const WIDE_CENTRE = new Set([18, 19, 20, 21, 26, 29, 34, 37, 42, 43, 44, 45]);   // c3–f3, c4/f4, c5/f5, c6–f6
const sqName = (sq: number) => `${String.fromCharCode(97 + (sq % 8))}${Math.floor(sq / 8) + 1}`;

/** The key squares the moved piece now controls that it didn't before: the centre first,
 *  then the squares around the enemy king. */
function controlNote(board: Board, move: string): string | null {
  const from = move.charCodeAt(0) - 97 + 8 * (move.charCodeAt(1) - 49);
  const to = move.charCodeAt(2) - 97 + 8 * (move.charCodeAt(3) - 49);
  const piece = board.pieceAt(from);
  if (!piece || piece.role === 'king' || board.isCastling(move)) return null;
  const before = new Set(board.attacks(from));
  const after = board.copy();
  after.push(move);
  const fresh = after.attacks(to).filter((sq) => !before.has(sq) && after.pieceAt(sq)?.color !== piece.color);
  const centre = fresh.filter((sq) => CENTRE.has(sq));
  const wide = fresh.filter((sq) => WIDE_CENTRE.has(sq));
  if (centre.length) return `now controls ${[...centre, ...wide].slice(0, 2).map(sqName).join(' and ')} in the centre`;
  const theirKing = after.king(piece.color === 'white' ? 'black' : 'white');
  if (theirKing !== undefined) {
    const zone = new Set(after.copy().attacks(theirKing));
    const near = fresh.filter((sq) => zone.has(sq));
    if (near.length) return `eyes the squares around the king (${near.slice(0, 2).map(sqName).join(', ')})`;
  }
  if (wide.length >= 2) return `now controls ${wide.slice(0, 2).map(sqName).join(' and ')}`;
  return null;
}

/** What a move does, in a few words: its tactics, then the principles it follows. */
function whatItDoes(board: Board, move: string): string[] {
  const good = openingCommentary.principles(board, move).filter((f) => f.good).map((f) => f.text);
  const space = spaceNote(board, move);
  const control = controlNote(board, move);
  return [...explain.moveFeatures(board, move), ...good, ...(space ? [space] : []), ...(control ? [control] : [])].slice(0, 3);
}

export class ReviewController {
  version = 0;
  filter = 'All games';
  result = 'All results';           // All results / Wins / Losses / Draws
  notice = '';                      // "Made a puzzle from …" and the like
  games: ReviewGameRow[] = [];
  gamesLoaded = false;
  game: ReviewGame | null = null;
  ply = 0;
  status: { text: string; tone: Tone } = { text: 'Pick a game', tone: 'muted' };
  detail = '';
  topMoves = false;
  amazing: AmazingView[] | null = null;
  amazingBusy = false;
  analysis: Analysis;
  /** Why the move just played (yours) was good or bad: '' when there's nothing to say. */
  why = '';
  private whyCache = new Map<string, string>();
  private turning: { gameId: string; ply: number | null } | null = null;
  private whyToken: object | null = null;
  private board: Board = Board.fromFen();
  private arrows: Arrow[] = [];
  private anaFromPly = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly client: DbClient, private readonly engine: Engine | null) {
    this.coachIdeas = new CoachIdeas(client, 'review_ideas', engine, () => this.changed());
    this.analysis = new Analysis(engine, {
      title: (b) => this.analysisTitle(b),
      hint: 'click a line, then →',
      onChange: () => this.changed(),
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private changed(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  // ---------- games list ----------

  async refreshGames(): Promise<void> {
    const s = await this.client.service('getSettings', ['review_top_moves', 'review_ideas']);
    this.topMoves = s.review_top_moves === '1';
    this.coachIdeas.on = s.review_ideas === '1';
    this.games = await this.client.service('reviewGames', this.filter, this.result);
    this.gamesLoaded = true;
    if (!this.games.length && !this.game) this.status = { text: 'No analyzed games in this filter yet — run Analyze new games on Import & Analyze.', tone: 'muted' };
    this.changed();
  }

  async setFilter(f: string): Promise<void> {
    this.filter = f;
    await this.refreshGames();
  }

  async setResult(r: string): Promise<void> {
    this.result = r;
    await this.refreshGames();
  }

  /** The games list after the search box (an opponent's name, or words in your notes) and "With notes". */
  search = '';
  withNotes = false;

  shownGames(): ReviewGameRow[] {
    const q = this.search.trim().toLowerCase();
    return this.games.filter((g) => (!this.withNotes || g.notes > 0)
      && (!q || g.opponent.toLowerCase().includes(q) || g.noteText.toLowerCase().includes(q)));
  }

  setSearch(q: string): void {
    this.search = q;
    this.changed();
  }

  setWithNotes(on: boolean): void {
    this.withNotes = on;
    this.changed();
  }

  /** From elsewhere ("Review game"): load that game and jump to the position. */
  async openGame(gameId: string, fen: string | null = null, ply: number | null = null): Promise<void> {
    if (!this.gamesLoaded) await this.refreshGames();
    if (!this.games.some((g) => g.id === gameId) && (this.filter !== 'All games' || this.result !== 'All results')) {
      this.filter = 'All games';
      this.result = 'All results';
      await this.refreshGames();
    }
    await this.loadGame(gameId);
    if (ply !== null) this.go(ply);
    else if (fen) {
      const key = (f: string) => f.split(' ').slice(0, 4).join(' ');
      const board = Board.fromFen();
      for (const [i, m] of (this.game?.ucis ?? []).entries()) {
        if (key(board.fen()) === key(fen)) {
          this.go(i);
          return;
        }
        board.push(m);
      }
    }
  }

  async loadGame(gameId: string): Promise<void> {
    this.stopAnalysis();
    this.game = await this.client.service('reviewGame', gameId);
    this.go(0);
  }

  // ---------- the moves list and badges ----------

  private only(ply: number): boolean {
    const ev = this.game?.evals[ply];
    return !!ev && ev.best_move_uci !== null && ev.move_uci === ev.best_move_uci && ev.cp_second !== null
      && winChances(ev.cp_before) - winChances(ev.cp_second) >= MIN_CHANCES_LOST;
  }

  /** [text, colour] for the move at this ply, in priority order — null when there's nothing to say. */
  badge(ply: number): [string, string] | null {
    const g = this.game;
    if (!g || ply < 0 || ply >= g.ucis.length) return null;
    const p = g.prep;
    if (p && ply === p.departure) return ['⚑', LEFT_PREP];
    if (p && ply < p.inPrep) return ['≡', BOOK_COLOR];
    if (g.amazing[ply]) return ['!!', AMAZING_COLOR];
    if (this.only(ply)) return ['!', ONLY_COLOR];
    const ev = g.evals[ply];
    if (ev?.best_move_uci && ev.move_uci === ev.best_move_uci) return ['✓', BEST_COLOR];
    const m = mark(ev);
    return m ? [m[0], m[2]] : null;
  }

  /** The moves list: [label, colour or null for normal, muted (their move)]. */
  moveRows(): { label: string; color: string | null; muted: boolean }[] {
    const g = this.game;
    if (!g) return [];
    const departure = g.prep?.departure ?? null;
    const inPrep = g.prep?.inPrep ?? 0;
    const mine = g.myColor === 'white' ? 0 : 1;
    return g.sans.map((san, ply) => {
      const m = mark(g.evals[ply]);
      const book = ply < inPrep ? '≡ ' : ply === departure ? '⚑ ' : '   ';
      const shown = m && ply >= inPrep && ply !== departure ? m[0] : '';
      let label = `${g.puzzles[ply] ? '🧩' : book}${ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}. ` : `${Math.floor(ply / 2) + 1}... `}${san}${shown}`;
      if (g.notes?.[ply + 1]) label += '  📝';            // a note on the position after this move
      if (ply === departure) label += g.prep!.reason === 'you' ? '   left your prep' : '   they left your prep';
      else if (m && ply >= inPrep) label += `   ${m[1]} (${pawns(-loss(g.evals[ply])!)})`;
      else if (g.amazing[ply]) label += '!!   amazing move';
      else if (this.only(ply)) label += '!   only move';
      const b = this.badge(ply);
      return { label, color: b ? b[1] : null, muted: !b && ply % 2 !== mine };
    });
  }

  // ---------- navigation ----------

  /** ⏮ ← → ⏭ and the arrow keys: along the game, or the analysis board when analysing. */
  step(delta: number): void {
    if (this.analysis.active) {
      this.analysis.walk(delta);
      return;
    }
    this.go(this.ply + delta);
  }

  go(ply: number): void {
    const g = this.game;
    if (!g) {
      this.changed();
      return;
    }
    if (this.analysis.active) this.stopAnalysis();   // a move or graph click: back to the game, there
    this.ply = Math.max(0, Math.min(g.ucis.length, ply));
    this.notice = '';
    this.board = Board.fromFen();
    for (const m of g.ucis.slice(0, this.ply)) this.board.push(m);
    this.describe();
    void this.explainMove();
    void this.explainIdeas();
    if (this.topMoves) this.analysis.peek(this.board);
    else this.analysis.unpeek();
    this.changed();
  }

  /** Best saved evaluation (your point of view) for the shown position: exact on your turn, carried over on theirs. */
  private evalAtPly(): number | null {
    const g = this.game!;
    const ev = g.evals[this.ply];
    if (ev) return ev.cp_before;
    for (let p = this.ply - 1; p >= 0; p--) {
      const e = g.evals[p];
      if (e) return e.cp_after ?? e.cp_before;
    }
    return Object.keys(g.evals).length ? 0 : null;
  }

  /** The evaluation bar (White's point of view). */
  evalWhite(): number | null {
    if (this.analysis.active) return this.analysis.evalWhite;
    if (!this.game) return null;
    const cp = this.evalAtPly();
    return cp !== null && this.game.myColor === 'black' ? -cp : cp;
  }

  private setStatus(text: string, tone: Tone = 'normal', detail = ''): void {
    this.status = { text, tone };
    this.detail = detail;
  }

  /** Explain the move just played and, when it's your turn, show the engine's best move as an arrow. */
  private describe(): void {
    const g = this.game!;
    const last = this.ply - 1;
    const ev = g.evals[last];
    this.arrows = [];
    if (last < 0) this.setStatus('Start of the game.', 'normal', 'Use ← / → or click a move.');
    else if (ev) {
      const m = mark(ev);
      const best = ev.best_move_uci ? Board.fromFen(ev.fen_before).san(ev.best_move_uci) : '?';
      if (m) {
        this.setStatus(`You played ${g.sans[last]}${m[0]} — ${m[1]}`, { color: m[2] },
          `Evaluation went from ${pawns(ev.cp_before)} to ${pawns(ev.cp_after)}. Best was ${best} (arrow shown on the position before your move).`);
      } else if (g.amazing[last]) {
        const how = ev.move_uci === ev.best_move_uci ? 'the best move' : 'nearly the best move';
        this.setStatus(`You played ${g.sans[last]}!! — an amazing move`, { color: AMAZING_COLOR },
          `You offered ${g.amazing[last]} pawns' worth of material — and it was ${how} (Stockfish ${pawns(ev.cp_before)} → ${pawns(ev.cp_after)}).`);
      } else if (this.only(last)) {
        const second = ev.second_move_uci ? Board.fromFen(ev.fen_before).san(ev.second_move_uci) : 'anything else';
        const cp = ev.cp_before;
        const keeps = cp >= 50 ? 'keeps your advantage' : cp > -50 ? 'holds the balance' : 'keeps you in the game';
        this.setStatus(`You played ${g.sans[last]}! — the only move`, { color: ONLY_COLOR },
          `It ${keeps} (${pawns(cp)}); the next best, ${second}, would have given ${pawns(ev.cp_second)}.`);
      } else if (ev.move_uci === ev.best_move_uci) {
        this.setStatus(`You played ${g.sans[last]} — best move`, 'success', `Evaluation ${pawns(ev.cp_before)}.`);
      } else {
        this.setStatus(`You played ${g.sans[last]} — fine`, 'normal', `Evaluation ${pawns(ev.cp_before)} → ${pawns(ev.cp_after)}. Engine preferred ${best}.`);
      }
    } else this.setStatus(`Opponent played ${g.sans[last]}`);
    this.describePrep(last);
    // arrow: the best move in the current position when it's your move
    const upcoming = g.evals[this.ply];
    if (upcoming?.best_move_uci && !this.topMoves && !(g.prep && this.ply === g.prep.departure)) {
      this.arrows = [{ from: upcoming.best_move_uci.slice(0, 2), to: upcoming.best_move_uci.slice(2, 4), brush: 'green' }];
    }
  }

  /** Why your move just played was good or bad, in words: for a mistake, what the
   *  better move does and what goes wrong after yours (Stockfish, a moment — kept once
   *  worked out); for a good move, what it does (no engine). */
  private async explainMove(): Promise<void> {
    const g = this.game!;
    const last = this.ply - 1;
    const ev = g.evals[last];
    this.whyToken = null;
    if (!ev) {
      this.why = '';
      return;
    }
    const key = `${g.id}|${last}`;
    const cached = this.whyCache.get(key);
    if (cached !== undefined) {
      this.why = cached;
      return;
    }
    const before = Board.fromFen(ev.fen_before);
    const san = before.san(ev.move_uci);
    const m = mark(ev);
    const goodMove = !m && (ev.move_uci === ev.best_move_uci || !!g.amazing[last] || this.only(last));
    // the Coach (core/coach.ts): the position read like a human, the engine's facts as reasons
    const input: coach.CoachInput = {
      fenBefore: ev.fen_before, move: ev.move_uci, best: ev.best_move_uci, cpBefore: ev.cp_before, cpAfter: ev.cp_after,
      second: ev.second_move_uci, cpSecond: ev.cp_second, turningPoint: this.turningPoint() === last,
    };
    if (!m && !goodMove) {
      // a fine move: what it does, if anything worth saying (no engine)
      const words = coach.coach(input);
      const bits = words ? [] : whatItDoes(before, ev.move_uci);
      const text = words ? `Coach: ${words}` : bits.length ? `Coach: ${san} ${bits.join('; ')}.` : '';
      this.whyCache.set(key, text);
      this.why = text;
      return;
    }
    const token = {};
    this.whyToken = token;
    this.why = 'Working out why…';
    const facts = async (best: string, played: string | null) => {
      try {
        return await explain.solutionFacts(ev.fen_before, best, played, this.engine);
      } catch {
        return explain.solutionFacts(ev.fen_before, best, played, null);   // the board facts alone
      }
    };
    let text: string;
    if (!m) {
      // a good move (best, ! only move, !! amazing): what it achieves along Stockfish's line
      input.facts = await facts(ev.move_uci, null);
      text = coach.coach(input);
      const extra = whatItDoes(before, ev.move_uci).filter((b) => !text.includes(b) && !(/castl/.test(b) && /castl/.test(text)));
      if (extra.length) text += ` ${san} also ${extra.join('; ')}.`;
    } else {
      // a mistake: what goes wrong after yours, what the better move does, and the engine's line ("one move too early")
      input.facts = await facts(ev.best_move_uci!, ev.move_uci);
      input.extraBad = openingCommentary.principles(before, ev.move_uci).filter((f) => !f.good).map((f) => f.text);
      if (this.engine) {
        try {
          input.bestLine = (await this.engine.analyse(before, { depth: COACH_DEPTH }))[0]?.pv;
        } catch {
          /* no line: no "one move too early" */
        }
      }
      text = coach.coach(input);
    }
    text = `Coach: ${text}`;
    this.whyCache.set(key, text);
    if (this.whyToken !== token) return;            // moved on meanwhile
    this.why = text;
    this.changed();
  }

  /** The game's turning point: the move of yours that cost the most winning chances (a real mistake only). */
  private turningPoint(): number | null {
    const g = this.game!;
    if (this.turning?.gameId === g.id) return this.turning.ply;
    let best: number | null = null;
    let worst = TURNING_CHANCES;
    for (const [ply, ev] of Object.entries(g.evals)) {
      if (ev.cp_after === null) continue;
      const drop = winChances(ev.cp_before) - winChances(ev.cp_after);
      if (drop >= worst) [best, worst] = [Number(ply), drop];
    }
    this.turning = { gameId: g.id, ply: best };
    return best;
  }

  /** On the move that left your prep: say so; on the position before it: your prep's move(s) as green arrows. */
  private describePrep(last: number): void {
    const p = this.game!.prep;
    if (!p || p.departure === null) return;
    if (last === p.departure) {
      const who = p.reason === 'you' ? 'You left your prep here' : 'Your opponent left your prep here';
      const expected = p.reason === 'you' ? 'your prep plays' : 'your prep expects';
      const note = `⚑ ${who} — ${expected} ${p.prepSans.join('/')}.`;
      this.detail = this.detail ? `${note}\n${this.detail}` : note;
    }
    if (this.ply === p.departure) {
      this.arrows = p.prepUcis.filter((u) => this.board.isLegal(u)).map((u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), brush: 'green' as const }));
      const whose = p.reason === 'you' ? 'your move' : 'their move';
      this.detail = `Next, ${whose} leaves your prep — green arrow: what your prep plays. ${this.detail}`;
    }
  }

  nextMistake(): void {
    const g = this.game;
    if (!g) return;
    const plies = Object.keys(g.evals).map(Number).sort((a, b) => a - b);
    for (const ply of plies) {
      const m = mark(g.evals[ply]);
      if (ply >= this.ply && m) {
        this.go(ply);       // the position before the mistake, best-move arrow shown
        const ev = g.evals[ply];
        const best = Board.fromFen(ev.fen_before).san(ev.best_move_uci!);
        this.setStatus(`Your move — in the game you played ${g.sans[ply]}${m[0]} (${m[1]})`, { color: m[2] },
          `Better was ${best} (arrow). Evaluation ${pawns(ev.cp_before)} would have become ${pawns(ev.cp_after)} after your move. Press → to see it.`);
        this.changed();
        return;
      }
    }
    this.setStatus('No more mistakes after this point.', 'success');
    this.changed();
  }

  // ---------- the Coach on the position: 💡 Ideas ----------

  private readonly coachIdeas: CoachIdeas;

  get ideasOn(): boolean {
    return this.coachIdeas.on;
  }

  get ideas(): coach.Ideas | null {
    return this.coachIdeas.ideas;
  }

  async setIdeas(on: boolean): Promise<void> {
    await this.coachIdeas.set(on);
  }

  /** The ideas of the position on the board: at once from the board, then with Stockfish's plan. */
  private async explainIdeas(): Promise<void> {
    const g = this.game;
    if (!g) return this.coachIdeas.explain(null);
    const board = this.board;
    // your move after theirs: what their move wants (what they'd play if they could move again)
    const theirMove = board.turn === g.myColor && this.ply > 0 ? g.ucis[this.ply - 1] : undefined;
    await this.coachIdeas.explain({ fen: board.fen(), me: g.myColor, cp: this.evalAtPly(), theirMove, before: beforeLast(board) });
  }

  /** The whole game, as a coach would sum it up (📋 Game summary). */
  summaryOn = false;

  toggleSummary(): void {
    this.summaryOn = !this.summaryOn;
    this.changed();
  }

  summary(): coach.GameSummary | null {
    const g = this.game;
    if (!g || !this.summaryOn) return null;
    if (this.summaryCache?.gameId === g.id) return this.summaryCache.summary;
    const moves: coach.SummaryMove[] = Object.entries(g.evals).map(([p, ev]) => {
      const ply = Number(p);
      return { ply, fenBefore: ev.fen_before, san: g.sans[ply], move: g.ucis[ply], cpBefore: ev.cp_before, cpAfter: ev.cp_after,
        only: this.only(ply), amazing: !!g.amazing[ply], theirSan: ply > 0 ? g.sans[ply - 1] : undefined };
    }).sort((a, b) => a.ply - b.ply);
    const left = g.prep && g.prep.reason === 'you' ? g.prep.departure : null;
    const summary = coach.gameSummary(moves, g.result, phase, left);
    this.summaryCache = { gameId: g.id, summary };
    return summary;
  }

  private summaryCache: { gameId: string; summary: coach.GameSummary } | null = null;

  async setTopMoves(on: boolean): Promise<void> {
    this.topMoves = on;
    await this.client.service('setSettings', { review_top_moves: on ? '1' : '0' });
    if (this.game && !this.analysis.active) this.go(this.ply);
  }

  /** The top-moves chips while clicking through, e.g. '+0.32 d5'. */
  topMoveChips(): string[] {
    return this.topMoves && !this.analysis.active && this.analysis.peeking ? ideaChips(this.board.fen(), this.analysis.ideas) : [];
  }

  // ---------- the board ----------

  view(): { fen: string; lastMove: string | null; orientation: Color; arrows: Arrow[]; badges: { square: string; text: string; color: string }[] } {
    const orientation = this.game?.myColor ?? 'white';
    if (this.analysis.active) {
      const b = this.analysis.board;
      return { fen: b.fen(), lastMove: b.moveStack.at(-1) ?? null, orientation, arrows: this.analysis.arrows(), badges: [] };
    }
    const g = this.game;
    const last = g && this.ply > 0 ? g.ucis[this.ply - 1] : null;
    const b = this.badge(this.ply - 1);
    const arrows = this.topMoves && this.analysis.peeking ? this.analysis.arrows() : this.arrows;
    return { fen: this.board.fen(), lastMove: last, orientation, arrows, badges: b && last ? [{ square: last.slice(2, 4), text: b[0], color: b[1] }] : [] };
  }

  /** A move played on the board: in analysis, for either side; otherwise it starts analysis there. */
  onMove(uci: string): void {
    if (!this.game) return;
    if (!this.analysis.active) this.startAnalysis();
    this.analysis.play(uci);
  }

  pickIdea(i: number): void {
    if (!this.analysis.active) {
      const ideas = this.analysis.ideas;
      if (i >= ideas.length) return;
      this.startAnalysis();
      this.analysis.ideas = ideas;
    }
    this.analysis.follow(i);
  }

  toggleAnalysis(): void {
    if (this.analysis.active) {
      const ply = this.anaFromPly;
      this.stopAnalysis();
      this.go(ply);
    } else if (this.game) this.startAnalysis();
  }

  /** The analysis board from the move shown; → plays on along the game. */
  private startAnalysis(): void {
    const g = this.game!;
    this.anaFromPly = this.ply;
    this.analysis.unpeek();
    this.analysis.start(this.board, g.ucis.slice(this.ply));
    this.changed();
  }

  private stopAnalysis(): void {
    if (!this.analysis.active) return;
    this.analysis.stop();
    this.analysis.unpeek();
    this.changed();
  }

  private onGameLine(b: Board): boolean {
    const stack = b.moveStack;
    return stack.join(' ') === (this.game?.ucis ?? []).slice(0, stack.length).join(' ');
  }

  private analysisTitle(b: Board): string {
    const ply = b.moveStack.length;
    const side = b.turn === 'white' ? 'White' : 'Black';
    const where = ply ? `move ${Math.floor(ply / 2) + 1}` : 'start';
    return this.onGameLine(b) ? `${side} to move · game, ${where}` : `${side} to move · your line`;
  }

  /** The highlighted row of the moves list (the analysis board's, while on the game's line). */
  currentRow(): number {
    if (this.analysis.active) {
      const b = this.analysis.board;
      return this.onGameLine(b) ? b.moveStack.length - 1 : -1;
    }
    return this.ply - 1;
  }

  // ---------- puzzles from this game ----------

  /** The position shown, if it's your move with saved analysis: its puzzle (if it is one). */
  positionPuzzle(): { canMake: boolean; puzzle: { id: string; pick: boolean; type: string | null } | null } {
    const g = this.game;
    if (!g || this.analysis.active) return { canMake: false, puzzle: null };
    const ev = g.evals[this.ply];
    return { canMake: !!ev?.best_move_uci, puzzle: g.puzzles[this.ply] ?? null };
  }

  /** Make the position shown a puzzle (Puzzle Review → Type: Self made), with your tags. */
  async makePuzzle(tags: string[] = []): Promise<string | null> {
    const g = this.game;
    if (!g || !g.evals[this.ply]?.best_move_uci) return null;
    const r = await this.client.service('makePick', g.id, this.ply, tags);
    this.game = { ...g, puzzles: r.puzzles };
    this.notice = 'Made this position a puzzle — it\'s in Puzzle Review (Type: Self made).';
    this.changed();
    return r.id;
  }

  async removePuzzle(): Promise<void> {
    const g = this.game;
    const p = g?.puzzles[this.ply];
    if (!g || !p?.pick) return;
    await this.client.service('removePick', p.id);
    const puzzles = { ...g.puzzles };
    delete puzzles[this.ply];
    this.game = { ...g, puzzles };
    this.notice = 'Removed that puzzle.';
    this.changed();
  }

  // ---------- your notes on positions ----------

  /** Your note on the position shown ('' if none). */
  note(): string {
    return this.game?.notes?.[this.analysis.active ? -1 : this.ply] ?? '';
  }

  /** Where a note goes: the position shown. */
  notePlace(): { gameId: string; ply: number; fen: string } | null {
    return this.game && !this.analysis.active ? { gameId: this.game.id, ply: this.ply, fen: this.board.fen() } : null;
  }

  /** Saves a note on that position (empty: removed) — the position it was written on,
   *  even if you've moved on since. */
  async saveNote(place: { gameId: string; ply: number; fen: string }, text: string): Promise<void> {
    const notes = await this.client.service('saveNote', place.gameId, place.ply, place.fen, text);
    if (this.game?.id === place.gameId) this.game = { ...this.game, notes };
    // the games list: its 📝 count and the text the search box looks in
    const texts = Object.values(notes as Record<string, string>);
    this.games = this.games.map((g) => (g.id !== place.gameId ? g : { ...g, notes: texts.length, noteText: texts.join('\n'),
      label: g.label.replace(/ · 📝\d+$/, '') + (texts.length ? ` · 📝${texts.length}` : '') }));
    this.changed();
  }

  clearNotice(): void {
    if (!this.notice) return;
    this.notice = '';
    this.changed();
  }

  // ---------- the evaluation graph ----------

  /** Points (0..1 across, -1..1 up) for your moves' evaluations, and the marks. */
  graph(): { points: [number, number, string | null][]; at: number; prepTo: number | null; prepLine: boolean; puzzles: number[] } {
    const g = this.game;
    if (!g || !g.ucis.length) return { points: [], at: 0, prepTo: null, prepLine: false, puzzles: [] };
    const n = Math.max(g.ucis.length, 1);
    const points = Object.keys(g.evals).map(Number).sort((a, b) => a - b).map((ply): [number, number, string | null] => {
      const ev = g.evals[ply];
      const cp = Math.max(-GRAPH_CLAMP, Math.min(GRAPH_CLAMP, ev.cp_before));
      return [ply / n, cp / GRAPH_CLAMP, mark(ev)?.[2] ?? null];
    });
    return { points, at: this.ply / n, prepTo: g.prep?.inPrep ? g.prep.inPrep / n : null, prepLine: g.prep?.departure !== null && g.prep?.departure !== undefined,
      puzzles: Object.keys(g.puzzles).map((p) => Number(p) / n) };
  }

  graphClick(fraction: number): void {
    if (this.game) this.go(Math.round(fraction * this.game.ucis.length));
  }

  // ---------- your amazing moves ----------

  async loadAmazing(): Promise<void> {
    if (this.amazing || this.amazingBusy) return;
    this.amazingBusy = true;
    this.changed();
    this.amazing = await this.client.service('amazingMoves');
    this.amazingBusy = false;
    this.changed();
  }

  dispose(): void {
    this.analysis.dispose();
  }
}

