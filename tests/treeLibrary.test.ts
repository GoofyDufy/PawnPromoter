// Opening Drill's Tree (drill_tab.py's tree methods) and the opening library
// (library_window.py's database work), over the real services on an
// in-memory database.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as db from '../src/core/db';
import { openMemoryDb } from '../src/core/sqlite';
import type { DbClient } from '../src/data/client';
import type { RepertoireEntry } from '../src/data/drillServices';
import { services } from '../src/data/services';
import { ALL_SCOPE, TreeController, type TreeHost } from '../src/ui/treeController';
import { shortName } from '../src/ui/treeHelpers';

const LONDON = `[Event "London - Main"]

1. d4 d5 2. Bf4 Nf6 (2... c5 3. e3) 3. e3 *
`;

async function setup() {
  const conn = db.initDb(await openMemoryDb());
  const client = {
    service: async (name: keyof typeof services, ...args: unknown[]) => (services[name] as (...a: unknown[]) => unknown)(conn, ...args),
  } as unknown as DbClient;
  return { conn, client };
}

function host(client: DbClient, answers: { name?: string | null; confirm?: boolean } = {}) {
  let reps: RepertoireEntry[] = [];
  const log: string[] = [];
  const h: TreeHost & { status: string; title: string; tree: TreeController | null; refresh(): Promise<void> } = {
    status: '', title: '', tree: null,
    setStatus(text) { h.status = text; },
    setMoveNote() {},
    setTitle(text) { h.title = text; },
    changed() {},
    repertoires: () => reps,
    selected: () => reps.find((r) => !r.group) ?? null,
    lichessConnected: () => false,
    drill: () => null,
    drillShown: () => false,
    stopDrill() {},
    async drillLine(name, color, ids) { log.push(`drill ${name} ${color} ${ids.length}`); },
    async refreshRepertoires() { reps = await client.service('repertoires'); h.tree?.invalidate(); },
    async askName() { return answers.name ?? ''; },
    async confirm() { return answers.confirm ?? true; },
    showMyDeviation() {},
    async refresh() { reps = await client.service('repertoires'); },
  };
  return { h, log };
}

describe('the Tree', () => {
  it('builds from your lines, selects, steps along a line and grows a new branch', async () => {
    const { client } = await setup();
    await client.service('importPgn', LONDON, 'London', 'white');
    const { h, log } = host(client, { name: 'my idea' });
    await h.refresh();
    const t = new TreeController(client, h, null);
    h.tree = t;
    await t.init();
    await t.onShown();
    expect(t.scope).toBe('London (white)');           // the repertoire picked in Setup
    await t.setScope(ALL_SCOPE.white);
    expect(t.tree!.leaves.length).toBe(2);
    expect(t.movesLabel).toBe('Starting position   ·   2 lines from here');
    await t.step(1);
    await t.step(1);
    expect(t.movesLabel).toBe('1.d4 d5   ·   2 lines from here');
    expect(h.title).toBe('Exploring: London · Main');
    // a move your lines don't have: a new branch, saved as its own line
    await t.step(1);                                    // 2.Bf4
    await t.exploreMove('c7c6');
    expect(t.draft).toEqual(['c7c6']);
    expect(t.lineLabel).toBe('New branch');
    await t.saveDraft();
    expect(h.status).toBe('Saved “my idea” to London.');
    expect(t.tree!.leaves.length).toBe(3);
    await t.drillThisLine();
    expect(log[0]).toMatch(/^drill London white \d+$/);
  });

  it('deletes a branch and moves where an opening starts', async () => {
    const { client } = await setup();
    await client.service('importPgn', LONDON, 'London', 'white');
    const { h } = host(client);
    await h.refresh();
    const t = new TreeController(client, h, null);
    h.tree = t;
    await t.init();
    await t.onShown();
    const c5 = t.tree!.nodeForPath(['d2d4', 'd7d5', 'c1f4', 'c7c5'])!;
    await t.deleteBranch(c5);
    expect(h.status).toBe('Deleted 1 line(s) (2 moves).');
    expect(t.tree!.leaves.length).toBe(1);
    const d5 = t.tree!.nodeForPath(['d2d4', 'd7d5'])!;
    await t.setOpeningStart('London', d5);
    expect(t.starts.map(([r, n]) => [r, n.path.map((m) => m.move_uci).join(' ')])).toEqual([['London', 'd2d4 d7d5']]);
  });

  it('short names inside a repertoire and across all of them', () => {
    expect(shortName('Catalan - Closed', 'Catalan')).toBe('Closed');
    expect(shortName('Catalan - Closed', '')).toBe('Catalan · Closed');
  });
});

describe('the opening library', () => {
  it('loads the pre-built library, searches it, flags your repertoire and adds lines', async () => {
    const { client } = await setup();
    const built = JSON.parse(readFileSync(fileURLToPath(new URL('../public/openings/library.json', import.meta.url)), 'utf8'));
    expect(await client.service('libraryLoad', built)).toBe(built.rows.length);
    const search = { query: 'Najdorf', family: null, character: null, show: 'All lines', sort: 'Book order' };
    const found = await client.service('librarySearch', search);
    expect(found.rows.length).toBeGreaterThan(5);
    expect(found.rows[0].label).toMatch(/^○ B\d\d {2}/);
    const first = found.rows[0];
    const detail = (await client.service('libraryDetail', first.id))!;
    expect(detail.flag).toBe('out');
    expect(detail.character).toMatch(/Sharp|Balanced|Quiet/);
    expect(await client.service('libraryAdd', [first.id], 'Sicilian', 'black')).toBeGreaterThan(0);
    const after = (await client.service('libraryDetail', first.id))!;
    expect(after.flag).toBe('in');
    expect(after.flagColor).toBe('black');
    const mine = await client.service('librarySearch', { ...search, show: 'In my repertoire' });
    expect(mine.rows.map((r) => r.id)).toContain(first.id);
  });
});
