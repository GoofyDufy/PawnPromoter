/**
 * Number formatting identical to Python's f-strings. JavaScript's toFixed
 * rounds exact ties away from zero (62.5 -> "63"); Python rounds them to even
 * (62.5 -> "62"). Text the prototype shows ("You score 62%...", "+1.2") must
 * come out the same, so ties are detected on the exact binary value.
 */

/** f"{x:.{digits}f}" */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return String(x);
  const exact = Math.abs(x).toFixed(Math.min(100, digits + 40));   // toFixed is exact up to 100 digits
  const dot = exact.indexOf('.');
  const tail = exact.slice(dot + 1 + digits);
  if (tail[0] === '5' && /^50*$/.test(tail)) {
    // exact tie: round half to even
    const kept = exact.slice(0, dot + 1 + digits).replace(/\.$/, '');
    const lastDigit = Number(kept.replace('.', '').slice(-1));
    const scaled = BigInt(kept.replace('.', '')) + (lastDigit % 2 ? 1n : 0n);
    let s = scaled.toString().padStart(digits + 1, '0');
    if (digits) s = `${s.slice(0, -digits)}.${s.slice(-digits)}`;
    return (x < 0 ? '-' : '') + s;          // Python keeps the sign: f"{-0.05:.1f}" == "-0.0"
  }
  return x.toFixed(digits);
}

/** f"{x:+.{digits}f}" */
export function pySigned(x: number, digits: number): string {
  const s = pyFixed(x, digits);
  return s.startsWith('-') ? s : `+${s}`;
}

/** f"{x:.{digits}%}" */
export function pyPercent(x: number, digits = 0): string {
  return `${pyFixed(x * 100, digits)}%`;
}
