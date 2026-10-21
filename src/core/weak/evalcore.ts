/**
 * The weakness stats' pure math (SPEC §3 and the §5 phase rule) — port of
 * ~/WeaknessStats/weakstats/evalcore.py. No I/O. Every sign convention lives
 * here and is pinned by the §8 golden vectors in tests/weakEvalcore.test.ts.
 */

export const K = 0.00368208;
export const MATE_CP = 10000;
export const CAP = 1000;

export type MoveClass = 'Excellent' | 'Good' | 'Inaccuracy' | 'Mistake' | 'Blunder';

export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

// §3.1 perspective normalisation

/** A side-to-move score (cp or mate distance) in White POV. */
export const toWhite = (value: number, whiteToMove: boolean): number => (whiteToMove ? value : -value);

export const moverPov = (x: number, moverIsWhite: boolean): number => (moverIsWhite ? x : -x);

// §3.2 derived evaluations

/** [cp_raw_white, cp_cap_white, mate_white] for one stored position.
 *  v1.2 F1: a checkmated position is mate 0 and the side to move has lost,
 *  so its sign comes from the side to move, never from the mate distance. */
export function derive(scoreType: 'cp' | 'mate', scoreValue: number, whiteToMove: boolean,
  checkmated = false): [number, number, number | null] {
  if (checkmated) {
    const raw = whiteToMove ? -MATE_CP : MATE_CP;
    return [raw, clamp(raw, -CAP, CAP), 0];
  }
  if (scoreType === 'mate') {
    const mw = toWhite(scoreValue, whiteToMove);
    if (mw === 0) throw new Error('mate 0 must be passed as checkmated');
    const raw = mw > 0 ? MATE_CP : -MATE_CP;
    return [raw, clamp(raw, -CAP, CAP), mw];
  }
  const raw = toWhite(scoreValue, whiteToMove);
  return [raw, clamp(raw, -CAP, CAP), null];
}

// §3.3–3.5 per-move quantities

export const winPct = (cp: number): number => 100 / (1 + Math.exp(-K * cp));

/** Centipawn loss on capped values; null when either ply is a mate score. */
export function cpl(capBefore: number, capAfter: number, moverIsWhite: boolean, mateInvolved: boolean): number | null {
  if (mateInvolved) return null;
  return Math.max(0, moverPov(capBefore, moverIsWhite) - moverPov(capAfter, moverIsWhite));
}

/** Win%-loss in percentage points; mate-involving moves get one too. */
export function wpl(capBefore: number, capAfter: number, moverIsWhite: boolean): number {
  return Math.max(0, winPct(moverPov(capBefore, moverIsWhite)) - winPct(moverPov(capAfter, moverIsWhite)));
}

export const moveAccuracy = (wplPp: number): number => clamp(103.1668 * Math.exp(-0.04354 * wplPp) - 3.1669, 0, 100);

/** §3.7 — by win%-loss, never by raw centipawns. */
export function classify(wplPp: number): MoveClass {
  if (wplPp < 2) return 'Excellent';
  if (wplPp < 5) return 'Good';
  if (wplPp < 10) return 'Inaccuracy';
  if (wplPp < 20) return 'Mistake';
  return 'Blunder';
}

// §3.6 game accuracy

/** The harmonic mean is undefined at 0 (spec gap G-HM, as in the prototype). */
export const HM_FLOOR = 1.0;

/** hm_am_v1: (harmonic mean + arithmetic mean) / 2 over included moves. */
export function gameAccuracy(accs: number[]): number | null {
  if (!accs.length) return null;
  const am = accs.reduce((a, b) => a + b, 0) / accs.length;
  const hm = accs.length / accs.reduce((a, x) => a + 1 / Math.max(x, HM_FLOOR), 0);
  return (hm + am) / 2;
}

// §5 dead zone and phase

export function inDeadZone(capBefore: number, capAfter: number, moverIsWhite: boolean): boolean {
  const b = winPct(moverPov(capBefore, moverIsWhite));
  const a = winPct(moverPov(capAfter, moverIsWhite));
  return (b >= 97 && a >= 97) || (b <= 3 && a <= 3);
}

const PIECE_WEIGHT: Record<string, number> = { n: 1, b: 1, r: 2, q: 4 };

/** Sum over both sides of N=1, B=1, R=2, Q=4 (24 at the start). */
export const phaseWeight = (pieceLetters: Iterable<string>): number =>
  [...pieceLetters].reduce((s, p) => s + (PIECE_WEIGHT[p.toLowerCase()] ?? 0), 0);

export type Phase = 'opening' | 'middlegame' | 'endgame';

export function phase(moveNumber: number, weight: number, hasQueens: boolean, isBook: boolean): Phase {
  if ((moveNumber <= 10 && weight >= 20) || (isBook && moveNumber <= 15)) return 'opening';
  if (weight <= 6 || (!hasQueens && weight <= 10)) return 'endgame';
  return 'middlegame';
}
