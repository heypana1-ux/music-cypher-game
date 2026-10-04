import { describe, expect, it } from 'vitest';
import { defaultConfig, normalizeConfig } from './config';
import { addDecision, computeState, findMatch, makeDraw } from './engine';
import { computeRatings, headToHeadFor, pairKey, ratingInsights, ratingsAt, tournamentSurprises } from './rating';
import { seasonPoints, seasonTable } from './season';
import { songRuns } from './stats';
import type { Decision, Song, Tournament } from './types';

const duel = normalizeConfig({ ...defaultConfig(), format: 'duel', drawMode: 'original' });
const list = (n: number): Song[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, artists: [`A${i % 4}`], origin: 'demo' as const, originalIndex: i }));

function make(id: string, n: number, day: number, extra: Partial<Tournament> = {}): Tournament {
  const songs = list(n);
  const at = `2026-10-${String(day).padStart(2, '0')}T09:00:00Z`;
  return { id, name: id, createdAt: at, updatedAt: at, config: duel, songs, seed: 1, draw: makeDraw(songs, duel, 1).draw, drawNotes: [], decisions: [], postponed: [], ...extra };
}

/** `winner(a, b)` decides each duel. */
function finish(t: Tournament, day: number, winner: (ids: string[]) => string): Tournament {
  for (let k = 0; k < 200; k++) {
    const st = computeState(t);
    if (st.finished) return t;
    const m = findMatch(st, st.openItems[0].id)!;
    const d: Decision = { id: `${t.id}-${k}`, targetId: m.id, songIds: m.songIds, at: `2026-10-${String(day).padStart(2, '0')}T10:${String(k).padStart(2, '0')}:00Z`, selected: [winner(m.songIds)] };
    t = { ...t, decisions: addDecision(t, d)! };
  }
  throw new Error('not finished');
}
const low = (ids: string[]) => ids.slice().sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))[0];
const high = (ids: string[]) => ids.slice().sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];

describe('head-to-head and upsets', () => {
  const t1 = finish(make('t1', 8, 1), 1, low); // s0 strongest
  const t2 = finish(make('t2', 8, 2), 2, high); // everything reversed → upsets

  it('records every meeting between two songs', () => {
    const { h2h } = ratingInsights([t1, t2]);
    const h = h2h.get(pairKey('s0', 's1'))!;
    expect(h.meetings.length).toBe(2);
    expect(h.winsA + h.winsB + h.draws).toBe(2);
    expect(headToHeadFor(h2h, ['s0', 's1', 's7']).length).toBeGreaterThanOrEqual(1);
  });

  it('flags upsets only when the loser was rated higher at that moment', () => {
    const { upsets } = ratingInsights([t1, t2]);
    expect(upsets.length).toBeGreaterThan(0);
    expect(upsets.every((u) => u.loserRating > u.winnerRating && u.gap > 0)).toBe(true);
    expect(upsets.every((u) => u.tournamentId === 't2')).toBe(true);
    for (let i = 1; i < upsets.length; i++) expect(upsets[i - 1].gap).toBeGreaterThanOrEqual(upsets[i].gap);
    expect(ratingInsights([t1]).upsets.length).toBe(0);
  });

  it('ratingsAt reflects only decisions before the given moment', () => {
    const before = ratingsAt([t1, t2], '2026-10-02T00:00:00Z');
    const t1Only = new Map(computeRatings([t1]).map((r) => [r.song.id, r.rating]));
    for (const [id, r] of before) expect(r.rating).toBeCloseTo(t1Only.get(id)!, 6);
  });

  it('underdogs and flops compare results with the rating before the tournament', () => {
    // t1: s0 > s2/s4 > s6 among songs with 2+ comparisons. t3: s6 wins everything, s0 loses at once.
    const pick = (ids: string[]) => (ids.includes('s6') ? 's6' : ids.includes('s0') ? ids.find((x) => x !== 's0')! : low(ids));
    const t3 = finish(make('t3', 8, 3), 3, pick);
    const { underdogs, flops } = tournamentSurprises([t1, t3], (t) => songRuns(t));
    expect(underdogs[0].tournament.id).toBe('t3');
    expect(underdogs[0].song.id).toBe('s6');
    expect(underdogs[0].preRank).toBe(underdogs[0].rated); // lowest rated before, won it
    expect(flops[0].song.id).toBe('s0'); // favourite went out in round 1
    expect(flops[0].preRank).toBe(1);
  });
});

describe('season', () => {
  it('points: 1 + 2 per survived round + final + win', () => {
    const t = finish(make('t', 16, 1), 1, low);
    const runs = songRuns(t);
    const rounds = computeState(t).rounds.length;
    const champ = runs.find((r) => r.champion)!;
    expect(seasonPoints(champ, rounds)).toBe(1 + 2 * 4 + 3 + 5);
    const finalist = runs.find((r) => r.finalist && !r.champion)!;
    expect(seasonPoints(finalist, rounds)).toBe(1 + 2 * 3 + 3);
    const outFirst = runs.find((r) => r.lastRound === 0)!;
    expect(seasonPoints(outFirst, rounds)).toBe(1);
  });

  it('table sums finished tournaments of the season only', () => {
    const a = finish(make('a', 8, 1, { seasonId: 'se1' }), 1, low);
    const b = finish(make('b', 8, 2, { seasonId: 'se1' }), 2, low);
    const c = make('c', 8, 3, { seasonId: 'se1' }); // running
    const d = finish(make('d', 8, 4), 4, high); // other season
    const tab = seasonTable('se1', [a, b, c, d]);
    expect(tab.finished.map((t) => t.id)).toEqual(['a', 'b']);
    expect(tab.running.map((t) => t.id)).toEqual(['c']);
    expect(tab.songs[0].entry.id).toBe('s0');
    expect(tab.songs[0].titles).toBe(2);
    expect(tab.songs[0].points).toBe(2 * (1 + 2 * 3 + 3 + 5));
    expect(tab.songs[0].form).toEqual([15, 15]);
    expect(tab.artists[0].points).toBeGreaterThan(0);
    expect(seasonTable('none', [a]).songs).toEqual([]);
  });
});
