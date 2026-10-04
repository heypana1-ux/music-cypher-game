import { describe, expect, it } from 'vitest';
import { defaultConfig, normalizeConfig, PRESETS } from './config';
import { addDecision, computeState, findMatch, findPlayoff, makeDraw } from './engine';
import { overallStats, songHistoryIndex, songRuns, tournamentStats } from './stats';
import type { Decision, Song, Tournament, TournamentConfig } from './types';

function songs(n: number): Song[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    title: `Song ${i}`,
    artists: [`Artist ${i % 3}`],
    origin: 'demo' as const,
    originalIndex: i,
  }));
}

function make(id: string, n: number, config: TournamentConfig): Tournament {
  const list = songs(n);
  const { draw } = makeDraw(list, config, 1);
  return { id, name: id, createdAt: '', updatedAt: '2026-10-01T10:00:00Z', config, songs: list, seed: 1, draw, drawNotes: [], decisions: [], postponed: [] };
}

/** Always picks the songs with the lowest index, so song s0 wins every time. Scores = 10 − index. */
function finish(t: Tournament, steps = Infinity): Tournament {
  let k = 0;
  for (;;) {
    const state = computeState(t);
    if (state.finished || k++ >= steps) return t;
    const item = state.openItems[0];
    const at = new Date(Date.UTC(2026, 9, 1, 10, k)).toISOString();
    const m = findMatch(state, item.id);
    let d: Decision;
    const byIdx = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));
    if (m) {
      const order = m.songIds.slice().sort(byIdx);
      d = { id: `${t.id}-${k}`, targetId: m.id, songIds: m.songIds, at };
      if (m.evaluation === 'select') d.selected = order.slice(0, m.advanceCount);
      else d.order = order;
      if (m.evaluation === 'score') d.scores = Object.fromEntries(order.map((s) => [s, Math.max(1, 10 - Number(s.slice(1)))]));
      if (m.evaluation === 'score') {
        const sc = d.scores!;
        d.resolvedTies = [...new Set(Object.values(sc))].map((v) => order.filter((s) => sc[s] === v)).filter((c) => c.length > 1);
      }
    } else {
      const p = findPlayoff(state, item.id)!;
      d = { id: `${t.id}-${k}`, targetId: p.id, songIds: p.contested, at, selected: p.contested.slice().sort(byIdx).slice(0, p.contestedSpots) };
    }
    t = { ...t, decisions: addDecision(t, d)! };
  }
}

describe('stats', () => {
  it('song runs: champion 100 %, first-round losers 0 %, encounters add up', () => {
    const t = finish(make('a', 16, normalizeConfig({ ...defaultConfig(), format: 'duel' })));
    const runs = songRuns(t);
    const champ = runs.find((r) => r.champion)!;
    expect(champ.songId).toBe('s0');
    expect(champ.progress).toBe(1);
    expect(champ.encounters).toBe(4);
    expect(champ.advances).toBe(4);
    expect(runs.filter((r) => r.progress === 0).length).toBe(8);
    // every duel has two participants
    expect(runs.reduce((k, r) => k + r.encounters, 0)).toBe(15 * 2);
    expect(runs.filter((r) => r.stage === 'Finale').length).toBe(1);
  });

  it('tournament stats for a score tournament with extra spots', () => {
    const cfg = PRESETS.find((p) => p.id === 'cypher-blocks')!.config;
    const t = finish(make('b', 16, cfg));
    const st = tournamentStats(t);
    expect(st.progress).toBe(1);
    expect(st.scoreHistogram!.reduce((a, b) => a + b, 0)).toBeGreaterThan(16);
    expect(st.extraSpots).toBeGreaterThan(0);
    expect(st.topScores[0].value).toBe(10);
    expect(st.minutes).not.toBeNull();
    const a0 = st.artists.find((a) => a.key === 'artist 0')!;
    expect(a0.titles).toBe(1);
    expect(a0.songs).toBe(6);
  });

  it('running tournament: progress between 0 and 1, alive songs counted', () => {
    const t = finish(make('c', 16, defaultConfig()), 3);
    const st = tournamentStats(t);
    expect(st.alive).toBe(16 - 3 * 2);
    expect(st.progress).toBeGreaterThan(0);
    expect(st.progress).toBeLessThan(1);
    expect(st.runs.filter((r) => r.stage.startsWith('noch dabei')).length).toBe(10);
  });

  it('overall stats aggregate across tournaments and the history excludes the current one', () => {
    const a = finish(make('a', 8, defaultConfig()));
    const b = finish(make('b', 8, normalizeConfig({ ...defaultConfig(), format: 'duel' })));
    const c = make('c', 8, defaultConfig());
    const o = overallStats([a, b, c]);
    expect(o.tournaments).toBe(3);
    expect(o.finished).toBe(2);
    expect(o.running).toBe(1);
    expect(o.champions.map((x) => x.song.id)).toEqual(['s0', 's0']);
    const s0 = o.songs.find((s) => s.song.id === 's0')!;
    expect(s0.appearances).toBe(3);
    expect(s0.titles).toBe(2);
    expect(s0.avgProgress).toBe(1);
    expect(o.formats).toEqual({ duel: 1, cypher: 2 });
    const hist = songHistoryIndex([a, b, c], 'a');
    expect(hist.get('s0')).toMatchObject({ appearances: 2, titles: 1 });
  });

  it('empty input is safe', () => {
    const o = overallStats([]);
    expect(o.tournaments).toBe(0);
    expect(o.artists).toEqual([]);
  });
});
