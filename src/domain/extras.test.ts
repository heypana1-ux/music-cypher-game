import { describe, expect, it } from 'vitest';
import { spotifyExport } from '../library/spotifyExport';
import { defaultConfig, normalizeConfig } from './config';
import { addDecision, computeState, makeDraw } from './engine';
import { agreement, aggregateVotes, applyTieOrder } from './party';
import { computeRatings, START_RATING } from './rating';
import { resultOrder } from './results';
import { tournamentStats } from './stats';
import type { Decision, Song, Tournament, TournamentConfig } from './types';

const songs = (n: number): Song[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, artists: [`A${i}`], origin: 'demo' as const, originalIndex: i }));

function make(id: string, n: number, config: TournamentConfig, at = '2026-10-01'): Tournament {
  const list = songs(n);
  return { id, name: id, createdAt: at, updatedAt: at, config, songs: list, seed: 1, draw: makeDraw(list, config, 1).draw, drawNotes: [], decisions: [], postponed: [] };
}

/** Lowest index always wins. */
function finish(t: Tournament, day = '01'): Tournament {
  for (let k = 0; ; k++) {
    const st = computeState(t);
    if (st.finished) return t;
    const m = st.rounds.flatMap((r) => r.matches).find((x) => x.id === st.openItems[0].id)!;
    const order = m.songIds.slice().sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const d: Decision = { id: `${t.id}${k}`, targetId: m.id, songIds: m.songIds, at: `2026-10-${day}T10:${String(k).padStart(2, '0')}:00Z`, selected: order.slice(0, m.advanceCount) };
    t = { ...t, decisions: addDecision(t, d)! };
  }
}

describe('party aggregation', () => {
  const base = { songIds: ['a', 'b', 'c', 'd'], advanceCount: 2, candidateRequired: false };

  it('select: counts votes, flags ties at the boundary', () => {
    const agg = aggregateVotes({ ...base, evaluation: 'select' }, [
      { player: 'P1', selected: ['a', 'b'] },
      { player: 'P2', selected: ['a', 'c'] },
      { player: 'P3', selected: ['a', 'b'] },
    ]);
    expect(agg.value).toEqual({ a: 3, b: 2, c: 1, d: 0 });
    expect(agg.order.slice(0, 2)).toEqual(['a', 'b']);
    expect(agg.ties).toEqual([]);
    const tied = aggregateVotes({ ...base, evaluation: 'select' }, [
      { player: 'P1', selected: ['a', 'b'] },
      { player: 'P2', selected: ['a', 'c'] },
    ]);
    expect(tied.ties).toEqual([['b', 'c']]);
    expect(applyTieOrder(tied.order, [['c', 'b']]).slice(0, 2)).toEqual(['a', 'c']);
  });

  it('rank: Borda points', () => {
    const agg = aggregateVotes({ ...base, evaluation: 'rank' }, [
      { player: 'P1', order: ['a', 'b', 'c', 'd'] },
      { player: 'P2', order: ['b', 'a', 'd', 'c'] },
    ]);
    expect(agg.value).toEqual({ a: 5, b: 5, c: 1, d: 1 });
    expect(agg.ties).toEqual([]); // a/b tie is above the boundary, c/d below
  });

  it('score: averages with decimals are accepted by the engine', () => {
    const agg = aggregateVotes({ ...base, evaluation: 'score' }, [
      { player: 'P1', scores: { a: 9, b: 7, c: 5, d: 2 } },
      { player: 'P2', scores: { a: 8, b: 6, c: 7, d: 3 } },
      { player: 'P3', scores: { a: 10, b: 6, c: 6, d: 1 } },
    ]);
    expect(agg.value).toEqual({ a: 9, b: 6.33, c: 6, d: 2 });
    const cfg = normalizeConfig({ ...defaultConfig(), evaluation: 'score' });
    const t = make('x', 8, cfg);
    const m = computeState(t).rounds[0].matches[0];
    const scores = Object.fromEntries(m.songIds.map((s, i) => [s, [9, 6.33, 6, 2][i]]));
    const next = addDecision(t, { id: 'd', targetId: m.id, songIds: m.songIds, at: '', scores, order: m.songIds });
    expect(next).not.toBeNull();
  });

  it('agreement measures overlap with the group result', () => {
    expect(agreement({ player: 'x', selected: ['a', 'b'] }, ['a', 'c'], 2)).toBe(0.5);
    expect(agreement({ player: 'x', scores: { a: 9, b: 2, c: 8 } }, ['a', 'c'], 2)).toBe(1);
  });

  it('party stats per player', () => {
    const cfg = { ...defaultConfig(), partyPlayers: ['Ana', 'Ben'] };
    const t = make('p', 8, cfg);
    const m = computeState(t).rounds[0].matches[0];
    const d: Decision = {
      id: 'd', targetId: m.id, songIds: m.songIds, at: '', selected: m.songIds.slice(0, 2),
      votes: [{ player: 'Ana', selected: m.songIds.slice(0, 2) }, { player: 'Ben', selected: m.songIds.slice(1, 3) }],
    };
    const st = tournamentStats({ ...t, decisions: addDecision(t, d)! });
    expect(st.party).toEqual([
      { player: 'Ana', votes: 1, agreement: 1 },
      { player: 'Ben', votes: 1, agreement: 0.5 },
    ]);
  });
});

describe('rating', () => {
  it('winners gain, losers lose, total is conserved', () => {
    const a = finish(make('a', 8, normalizeConfig({ ...defaultConfig(), format: 'duel' })));
    const r = computeRatings([a]);
    expect(r[0].song.id).toBe('s0');
    expect(r[0].rating).toBeGreaterThan(START_RATING);
    expect(r[0].wins).toBe(3);
    const sum = r.reduce((k, x) => k + x.rating, 0);
    expect(sum).toBeCloseTo(8 * START_RATING, 6);
    expect(r.find((x) => x.song.id === 's7')!.rating).toBeLessThan(START_RATING);
  });

  it('accumulates over tournaments in time order', () => {
    const a = finish(make('a', 8, defaultConfig()), '01');
    const b = finish(make('b', 8, defaultConfig()), '02');
    const r = computeRatings([b, a]);
    const s0 = r.find((x) => x.song.id === 's0')!;
    expect(s0.tournaments).toBe(2);
    expect(s0.peak).toBeGreaterThanOrEqual(s0.rating);
    expect(computeRatings([])).toEqual([]);
  });
});

describe('result order and Spotify export', () => {
  it('champion first, then finalists, then by stage – every song exactly once', () => {
    const st = computeState(finish(make('a', 16, normalizeConfig({ ...defaultConfig(), format: 'duel' }))));
    const order = resultOrder(st);
    expect(order.length).toBe(16);
    expect(new Set(order.map((o) => o.songId)).size).toBe(16);
    expect(order[0]).toEqual({ songId: 's0', stage: 'Sieger' });
    expect(order[1].stage).toBe('Finale');
  });

  it('exports links and a CSV, skipping songs without Spotify ID', () => {
    const list: Song[] = [
      { id: 'sp:1', title: 'A, "B"', artists: ['X'], origin: 'csv', spotifyTrackId: '4uLU6hMCjMI75M1A2tKUQC', originalIndex: 0 },
      { id: 'h:2', title: 'Local', artists: ['Y'], origin: 'csv', originalIndex: 1 },
    ];
    const e = spotifyExport(list);
    expect(e.links).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    expect(e.count).toBe(1);
    expect(e.skipped.map((s) => s.id)).toEqual(['h:2']);
    expect(e.csv.split('\n')[1]).toBe('"A, ""B""",X,,4uLU6hMCjMI75M1A2tKUQC,spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  });
});
