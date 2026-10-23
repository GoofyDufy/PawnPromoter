/**
 * Your goals (Progress → This week): short-term ones (this week, this month) and long-term ones, in your own words,
 * each with an optional target date, ticked off when done. Kept in the settings table (one JSON value), so they
 * travel with the database — a backup, an import, another computer.
 */
import type { Db } from './sqlite';

export type Horizon = 'short' | 'long';

export interface Goal {
  id: string;
  horizon: Horizon;
  text: string;
  /** Target date (YYYY-MM-DD), if you set one. */
  due: string | null;
  /** When it was ticked off (YYYY-MM-DD), or null while it's open. */
  done: string | null;
  created: string;
}

const KEY = 'goals';
const MAX_TEXT = 200;

/** Your goals: open ones first (the nearest target date first), then the ones you've done (latest first). */
export function list(conn: Db): Goal[] {
  const raw = conn.get('SELECT value FROM settings WHERE key = ?', [KEY])?.value;
  let goals: Goal[] = [];
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    goals = Array.isArray(parsed) ? parsed.filter((g) => g && typeof g.text === 'string' && (g.horizon === 'short' || g.horizon === 'long')) : [];
  } catch {
    goals = [];
  }
  return goals.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0)
    || (a.done && b.done ? b.done.localeCompare(a.done) : (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.created.localeCompare(b.created)));
}

function save(conn: Db, goals: Goal[]): Goal[] {
  conn.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [KEY, JSON.stringify(goals)]);
  return list(conn);
}

const today = () => new Date().toISOString().slice(0, 10);
const validDate = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

/** Adds a goal (empty text is ignored); returns the list. */
export function add(conn: Db, horizon: Horizon, text: string, due: string | null = null): Goal[] {
  const t = text.trim().slice(0, MAX_TEXT);
  if (!t) return list(conn);
  const goal: Goal = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, horizon, text: t, due: validDate(due), done: null, created: today() };
  return save(conn, [...list(conn), goal]);
}

/** Ticks a goal off, or opens it again. */
export function toggle(conn: Db, id: string): Goal[] {
  return save(conn, list(conn).map((g) => (g.id === id ? { ...g, done: g.done ? null : today() } : g)));
}

export function remove(conn: Db, id: string): Goal[] {
  return save(conn, list(conn).filter((g) => g.id !== id));
}
