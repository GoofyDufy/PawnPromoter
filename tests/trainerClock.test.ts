// Tactics & Threats timed mode: a clock per decision that runs while it's your decision, pauses while the
// engine or the opponent moves, hides with no decision, and calls timeUp() exactly once when it runs out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../src/data/client';
import { type ClockPhase, TrainerBase } from '../src/ui/trainer/base';

function fakeClient(settings: Record<string, string> = {}): DbClient {
  return {
    service: async (name: string, arg: Record<string, string> | string[]) => {
      if (name === 'getSettings') return Object.fromEntries((arg as string[]).map((k) => [k, settings[k]]));
      if (name === 'setSettings') Object.assign(settings, arg);
      return undefined;
    },
  } as unknown as DbClient;
}

class Drill extends TrainerBase {
  title = 'test';
  intro = '';
  phase: ClockPhase = 'off';
  timeUps = 0;
  sessionLine() { return ''; }
  sessionDetail() { return ''; }
  async onShown() {}
  async onMove() {}
  press() {}
  gameAt() { return null; }
  protected clockPhase(): ClockPhase { return this.phase; }
  protected timeUp(): void { this.timeUps += 1; this.phase = 'off'; this.changed(); }
  /** A new decision in a given phase (what the drills do at the start of a round / your next move). */
  decide(phase: ClockPhase) { this.phase = phase; this.freshClock(); this.changed(); }
  set(phase: ClockPhase) { this.phase = phase; this.changed(); }
}

describe('the trainer clock', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs on your decision, pauses for the engine, and times out once', async () => {
    const settings: Record<string, string> = {};
    const d = new Drill(fakeClient(settings), null, () => {});
    d.setClock(15);
    expect(settings.trainer_clock).toBe('15');
    d.decide('run');
    vi.advanceTimersByTime(10_000);
    expect(Math.round(d.clockLeft! / 1000)).toBe(5);
    expect(d.clockRunning).toBe(true);
    d.set('pause');                                   // the engine checks your move
    vi.advanceTimersByTime(30_000);
    expect(Math.round(d.clockLeft! / 1000)).toBe(5);
    expect(d.clockRunning).toBe(false);
    d.set('run');                                     // your move again (a retry): the same clock
    vi.advanceTimersByTime(5_200);
    expect(d.timeUps).toBe(1);
    expect(d.timedOut).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(d.timeUps).toBe(1);                        // never twice
    expect(d.clockLeft).toBe(null);                   // the result: no clock
  });

  it('a fresh decision gets the full time; untimed shows no clock', () => {
    const d = new Drill(fakeClient(), null, () => {});
    d.setClock(10);
    d.decide('run');
    vi.advanceTimersByTime(8_000);
    d.decide('run');                                  // your next move in the line
    expect(Math.round(d.clockLeft! / 1000)).toBe(10);
    expect(d.timedOut).toBe(false);
    d.setClock(0);
    expect(d.clockLeft).toBe(null);
    d.decide('run');
    vi.advanceTimersByTime(60_000);
    expect(d.timeUps).toBe(0);
  });

  it('changing the time mid-decision starts it over; the setting is remembered', async () => {
    const settings: Record<string, string> = { trainer_clock: '30' };
    const d = new Drill(fakeClient(settings), null, () => {});
    await d.loadClock();
    expect(d.clockLimit).toBe(30);
    d.decide('run');
    vi.advanceTimersByTime(25_000);
    d.setClock(45);
    expect(Math.round(d.clockLeft! / 1000)).toBe(45);
    d.setClock(9999);
    expect(d.clockLimit).toBe(600);                   // capped at 10 minutes
  });

  it('a clock picked while the saved one is still loading wins', async () => {
    const d = new Drill(fakeClient({ trainer_clock: '0' }), null, () => {});
    const loading = d.loadClock();
    d.setClock(20);
    await loading;
    expect(d.clockLimit).toBe(20);
  });
});
