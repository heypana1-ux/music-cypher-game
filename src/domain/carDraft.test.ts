import { describe, expect, it } from 'vitest';
import { emptyDraft, proposal, proposalDecision, type DraftTarget } from './carDraft';
import { defaultConfig, normalizeConfig } from './config';
import { addDecision, computeState, makeDraw } from './engine';
import type { CarDraft, Song, Tournament, TournamentConfig } from './types';

const ids = ['a', 'b', 'c', 'd'];
const target = (evaluation: DraftTarget['evaluation'], extra: Partial<DraftTarget> = {}): DraftTarget => ({
  id: 'r0-m0',
  songIds: ids,
  advanceCount: 2,
  evaluation,
  candidateRequired: false,
  ...extra,
});
const draft = (ratings: CarDraft['ratings'], stars: string[] = []): CarDraft => ({ ...emptyDraft(), ratings, stars });

describe('car proposals', () => {
  it('buttons: best ratings advance, slot order breaks nothing silently', () => {
    const p = proposal(target('select'), draft({ a: 2, b: 4, c: 3, d: 1 }), 'buttons');
    expect(p.order).toEqual(['b', 'c', 'a', 'd']);
    expect(p.selected).toEqual(['b', 'c']);
    expect(p.complete).toBe(true);
  });

  it('a tie at the qualification boundary blocks the one-tap confirm', () => {
    const p = proposal(target('select'), draft({ a: 4, b: 3, c: 3, d: 1 }), 'buttons');
    expect(p.complete).toBe(false);
    expect(p.ties).toEqual([['b', 'c']]);
    expect(p.reason).toContain('Gleichstand');
  });

  it('ties below the boundary are fine in select mode, not in rank mode', () => {
    const d = draft({ a: 4, b: 3, c: 1, d: 1 });
    expect(proposal(target('select'), d, 'buttons').complete).toBe(true);
    expect(proposal(target('rank'), d, 'buttons').complete).toBe(false);
  });

  it('score mode needs every song rated', () => {
    const p = proposal(target('score'), draft({ a: 4, b: 3, c: 2 }), 'buttons');
    expect(p.complete).toBe(false);
    expect(p.unrated).toEqual(['d']);
  });

  it('stars: exactly the number of advancing songs', () => {
    expect(proposal(target('select'), draft({}, ['a']), 'stars').complete).toBe(false);
    const p = proposal(target('select'), draft({}, ['d', 'b']), 'stars');
    expect(p.complete).toBe(true);
    expect(p.selected.sort()).toEqual(['b', 'd']);
  });

  it('playoffs are a plain selection', () => {
    const t = target('score', { id: 'r0-p0', songIds: ['a', 'b'], advanceCount: 1, isPlayoff: true });
    const p = proposal(t, draft({ a: 2, b: 4 }), 'buttons');
    expect(proposalDecision(t, p, draft({ a: 2, b: 4 }), 'buttons')).toEqual({ targetId: 'r0-p0', songIds: ['a', 'b'], selected: ['b'] });
  });
});

describe('car proposals become valid engine decisions', () => {
  const songs: Song[] = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, artists: [`A${i}`], origin: 'demo' as const, originalIndex: i }));
  const make = (config: TournamentConfig): Tournament => ({
    id: 't', name: 't', createdAt: '', updatedAt: '', config, songs, seed: 1, draw: makeDraw(songs, config, 1).draw, drawNotes: [], decisions: [], postponed: [],
  });

  for (const evaluation of ['select', 'rank', 'score'] as const) {
    it(`${evaluation}: one-tap confirm is accepted by the engine`, () => {
      const t = make(normalizeConfig({ ...defaultConfig(), evaluation }));
      const m = computeState(t).rounds[0].matches[0];
      const tg: DraftTarget = { id: m.id, songIds: m.songIds, advanceCount: m.advanceCount, evaluation: m.evaluation, candidateRequired: m.candidateRequired };
      const d = draft({ [m.songIds[0]]: 1, [m.songIds[1]]: 4, [m.songIds[2]]: 2, [m.songIds[3]]: 3 });
      const p = proposal(tg, d, 'buttons');
      expect(p.complete).toBe(true);
      const next = addDecision(t, { ...proposalDecision(tg, p, d, 'buttons'), id: 'x', at: '' });
      expect(next).not.toBeNull();
      const st = computeState({ ...t, decisions: next! });
      expect(st.rounds[0].matches[0].outcome!.qualified.sort()).toEqual([m.songIds[1], m.songIds[3]].sort());
    });
  }
});
