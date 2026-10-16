// Port of the prototype's tests for My games (my_openings), practical moves,
// opening principles, the opening library, your games per line and the
// library's sharp / quiet facts (67e3b53).
import { describe, expect, it } from 'vitest';
import { Board, STARTING_FEN } from '../src/core/chess';
import * as db from '../src/core/db';
import * as libraryCharacter from '../src/core/libraryCharacter';
import { makeGame } from '../src/core/models';
import * as myLines from '../src/core/myLines';
import * as myOpenings from '../src/core/myOpenings';
import { importPgnText } from '../src/core/openingImporter';
import * as commentary from '../src/core/openingCommentary';
import * as library from '../src/core/openingLibrary';
import * as practical from '../src/core/practical';
import { openMemoryDb } from '../src/core/sqlite';

const START = STARTING_FEN;
const freshConn = async () => db.initDb(await openMemoryDb());

const QG_PGN = `[Event "QG - Orthodox"]

1. d4 d5 2. c4 e6 3. Nc3 {note on Nc3} Nf6 *

[Event "QG - Slav"]

1. d4 d5 2. c4 c6 3. Nf3 Nf6 *
`;

describe('My games: your openings as you play them', () => {
  const setup = async () => {
    const conn = await freshConn();
    importPgnText(QG_PGN, 'QG', 'white', conn);
    const add = (moves: string, result: 'win' | 'loss' | 'draw', url: string) => db.saveGame(conn, makeGame({
      chess_com_url: url, pgn: `[Event "x"]\n[WhiteElo "1650"]\n\n${moves} *\n`, played_at: '2026-09-01T00:00:00',
      time_control: '900+10', my_color: 'white', opponent_username: 'opp', result }));
    return { conn, add };
  };

  it('your own deviations, with results', async () => {
    const { conn, add } = await setup();
    add('1. d4 d5 2. Nf3 Nf6', 'loss', 'a');            // you leave prep (2.c4)
    add('1. d4 d5 2. Nf3 e6', 'win', 'b');
    add('1. d4 d5 2. c4 e6 3. Nc3 Nf6', 'win', 'c');     // followed
    add('1. d4 Nf6 2. Nf3', 'draw', 'd');                // opponent left first: not yours
    const r = myOpenings.compute(conn);
    expect(r.deviations.length).toBe(1);
    const d = r.deviations[0];
    expect([d.played_san, d.prep_sans, d.games, d.move_number]).toEqual(['Nf3', ['c4'], 2, 2]);
    expect([d.record.wins, d.record.losses]).toEqual([1, 1]);
    expect(d.prep_record.games).toBe(1);                  // 2.c4 played once there
    expect(d.repertoires).toEqual(['QG']);
    const o = r.opponent_deviations[0];                   // 1...Nf6: they left first
    expect([o.played_san, o.prep_sans, o.games, o.usual_reply, o.record.draws]).toEqual(['Nf6', ['d5'], 1, 'Nf3', 1]);
  });

  it('prep path says who left', async () => {
    const { conn } = await setup();
    const rep = myOpenings.repertoireFor(conn, 'white');
    const path = (moves: string) => {
      const b = Board.fromFen();
      return myOpenings.prepPath(rep, moves.split(' ').map((san) => b.pushSan(san)), 'white');
    };
    let p = path('d4 d5 Nf3 Nf6');                         // your 2.Nf3 (prep: 2.c4)
    expect([p.reason, p.in_prep, p.departure_ply, p.played_san, p.prep_sans]).toEqual(['you', 2, 2, 'Nf3', ['c4']]);
    p = path('d4 Nf6 c4');                                 // their 1...Nf6
    expect([p.reason, p.in_prep, p.played_san]).toEqual(['opponent', 1, 'Nf6']);
    expect(path('d4 d5 c4 e6 Nc3 Nf6 Bg5').reason).toBe('ended');   // your prep stops after 3...Nf6
    expect(path('e4 e5').reason).toBe('you');                       // your prep starts 1.d4
    const empty = myOpenings.repertoireFor(conn, 'black');           // no Black repertoire at all
    expect(myOpenings.prepPath(empty, ['e2e4'], 'black').reason).toBe('none');
  });

  it('opening principles', () => {
    const b = Board.fromFen();
    b.pushSan('d4');
    b.pushSan('d5');
    const texts = (san: string) => commentary.principles(b, b.parseSan(san)!).map((f) => f.text).join(' | ');
    expect(texts('Nc3')).toContain('in front of your c-pawn');
    expect(texts('f3')).toContain('square from your knight on g1');
    expect(texts('f3')).toContain('diagonal to your king');
    expect(texts('Nf3')).toContain('develops the knight');
    b.pushSan('Bf4');
    b.pushSan('e6');
    expect(texts('Bg3')).toContain('a second time');
  });

  it('practical ranking and cache', async () => {
    const C = (uci: string, san: string, evalCp: number, share: number | null, games: number, score: number | null,
      adv: number | null, avg: number | null, replies: practical.Reply[], tags: string[] = []): practical.Choice =>
      ({ uci, san, eval_cp: evalCp, share, games, score, advantage_rate: adv, avg_cp: avg, replies, tags });
    const choices = [
      C('g1f3', 'Nf3', 30, 0.6, 900, 0.55, 0.10, 35, [{ san: 'Nc6', share: 1.0, cp: 35 }], ['your prep']),
      C('e2e3', 'e3', 20, 0.1, 150, 0.52, 0.60, 55, [{ san: 'Nc6', share: 0.6, cp: 70 }, { san: 'e6', share: 0.4, cp: 30 }]),
      C('g2g4', 'g4', -120, 0.01, 40, 0.45, 0.90, 80, []),            // popular with nobody, unsound
    ];
    const ranked = practical.rank(choices);
    expect(ranked.map((c) => c.san)).toEqual(['e3', 'Nf3', 'g4']);
    const text = practical.describe(ranked, 'rated 1400–2000');
    expect(text).toContain('In practice e3 gets you an edge most often');
    expect(text).toContain('not sound');
    const conn = await freshConn();
    practical.save(conn, '1400', START, 'b1c3', ranked);
    const back = practical.cached(conn, '1400', START, 'b1c3')!;
    expect(back.map((c) => [c.san, c.replies.length ? c.replies[0].san : null])).toEqual([['e3', 'Nc6'], ['Nf3', 'Nc6'], ['g4', null]]);
    expect(practical.cached(conn, '1400', START, 'g1f3')).toBeNull();
  });
});

const LIBRARY_TSV = `eco\tname\tpgn
B90\tSicilian Defense: Najdorf Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6
B90\tSicilian Defense: Najdorf Variation, English Attack\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3
D06\tQueen's Gambit\t1. d4 d5 2. c4
`;

describe('the opening library', () => {
  const setup = async () => {
    const conn = await freshConn();
    library.save(conn, library.parse(LIBRARY_TSV));
    return conn;
  };

  it('search by name, ECO and moves', async () => {
    const conn = await setup();
    expect(library.count(conn)).toBe(3);
    expect(library.families(conn)).toEqual([["Queen's Gambit", 1], ['Sicilian Defense', 2]]);
    expect(library.search(conn, 'najdorf').length).toBe(2);
    expect(library.search(conn, 'B9').length).toBe(2);
    expect(library.search(conn, 'd4 d5').map((o) => o.name)).toEqual(["Queen's Gambit"]);
    const attack = library.search(conn, 'English Attack')[0];
    expect([attack.variation, attack.last_move, attack.plies]).toEqual(['Najdorf Variation, English Attack', '6. Be3', 11]);
  });

  it('your games per line', async () => {
    const conn = await setup();
    const game = (id: string, moves: string, result: 'win' | 'loss' | 'draw', color: 'white' | 'black' = 'black') =>
      db.saveGame(conn, makeGame({ id, chess_com_url: id, pgn: `[Event "x"]\n\n${moves} *\n`, played_at: '2026-09-01T00:00:00',
        time_control: '600', my_color: color, opponent_username: 'o', result }));
    game('a', '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5', 'win');
    game('b', '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Bg5', 'loss');    // Najdorf (no 6.Be3)
    game('c', '1. d4 d5 2. c4 e6', 'draw', 'white');
    expect(myLines.unmatched(conn).length).toBe(3);
    myLines.save(conn, myLines.matchAll(conn, conn.all('SELECT id FROM games').map((r) => r.id)));
    expect(myLines.unmatched(conn)).toEqual([]);
    const names = new Map(library.search(conn).map((o) => [o.id, o.name]));
    const recs = new Map([...myLines.records(conn).values()].map((r) => [`${names.get(r.library_id)}|${r.color}`, r]));
    expect(recs.get('Sicilian Defense: Najdorf Variation, English Attack|black')!.record.wins).toBe(1);
    expect(recs.get('Sicilian Defense: Najdorf Variation|black')!.record.losses).toBe(1);
    expect(recs.get("Queen's Gambit|white")!.record.draws).toBe(1);
    expect(myLines.describe(recs.get("Queen's Gambit|white")!)).toContain('As white: 1 game, 50%');
  });

  it('character facts from the board', () => {
    const facts = (moves: string, name: string, later: number | null = null) => {
      const b = Board.fromFen();
      for (const m of moves.split(' ')) b.pushSan(m);
      return libraryCharacter.boardFacts(b, name, 0, later).map(([, t]) => t).join(' | ');
    };
    expect(facts('e4 e5 f4 exf4', "King's Gambit Accepted")).toContain('a gambit');
    expect(facts('e4 e5 f4 exf4', "King's Gambit Accepted")).toContain('White is a pawn down for activity');
    expect(facts('e4 e6 d4 d5 e5', 'French Defense: Advance Variation')).toContain('the centre is locked');
    expect(facts('e4 e5 Nf3 Nf6', "Petrov's Defense")).not.toContain('locked');          // e4/e5 alone: open
    expect(facts('c4 c5 Nc3 Nc6 g3 g6', 'English Opening: Symmetrical Variation')).toContain('symmetrical');
    // a pawn taken and soon won back isn't a gambit
    expect(facts('d4 d5 c4 dxc4', "Queen's Gambit Accepted Declined", 0)).not.toContain('down');
  });

  it('repertoire flag', async () => {
    const conn = await setup();
    const najdorf = library.search(conn, 'Najdorf Variation, English Attack')[0];
    expect(library.status(najdorf, {})[0]).toBe('out');
    const plain = library.search(conn, 'najdorf').find((o) => o.name === 'Sicilian Defense: Najdorf Variation')!;
    importPgnText(library.toPgn([plain]), 'N', 'black', conn);
    const mine = { white: library.repertoireMoves(conn, 'white'), black: library.repertoireMoves(conn, 'black') };
    expect(library.status(plain, mine)).toEqual(['in', 'black', 10]);
    expect(library.status(najdorf, mine)).toEqual(['partly', 'black', 10]);        // 10 of its 11
  });

  it('adding to the repertoire keeps names and marks lines covered', async () => {
    const conn = await setup();
    const picked = library.search(conn, 'najdorf');
    let mine = library.repertoireMoves(conn, 'black');
    expect(picked.some((o) => library.covered(o, mine))).toBe(false);
    importPgnText(library.toPgn(picked), 'Najdorf', 'black', conn);
    expect(new Set(conn.all('SELECT DISTINCT line_name FROM opening_lines').map((r) => r.line_name)))
      .toEqual(new Set(picked.map((o) => o.name)));
    mine = library.repertoireMoves(conn, 'black');
    expect(picked.every((o) => library.covered(o, mine))).toBe(true);
  });

  it('loads the pre-built library with its descriptions', async () => {
    const conn = await freshConn();
    library.save(conn, library.fromBuilt({ columns: ['eco', 'name', 'family', 'pgn', 'sans', 'ucis', 'plies', 'character',
      'sharpness', 'description', 'eval_cp', 'char_version'], rows: [['C30', "King's Gambit", "King's Gambit", '1. e4 e5 2. f4',
      'e4 e5 f4', 'e2e4 e7e5 f2f4', 3, 'Sharp', 4, 'A gambit.', 20, 1]] }));
    const [o] = library.search(conn, "King's");
    expect([o.character, o.description, o.eval_cp, o.plies]).toEqual(['Sharp', 'A gambit.', 20, 3]);
    expect(library.search(conn, '', null, 600, 'Sharp').length).toBe(1);
    expect(library.undescribed(conn, 1)).toEqual([]);
  });
});
