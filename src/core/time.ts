/**
 * Dates the way the Python prototype stores them: datetime.isoformat() on a
 * naive LOCAL time — "2026-10-14T21:34:01.123456", no timezone. Queries
 * compare these strings directly (e.g. due_date <= now), so the web app must
 * write exactly the same shape or a database imported from the desktop app
 * would mis-order. Never use Date.toISOString() (UTC, "Z") for stored dates.
 */

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** dt.datetime.isoformat() of a local time (microseconds dropped when zero, like Python). */
export function isoformat(d: Date): string {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ms = d.getMilliseconds();
  return ms ? `${base}.${pad(ms, 3)}000` : base;
}

/** dt.datetime.now().isoformat() */
export function nowIso(): string {
  return isoformat(new Date());
}

/** dt.date.isoformat(): "YYYY-MM-DD" in local time. */
export function dateIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** dt.date.today().isoformat() */
export function todayIso(): string {
  return dateIso(new Date());
}

/** dt.datetime.fromisoformat() for the naive local strings above (and plain dates). */
export function fromIso(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?/.exec(s);
  if (!m) throw new Error(`not an ISO date: ${s}`);
  const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '0'] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +sec, Math.floor(+frac.padEnd(6, '0') / 1000));
}

/** datetime + timedelta(days=n), keeping local wall-clock time across DST like Python. */
export function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/** Monday of the week containing `d` (date - timedelta(days=d.weekday())). */
export function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}
