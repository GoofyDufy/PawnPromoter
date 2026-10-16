/**
 * Opening Drill → My games (my_games_view.py, without the widgets): the
 * openings you play most, where you leave your own prep and why that's worse —
 * Stockfish's commentary (worked out once in the background and saved), your
 * results, what Lichess players at your level do, and what works best at
 * your level there (practical.ts). Picking a deviation shows it on the board:
 * green = your prep, red = what you played, amber = what works best.
 */
import { Board } from '../core/chess';
import type { Engine } from '../core/engine';
import * as explorer from '../core/explorer';
import * as openingCommentary from '../core/openingCommentary';
import * as practical from '../core/practical';
import type { DbClient } from '../data/client';
import type { MyDeviationView, MyGamesReport, OpeningUseView } from '../data/myGamesServices';
import type { Arrow } from './Board';

export const EVEN_CP = 15;              // under this, Stockfish calls the two moves even
export const MIN_RESULT_GAMES = 10;     // games each before comparing your results with Stockfish's verdict
export const ALL = 'All openings';

type PracticalState = practical.Choice[] | 'busy' | string;

export interface DeviationBoard {
  fen: string;
  orientation: 'white' | 'black';
  arrows: Arrow[];
  title: string;
  status: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export class MyGamesController {
  report: MyGamesReport | null = null;
  openings: OpeningUseView[] = [];
  opening = 0;                          // 0 = All openings, else openings[i - 1]
  shown: MyDeviationView[] = [];
  current: MyDeviationView | null = null;
  text = '';
  loading = false;
  board: DeviationBoard | null = null;

  private costs: Record<string, number> = {};
  private notesFor = new Map<string, openingCommentary.Notes>();
  private practicalFor = new Map<string, PracticalState>();
  private batchRunning = false;
  private stopped = false;
  private bands = '';
  private describeBands = '';

  constructor(
    private readonly client: DbClient,
    private readonly engine: Engine | null,
    private readonly changed: () => void,
    private readonly onReport: (r: MyGamesReport) => void = () => {},
  ) {}

  /** Shown: recompute after new games or every few minutes. */
  async refresh(): Promise<void> {
    this.loading = !this.report;
    this.changed();
    const r = await this.client.service('myGamesReport', false);
    this.report = r;
    this.costs = { ...r.costs, ...this.costs };
    this.openings = r.openings.filter((o) => o.games >= 3).slice(0, 30);
    if (this.opening > this.openings.length) this.opening = 0;
    const lichess = await this.client.service('lichessStatus');
    this.bands = lichess.bands;
    this.describeBands = lichess.describe;
    this.loading = false;
    this.filter();
    this.onReport(r);
    this.changed();
    void this.startBatch();
  }

  /** The report for the tree's stars, without waiting for the view to show. */
  async ensureReport(): Promise<MyGamesReport> {
    if (!this.report) await this.refresh();
    return this.report!;
  }

  summary(): string {
    const r = this.report;
    if (!r) return '';
    const left = r.openings.reduce((s, o) => s + o.left, 0);
    return `From your ${r.games} games: ${r.deviations.length} places where you left your own prep (${left} games). Pick one to see why it matters.`;
  }

  openingRow(o: OpeningUseView): string {
    const prep = o.left ? `left prep ${o.left}×` : o.followed ? 'in prep' : 'no prep';
    return `${o.name} (${o.color[0].toUpperCase()}) ${o.games} · ${pct(o.score)} · ${prep}`;
  }

  /** What a deviation costs you overall: how much worse × how often (unknown cost: by games). */
  private weight(d: MyDeviationView): number {
    const cost = this.costs[d.key];
    return cost !== undefined ? d.games * Math.max(cost - EVEN_CP, 0) : -1 / (1 + d.games);
  }

  row(d: MyDeviationView): string {
    const cost = this.costs[d.key];
    const sf = cost === undefined ? '' : Math.abs(cost) < 15 ? ' · even'
      : cost < 0 ? ` · better +${(-cost / 100).toFixed(2)}` : ` · −${(cost / 100).toFixed(2)}`;
    return `${d.line} (prep ${d.prepSans.join('/')}) ${d.games}×${sf}`;
  }

  setOpening(i: number): void {
    this.opening = i;
    this.filter();
    this.changed();
  }

  /** What costs you most first (once Stockfish has looked), then the rest by how often. */
  private filter(): void {
    let devs = this.report?.deviations ?? [];
    if (this.opening > 0) {
      const keys = new Set(this.openings[this.opening - 1].deviationKeys);
      devs = devs.filter((d) => keys.has(d.key));
    }
    this.shown = [...devs].sort((a, b) => (this.weight(b) - this.weight(a)) || (b.games - a.games));
  }

  emptyText(): string {
    return this.opening > 0 ? 'You always followed your prep here.' : 'No deviations yet — or no repertoire for these games.';
  }

  /** Show this deviation (from the list, or from a star on the tree). */
  async open(d: MyDeviationView): Promise<void> {
    if (!this.report) await this.refresh();
    if (!this.shown.some((x) => x.key === d.key)) {
      this.opening = 0;
      this.filter();
    }
    await this.show(this.shown.find((x) => x.key === d.key) ?? d);
  }

  private positionOf(d: MyDeviationView): Board {
    const board = Board.fromFen();
    for (const san of d.prefix) board.push(board.parseSan(san)!);
    return board;
  }

  private showBoard(d: MyDeviationView, best: practical.Choice | null): void {
    const arrow = (uci: string, brush: Arrow['brush']): Arrow => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), brush });
    const board = this.positionOf(d);
    this.board = {
      fen: board.fen(),
      orientation: board.turn,
      arrows: [...d.prepUcis.map((u) => arrow(u, 'green')), arrow(d.playedUci, 'red'), ...(best ? [arrow(best.uci, 'yellow')] : [])],
      title: `Move ${d.moveNumber}: you play ${d.playedSan}`,
      status: `Your prep: ${d.prepSans.join('/')} (green) · you played ${d.playedSan} (red)`
        + (best ? ` · works best at your level: ${best.san} (amber).` : `, ${d.games} time${d.games !== 1 ? 's' : ''}.`),
    };
  }

  private async show(d: MyDeviationView): Promise<void> {
    this.current = d;
    this.showBoard(d, this.practicalBestChoice(d));
    void this.requestPractical(d);
    const notes = this.notesFor.get(d.key) ?? await this.client.service('commentaryCached', d.fen, d.playedUci, d.prepUcis);
    if (notes) {
      this.notesFor.set(d.key, notes);
      this.text = await this.compose(d, notes);
      this.changed();
      return;
    }
    this.text = `${await this.compose(d, null)}\n\nStockfish is looking at both moves…`;
    this.changed();
    if (!this.engine) {
      this.text = `${await this.compose(d, null)}\n\nStockfish isn't available.`;
      this.changed();
      return;
    }
    try {
      const n = await openingCommentary.compare(this.engine, this.positionOf(d), d.playedUci, d.prepUcis);
      await this.saveNotes(d, n);
      if (this.current?.key === d.key) this.text = await this.compose(d, n);
    } catch (e) {
      if (this.current?.key === d.key) this.text = `${await this.compose(d, null)}\n\nStockfish couldn't look at it (${e instanceof Error ? e.message : e}).`;
    }
    this.changed();
  }

  private async saveNotes(d: MyDeviationView, n: openingCommentary.Notes): Promise<void> {
    await this.client.service('commentarySave', d.fen, d.playedUci, d.prepUcis, n);
    this.notesFor.set(d.key, n);
    if (this.costs[d.key] === undefined) {
      this.costs[d.key] = openingCommentary.cost(n);
      const keep = this.current;
      this.filter();
      this.current = keep;
    }
  }

  private async compose(d: MyDeviationView, notes: openingCommentary.Notes | null): Promise<string> {
    const parts: string[] = [];
    if (notes) parts.push(openingCommentary.text(notes));
    const mine = d.record;
    let line = `In your games: with ${d.playedSan} here you scored ${pct(mine.score)} (${mine.wins}W ${mine.draws}D ${mine.losses}L in ${mine.games})`;
    const prep = d.prepRecord;
    line += prep.games ? `; with your prep move ${pct(prep.score)} (${prep.games} games).` : "; you've never actually played your prep move here.";
    const cost = notes ? openingCommentary.cost(notes) : 0;
    if (notes && cost >= 40 && mine.games >= MIN_RESULT_GAMES && prep.games >= MIN_RESULT_GAMES && mine.score >= prep.score - 0.02) {
      line += ` So far it hasn't hurt your results — at your level Stockfish's edge often doesn't show, but against stronger players ${notes.mine_san} gives them an easier game.`;
    } else if (notes && cost >= 40 && mine.games >= MIN_RESULT_GAMES && prep.games >= MIN_RESULT_GAMES && mine.score < prep.score - 0.05) {
      line += ' Your results agree with Stockfish: you do better with your prep move.';
    }
    parts.push(line);
    // Lichess players at your level (cached data only)
    const { describe, stats } = await this.client.service('explorerStats', [d.fen]);
    const s = stats[d.fen] ? explorer.fromPlain(stats[d.fen]) : null;
    if (s && s.games) {
      const board = this.positionOf(d);
      const bits: string[] = [];
      for (const uci of [...d.prepUcis, d.playedUci]) {
        const m = s.moves.find((x) => x.uci === uci);
        if (m && m.games) bits.push(`${board.san(uci)} is played ${pct(m.games / s.games)} of the time and scores ${pct(m.scoreFor(board.turn))}`);
      }
      if (bits.length) parts.push(`Lichess players ${describe}: ${bits.join('; ')}.`);
    }
    if (d.repertoires.length) parts.push(`Your prep here comes from: ${d.repertoires.join(', ')}.`);
    const got = this.practicalFor.get(d.key);
    if (Array.isArray(got)) parts.push(practical.describe(got, this.describeBands));
    else if (got === 'busy') parts.push('Checking what works against players at your level here (Lichess + Stockfish)…');
    else if (got) parts.push(got);
    return parts.join('\n\n');
  }

  // ---------- what works at your level ----------

  private practicalBestChoice(d: MyDeviationView): practical.Choice | null {
    const got = this.practicalFor.get(d.key);
    if (!Array.isArray(got)) return null;
    const best = got.find((c) => practical.sound(c) && c.advantage_rate !== null) ?? null;
    return best && !d.prepUcis.includes(best.uci) && best.uci !== d.playedUci ? best : null;
  }

  /** SAN of the move that works best at your level, if known and neither prep nor yours. */
  practicalBest(d: MyDeviationView): string | null {
    return this.practicalBestChoice(d)?.san ?? null;
  }

  private async requestPractical(d: MyDeviationView): Promise<void> {
    const have = this.practicalFor.get(d.key);
    if (have !== undefined && have !== 'busy') return;
    const hit = await this.client.service('practicalCached', this.bands, d.fen, d.playedUci);
    if (hit) {
      this.practicalFor.set(d.key, hit);
      await this.afterPractical(d);
      return;
    }
    const token = await this.client.service('lichessToken');
    if (!token) {
      this.practicalFor.set(d.key, 'Connect Lichess (Add lines → Connect Lichess…) to see which moves work best against players at your level here.');
      return;
    }
    if (!this.engine || have === 'busy') return;
    this.practicalFor.set(d.key, 'busy');
    const bands = this.bands;
    const board = this.positionOf(d);
    try {
      const fetchStats = async (fen: string): Promise<explorer.PositionStats> => {
        await new Promise((r) => setTimeout(r, explorer.REQUEST_GAP_S * 1000));
        let data;
        try {
          data = await explorer.fetchStats(token, fen, bands);
        } catch (e) {
          if (!(e instanceof explorer.ExplorerError) || e.message !== 'rate limited') throw e;
          await new Promise((r) => setTimeout(r, explorer.RATE_LIMIT_WAIT_S * 1000));
          data = await explorer.fetchStats(token, fen, bands);
        }
        await this.client.service('explorerSave', fen, bands, data);
        return explorer.parse(data, fen);
      };
      const cachedOf = async (fen: string) => {
        const { stats } = await this.client.service('explorerStats', [fen]);
        return stats[fen] ? explorer.fromPlain(stats[fen]) : null;
      };
      const pos = (await cachedOf(d.fen)) ?? await fetchStats(d.fen);
      const ucis = practical.candidates(board, pos, d.prepUcis, d.playedUci);
      const after = new Map<string, explorer.PositionStats | null>();
      for (const uci of ucis) {
        const b = board.copy();
        b.push(uci);
        after.set(uci, (await cachedOf(b.fen())) ?? await fetchStats(b.fen()));
      }
      const choices = await practical.evaluate(this.engine, board, ucis, pos, after, d.prepUcis, d.playedUci);
      await this.client.service('practicalSave', bands, d.fen, d.playedUci, choices);
      this.practicalFor.set(d.key, choices);
    } catch (e) {
      this.practicalFor.set(d.key, `Couldn't check what works at your level (${e instanceof Error ? e.message : e}).`);
    }
    await this.afterPractical(d);
  }

  private async afterPractical(d: MyDeviationView): Promise<void> {
    if (this.current?.key !== d.key) return;
    this.showBoard(d, this.practicalBestChoice(d));
    this.text = await this.compose(d, this.notesFor.get(d.key) ?? null);
    this.changed();
  }

  /** Stockfish works out every deviation not looked at yet, one by one (saved, so only once). */
  private async startBatch(): Promise<void> {
    if (this.batchRunning || !this.engine || !this.report) return;
    const todo = this.report.deviations.filter((d) => this.costs[d.key] === undefined);
    if (!todo.length) return;
    this.batchRunning = true;
    this.stopped = false;
    try {
      for (const d of todo) {
        if (this.stopped) break;
        if (this.costs[d.key] !== undefined) continue;
        const n = await openingCommentary.compare(this.engine, this.positionOf(d), d.playedUci, d.prepUcis);
        await this.saveNotes(d, n);
        this.changed();
      }
    } catch {
      /* an engine error: whatever's left is tried again next time */
    }
    this.batchRunning = false;
  }

  /** Games where you played this deviation (newest first), for the list. */
  async games(d: MyDeviationView) {
    return this.client.service('gamesList', d.gameIds);
  }

  dispose(): void {
    this.stopped = true;
  }
}
