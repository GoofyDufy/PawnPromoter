// Opening Drill's logic (drill_tab.py's drill flow) without a screen: the
// controller over the real services on an in-memory database.
import { describe, expect, it } from 'vitest';
import * as db from '../src/core/db';
import { openMemoryDb } from '../src/core/sqlite';
import type { DbClient } from '../src/data/client';
import { services } from '../src/data/services';
import { AFTER_CORRECT_MS, DrillController, OPPONENT_DELAY_MS, plansFor } from '../src/ui/drillController';
import type { OpeningData } from '../src/ui/openingData';

const LONDON = `[Event "London - Main"]

1. d4 d5 2. Bf4 Nf6 (2... c5 3. e3) 3. e3 *
`;

async function setup() {
  const conn = db.initDb(await openMemoryDb());
  const client = {
    service: async (name: keyof typeof services, ...args: unknown[]) => (services[name] as (...a: unknown[]) => unknown)(conn, ...args),
  } as unknown as DbClient;
  const started: (string | null)[] = [];
  const data = { start: (name: string | null) => started.push(name), stop: () => {}, subscribe: () => () => {}, state: { progress: null, version: 0 } };
  const levels: number[] = [];
  const c = new DrillController(client, data as unknown as OpeningData, (l) => levels.push(l.totalXp));
  await c.init();
  return { c, conn, started, levels };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Opening Drill', () => {
  it('opens on Add lines with nothing to drill, then imports a line and selects it', async () => {
    const { c } = await setup();
    expect(c.view).toBe('Add lines');
    expect(c.status.text).toMatch(/^No repertoires yet/);
    expect(await c.importPgn(LONDON, 'London', 'white')).toBeGreaterThan(0);
    expect(c.repertoires.map((r) => r.label)).toEqual(['All White openings', 'London (white)']);
    expect(c.repertoire).toBe('London (white)');
    expect(c.variations.map((v) => v.label)).toEqual(['Any line (random)', 'London - Main']);
    await c.selectVariation(1);
    expect(c.preview).toBe('1. d4 d5 2. Bf4 Nf6 3. e3  (+1 alternative branch)');
    expect(c.plans?.title).toMatch(/London/);
  });

  it('drills a line: right moves, the reply, a miss, retry, and the end-of-line recap', async () => {
    const { c, levels } = await setup();
    await c.importPgn(LONDON, 'London', 'white');
    await c.start();
    expect(c.view).toBe('Plans');
    expect(c.lineTitle()).toBe('Drilling: London - Main');
    expect(c.status.text).toBe('Your move.');
    expect(c.board().movable).toBe('white');
    await c.onMove('e2e4');                                  // not the line
    expect(c.status).toEqual({ text: 'Not correct — you played e4.', tone: 'error' });
    expect(c.buttons().retry).toBe(true);
    expect(c.board().movable).toBe(null);
    c.retry();
    await c.onMove('d2d4');
    expect(c.status.text).toBe('Correct — d4.');
    await sleep(AFTER_CORRECT_MS + 50);
    expect(c.status.text).toBe('Opponent played d5. Your move.');
    await c.onMove('c1f4');
    await sleep(AFTER_CORRECT_MS + OPPONENT_DELAY_MS + 100);
    const reply = c.drill!.path[3].san;                       // Nf6 or c5: either branch
    expect(c.status.text).toBe(`Opponent played ${reply}. Your move.`);
    await c.onMove('e2e3');
    await sleep(AFTER_CORRECT_MS + 50);
    expect(c.drill!.finished).toBe(true);
    expect(c.status.text).toBe('End of line — nice work. Go again, or try a new random line.');
    expect(c.recap).toBe(`London - Main:\n1. d4 d5 2. Bf4 ${reply} 3. e3`);
    expect(c.buttons().end).toBe(true);
    expect(levels.length).toBe(1);
    c.dispose();
  });

  it('Show full line: ◀ ▶ step through it without touching the drill', async () => {
    const { c } = await setup();
    await c.importPgn(LONDON, 'London', 'white');
    await c.start();
    c.toggleFullLine();
    expect(c.recap).toMatch(/^Full line: 1\. d4 d5 2\. Bf4/);
    c.stepPreview(1);
    expect(c.status.text).toBe('Viewing the line: after 1. d4 (1/5). Step back to where you were, or Hide full line, to keep drilling.');
    expect(c.board().movable).toBe(null);
    c.stepPreview(-1);
    expect(c.status.text).toBe('Back to the drill — your move.');
    expect(c.board().movable).toBe('white');
    c.dispose();
  });

  it('Show correct move plays it and offers Same line / New random line', async () => {
    const { c } = await setup();
    await c.importPgn(LONDON, 'London', 'white');
    await c.start();
    await c.onMove('e2e4');
    await c.reveal();
    expect(c.status.text).toBe('Correct move was d4. Keep going, or start over with Same line.');
    expect(c.buttons().restart).toBe(true);
    await c.sameLine();
    expect(c.drill!.index).toBe(0);
    c.dispose();
  });

  it('plans put your side first', () => {
    const black = plansFor('Caro-Kann Defense', 'Caro-Kann', 'black');
    expect(black?.sides[0].heading).toBe('Your plans (BLACK)');
  });
});
