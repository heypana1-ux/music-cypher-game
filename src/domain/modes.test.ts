import { describe, expect, it } from 'vitest';
import { defaultConfig, normalizeConfig, PRESETS } from './config';
import { addDecision, computeState, findMatch, findPlayoff, makeDraw, previewRounds } from './engine';
import { buildArtistParticipants, participants, planArtists, roundEntries, songInRound } from './participants';
import { computeRatings } from './rating';
import { tournamentStats } from './stats';
import type { Decision, Song, Tournament, TournamentConfig } from './types';

const songs = (n: number, artist = (i: number) => `A${i}`): Song[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, artists: [artist(i)], origin: 'demo' as const, originalIndex: i }));

function make(config: TournamentConfig, list: Song[], extra: Partial<Tournament> = {}): Tournament {
  const base: Tournament = { id: 't', name: 't', createdAt: '', updatedAt: '', config, songs: list, seed: 3, draw: [], drawNotes: [], decisions: [], postponed: [], ...extra };
  return { ...base, draw: makeDraw(participants(base), config, 3).draw };
}

/** Lowest index (number in the id) always wins. */
function finish(t: Tournament): Tournament {
  const num = (id: string) => Number(id.replace(/\D+/g, '')) || 0;
  for (let k = 0; k < 500; k++) {
    const st = computeState(t);
    if (st.finished) return t;
    const item = st.openItems[0];
    const m = findMatch(st, item.id);
    let d: Decision;
    if (m) {
      const order = m.songIds.slice().sort((a, b) => num(a) - num(b));
      d = { id: `d${k}`, targetId: m.id, songIds: m.songIds, at: `2026-10-04T10:${String(k % 60).padStart(2, '0')}:00Z` };
      if (m.evaluation === 'select') d.selected = order.slice(0, m.advanceCount);
      else d.order = order;
      if (m.evaluation === 'score') {
        d.scores = Object.fromEntries(order.map((s, i) => [s, 10 - i]));
      }
    } else {
      const p = findPlayoff(st, item.id)!;
      d = { id: `d${k}`, targetId: p.id, songIds: p.contested, at: '2026-10-04T11:00:00Z', selected: p.contested.slice(0, p.contestedSpots) };
    }
    t = { ...t, decisions: addDecision(t, d)! };
  }
  throw new Error('did not finish');
}

describe('mix regrouping', () => {
  it('songs from the same group are split up in the next round', () => {
    const cfg: TournamentConfig = { ...defaultConfig(), regroup: 'mix', drawMode: 'original' };
    const t = finish(make(cfg, songs(32)));
    const st = computeState(t);
    const r0 = st.rounds[0];
    const r1 = st.rounds[1];
    const prev = new Map(r0.matches.flatMap((m) => m.songIds.map((id) => [id, m.id] as [string, string])));
    for (const m of r1.matches) {
      const groups = m.songIds.map((id) => prev.get(id));
      expect(new Set(groups).size).toBe(groups.length);
    }
    // bracket mode would put s0,s1 (group A winners) together again
    const bracket = computeState(finish(make({ ...cfg, regroup: 'bracket' }, songs(32))));
    expect(bracket.rounds[1].matches[0].songIds.slice(0, 2)).toEqual(['s0', 's1']);
  });

  it('mix works with extra spots, odd counts and stays reproducible', () => {
    const cfg: TournamentConfig = { ...PRESETS.find((p) => p.id === 'cypher-blocks')!.config, regroup: 'mix' };
    for (const n of [8, 13, 24, 40]) {
      const t = finish(make(cfg, songs(n)));
      const st = computeState(t);
      expect(st.finished).toBe(true);
      const again = computeState(JSON.parse(JSON.stringify(t)));
      expect(again.rounds.map((r) => r.entrants)).toEqual(st.rounds.map((r) => r.entrants));
      for (let i = 0; i + 1 < st.rounds.length; i++) expect(st.rounds[i + 1].entrants.length).toBeLessThan(st.rounds[i].entrants.length);
    }
  });

  it('preview counts do not depend on the regroup mode', () => {
    const a = previewRounds({ ...defaultConfig(), regroup: 'mix' }, 50).map((r) => r.songs);
    const b = previewRounds(defaultConfig(), 50).map((r) => r.songs);
    expect(a).toEqual(b);
  });
});

describe('artist cypher', () => {
  // 16 artists: X0..X15, artist i has (i % 3) + 3 songs → 3–5 songs each
  const lib: Song[] = [];
  for (let a = 0; a < 16; a++) for (let k = 0; k < (a % 3) + 3; k++) lib.push({ id: `a${a}-${k}`, title: `X${a} Song ${k}`, artists: [`X${a}`], origin: 'csv', originalIndex: lib.length });
  // two artists with too few songs
  lib.push({ id: 'y1', title: 'Y Song', artists: ['Y'], origin: 'csv', originalIndex: lib.length });
  lib.push({ id: 'z1', title: 'Z Song 1', artists: ['Z'], origin: 'csv', originalIndex: lib.length });
  lib.push({ id: 'z2', title: 'Z Song 2', artists: ['Z'], origin: 'csv', originalIndex: lib.length });

  it('plans: everyone needs one song per round', () => {
    const duel = normalizeConfig({ ...defaultConfig(), format: 'duel' });
    const plan = planArtists(lib, duel);
    // 16 artists would need 4 duel rounds, but only 10 artists have 4+ songs → 10 artists, 4 rounds
    expect(plan.rounds).toBe(4);
    expect(plan.eligible.length).toBe(10);
    expect(plan.eligible.every((a) => a.songs.length >= 4)).toBe(true);
    expect(plan.tooFew.length).toBe(8);
    const cyph = planArtists(lib, defaultConfig()); // 16 → 8 → 4(final) = 3 rounds
    expect(cyph.rounds).toBe(3);
    const limited = planArtists(lib, duel, 8);
    expect(limited.eligible.length).toBe(8);
    expect(limited.rounds).toBe(3);
  });

  it('a new song every round, decisions use artist IDs, champion is an artist', () => {
    const duel = normalizeConfig({ ...defaultConfig(), format: 'duel' });
    const plan = planArtists(lib, duel);
    const parts = buildArtistParticipants(plan.eligible, plan.rounds, 'original', 1);
    expect(parts.every((p) => p.songIds.length === 4 && new Set(p.songIds).size === 4)).toBe(true);
    const t = finish(make(duel, lib, { artistMode: { participants: parts } }));
    const st = computeState(t);
    expect(st.champion?.startsWith('ar:')).toBe(true);
    // the champion played four different songs
    const played = st.rounds.map((r) => songInRound(t, st.champion!, r.index)!.id);
    expect(new Set(played).size).toBe(4);
    // round entries carry the real song but the artist id
    const e = roundEntries(t, 2).get(st.champion!)!;
    expect(e.id).toBe(st.champion);
    expect(e.audioKey).toBe(played[2]);
    // stats talk about artists, rating rates the real songs
    const stats = tournamentStats(t);
    expect(stats.runs.find((r) => r.champion)?.songId).toBe(st.champion);
    const ratings = computeRatings([t]);
    expect(ratings.every((r) => !r.song.id.startsWith('ar:'))).toBe(true);
    // 10 artists, bracket of 16: every song that was actually played is rated exactly once
    expect(ratings.length).toBe(18); // 2 duels (6 byes) + 4 + 2 + 1 → 4 + 8 + 4 + 2 songs played
  });

  it('random song order is seeded', () => {
    const plan = planArtists(lib, defaultConfig());
    const a = buildArtistParticipants(plan.eligible, plan.rounds, 'random', 7);
    const b = buildArtistParticipants(plan.eligible, plan.rounds, 'random', 7);
    expect(a).toEqual(b);
  });
});
