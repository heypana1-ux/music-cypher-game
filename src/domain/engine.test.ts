import { describe, expect, it } from 'vitest';
import { checkConfig, defaultConfig, normalizeConfig, PRESETS } from './config';
import {
  addDecision,
  computeState,
  duelFirstRoundGroups,
  findMatch,
  findPlayoff,
  makeDraw,
  previewRounds,
  reopen,
  undoLast,
} from './engine';
import { mulberry32, shuffle } from './rng';
import { eliminationGroups, songPath } from './results';
import type { Decision, Song, Tournament, TournamentConfig, TournamentState } from './types';

function songs(n: number, artistOf: (i: number) => string = (i) => `Artist ${i}`): Song[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    title: `Song ${i}`,
    artists: [artistOf(i)],
    origin: 'demo' as const,
    originalIndex: i,
  }));
}

function makeTournament(n: number, config: TournamentConfig, seed = 42, list = songs(n)): Tournament {
  const { draw, notes } = makeDraw(list, config, seed);
  return {
    id: 't',
    name: 'Test',
    createdAt: '',
    updatedAt: '',
    config,
    songs: list,
    seed,
    draw,
    drawNotes: notes,
    decisions: [],
    postponed: [],
  };
}

let did = 0;
/** Build a valid decision for an open item with pseudo-random choices. */
function autoDecision(_t: Tournament, state: TournamentState, id: string, rand: () => number, scoreFn?: (s: string) => number): Decision {
  const m = findMatch(state, id);
  if (m) {
    const order = shuffle(m.songIds, rand);
    const d: Decision = { id: `d${did++}`, targetId: id, songIds: m.songIds, at: '' };
    if (m.evaluation === 'select') d.selected = order.slice(0, m.advanceCount);
    else if (m.evaluation === 'rank') d.order = order;
    else {
      const scores = Object.fromEntries(m.songIds.map((s) => [s, scoreFn ? scoreFn(s) : 1 + Math.floor(rand() * 10)]));
      const sorted = m.songIds.slice().sort((a, b) => scores[b] - scores[a]);
      d.scores = scores;
      d.order = sorted;
      // resolve every tie explicitly
      const ties: string[][] = [];
      for (const v of new Set(Object.values(scores))) {
        const c = sorted.filter((s) => scores[s] === v);
        if (c.length > 1) ties.push(c);
      }
      d.resolvedTies = ties;
    }
    return d;
  }
  const p = findPlayoff(state, id)!;
  return {
    id: `d${did++}`,
    targetId: id,
    songIds: p.contested,
    at: '',
    selected: shuffle(p.contested, rand).slice(0, p.contestedSpots),
  };
}

function playThrough(t: Tournament, seed = 7, scoreFn?: (s: string) => number) {
  const rand = mulberry32(seed);
  let guard = 0;
  let state = computeState(t);
  while (!state.finished && guard++ < 2000) {
    expect(state.openItems.length).toBeGreaterThan(0);
    const item = state.openItems[0];
    const d = autoDecision(t, state, item.id, rand, scoreFn);
    const next = addDecision(t, d);
    expect(next).not.toBeNull();
    t = { ...t, decisions: next! };
    state = computeState(t);
  }
  return { t, state };
}

/** Invariants: no song lost or duplicated, each round reduces the field, exactly one champion. */
function checkInvariants(t: Tournament, state: TournamentState) {
  expect(state.finished).toBe(true);
  expect(state.champion).not.toBeNull();
  for (let i = 0; i < state.rounds.length; i++) {
    const r = state.rounds[i];
    expect(new Set(r.entrants).size).toBe(r.entrants.length);
    // every entrant appears in exactly one (non third place) match
    const inMatches = r.matches.filter((m) => m.kind !== 'thirdPlace').flatMap((m) => m.songIds);
    expect(inMatches.slice().sort()).toEqual(r.entrants.slice().sort());
    for (const m of r.matches) {
      const o = m.outcome!;
      expect([...o.qualified, ...o.eliminated].sort()).toEqual(m.songIds.slice().sort());
      if (o.candidate) {
        expect(o.qualified).not.toContain(o.candidate);
      }
    }
    for (const p of r.playoffs) {
      for (const w of p.winners) {
        // never directly qualified and extra at the same time
        expect(r.matches.some((m) => m.outcome!.qualified.includes(w))).toBe(false);
      }
    }
    if (i + 1 < state.rounds.length) {
      const next = state.rounds[i + 1].entrants;
      expect(next.length).toBeLessThan(r.entrants.length);
      const allowed = new Set([
        ...r.matches.flatMap((m) => m.outcome!.qualified),
        ...r.playoffs.flatMap((p) => p.winners),
      ]);
      expect(next.every((s) => allowed.has(s))).toBe(true);
      expect(next.length).toBe(allowed.size);
    }
  }
  expect(t.songs.map((s) => s.id)).toContain(state.champion);
}

const duel = normalizeConfig({ ...defaultConfig(), format: 'duel' });

describe('Duel mode', () => {
  for (const n of [2, 3, 16, 32, 64, 100, 128, 130, 150, 256]) {
    it(`${n} songs → one champion with exactly N−1 decided duels`, () => {
      const { t, state } = playThrough(makeTournament(n, duel));
      checkInvariants(t, state);
      const decided = state.rounds.flatMap((r) => r.matches).filter((m) => m.status === 'done');
      expect(decided.length).toBe(n - 1);
      expect(decided.every((m) => m.songIds.length === 2)).toBe(true);
    });
  }

  it('100 songs: bracket of 128 with 28 byes, never two byes in one match', () => {
    const groups = duelFirstRoundGroups(Array.from({ length: 100 }, (_, i) => `x${i}`));
    expect(groups.length).toBe(64);
    expect(groups.filter((g) => g.kind === 'bye').length).toBe(28);
    expect(groups.every((g) => g.songIds.length >= 1 && g.songIds.every(Boolean))).toBe(true);
    const state = computeState(makeTournament(100, duel));
    expect(state.rounds[0].label).toBe('64stel-Finale');
    expect(state.rounds[0].byes).toBe(28);
  });

  it('128 songs: 64stel-Finale without byes', () => {
    const state = computeState(makeTournament(128, duel));
    expect(state.rounds[0].label).toBe('64stel-Finale');
    expect(state.rounds[0].byes).toBe(0);
    expect(state.rounds[0].matches.length).toBe(64);
  });

  it('150 songs with fixed main round 128: 106 direct, 22 prelim duels, then exactly 128', () => {
    const cfg = { ...duel, duelMainRound: 128 };
    const t = makeTournament(150, cfg);
    let state = computeState(t);
    const r0 = state.rounds[0];
    expect(r0.label).toBe('Vorrunde');
    expect(r0.isPrelim).toBe(true);
    expect(r0.byes).toBe(106);
    expect(r0.matches.filter((m) => m.kind === 'duel').length).toBe(22);
    const { state: done } = playThrough(t);
    state = done;
    expect(state.rounds[1].entrants.length).toBe(128);
    expect(state.rounds[1].label).toBe('64stel-Finale (Hauptrunde)');
  });

  it('300 songs with main round 128 needs two visible prelim rounds', () => {
    const cfg = { ...duel, duelMainRound: 128 };
    const prev = previewRounds(cfg, 300);
    expect(prev.map((r) => r.songs)).toEqual([300, 256, 128, 64, 32, 16, 8, 4, 2]);
    expect(prev[0].label).toBe('Vorrunde 1');
    expect(prev[1].label).toBe('Vorrunde 2');
    expect(prev[2].label).toContain('Hauptrunde');
  });

  it('fewer songs than the main round: byes shown; too few songs rejected', () => {
    expect(checkConfig({ ...duel, duelMainRound: 128 }, 100).errors).toEqual([]);
    expect(checkConfig({ ...duel, duelMainRound: 128 }, 60).errors.length).toBe(1);
  });

  it('third place match is played between the semifinal losers', () => {
    const cfg = { ...duel, thirdPlaceMatch: true };
    const { t, state } = playThrough(makeTournament(8, cfg));
    checkInvariants(t, state);
    expect(state.thirdPlace).not.toBeNull();
    expect([state.champion, state.runnerUp]).not.toContain(state.thirdPlace);
  });
});

const cypher = defaultConfig();

describe('Cypher mode', () => {
  for (const n of [4, 5, 6, 8, 12, 16, 32, 128, 150]) {
    for (const adv of [1, 2, 3] as const) {
      for (const evaluation of ['select', 'rank', 'score'] as const) {
        it(`${n} songs, ${adv} advance, ${evaluation}`, () => {
          const cfg = normalizeConfig({ ...cypher, advancePerGroup: adv, evaluation });
          const { t, state } = playThrough(makeTournament(n, cfg));
          checkInvariants(t, state);
          const fin = state.rounds[state.rounds.length - 1];
          expect(fin.isFinal).toBe(true);
          expect(fin.matches[0].outcome!.qualified.length).toBe(1);
        });
      }
    }
  }

  it('special groups and byes: 6 songs → cypher of 4 + special group of 2', () => {
    const state = computeState(makeTournament(6, cypher));
    const kinds = state.rounds[0].matches.map((m) => m.kind);
    expect(kinds).toEqual(['cypher', 'special']);
    expect(state.rounds[0].matches[1].advanceCount).toBe(1);
  });

  it('5 songs → one cypher and one visible bye', () => {
    const state = computeState(makeTournament(5, cypher));
    expect(state.rounds[0].matches.map((m) => m.kind)).toEqual(['cypher', 'bye']);
    expect(state.rounds[0].sublabel).toContain('Freilos');
  });

  it('round label uses cypher wording', () => {
    const state = computeState(makeTournament(128, cypher));
    expect(state.rounds[0].sublabel).toBe('128 Songs – 32 Cyphers');
  });

  it('special group of 3 with advance 3 is capped at 2', () => {
    const state = computeState(makeTournament(7, { ...cypher, advancePerGroup: 3 }));
    const sp = state.rounds[0].matches.find((m) => m.kind === 'special')!;
    expect(sp.songIds.length).toBe(3);
    expect(sp.advanceCount).toBe(2);
  });
});

const blocks = PRESETS.find((p) => p.id === 'cypher-blocks')!.config;

describe('Two cyphers with extra spot', () => {
  it('8 songs: 5 advance, the better third place gets the extra spot by score', () => {
    const t = makeTournament(8, { ...blocks, drawMode: 'original' });
    let state = computeState(t);
    const [a, b] = state.rounds[0].matches;
    expect(a.songIds).toEqual(['s0', 's1', 's2', 's3']);
    const scoresA = { s0: 9, s1: 8, s2: 7, s3: 4 };
    const scoresB = { s4: 10, s5: 8, s6: 6, s7: 5 };
    let decisions = addDecision(t, {
      id: 'a', targetId: a.id, songIds: a.songIds, at: '', scores: scoresA, order: ['s0', 's1', 's2', 's3'],
    })!;
    // playoff still waiting while B is open
    state = computeState({ ...t, decisions });
    expect(state.rounds[0].playoffs[0].status).toBe('waiting');
    decisions = addDecision({ ...t, decisions }, {
      id: 'b', targetId: b.id, songIds: b.songIds, at: '', scores: scoresB, order: ['s4', 's5', 's6', 's7'],
    })!;
    state = computeState({ ...t, decisions });
    const p = state.rounds[0].playoffs[0];
    expect(p.status).toBe('auto');
    expect(p.winners).toEqual(['s2']);
    expect(state.rounds[1].entrants.sort()).toEqual(['s0', 's1', 's2', 's4', 's5']);
    // 5 songs → cypher of 4 + bye
    expect(state.rounds[1].matches.map((m) => m.kind)).toEqual(['cypher', 'bye']);
  });

  it('tied third places require a user decision; undo removes the extra spot', () => {
    const t0 = makeTournament(8, { ...blocks, drawMode: 'original' });
    let t = t0;
    t = { ...t, decisions: addDecision(t, { id: 'a', targetId: 'r0-m0', songIds: ['s0', 's1', 's2', 's3'], at: '', scores: { s0: 9, s1: 8, s2: 6, s3: 4 }, order: ['s0', 's1', 's2', 's3'] })! };
    t = { ...t, decisions: addDecision(t, { id: 'b', targetId: 'r0-m1', songIds: ['s4', 's5', 's6', 's7'], at: '', scores: { s4: 10, s5: 8, s6: 6, s7: 5 }, order: ['s4', 's5', 's6', 's7'] })! };
    let state = computeState(t);
    const p = state.rounds[0].playoffs[0];
    expect(p.status).toBe('open');
    expect(p.contested.sort()).toEqual(['s2', 's6']);
    expect(state.openItems).toEqual([{ type: 'playoff', id: 'r0-p0' }]);
    // wrong count rejected
    expect(addDecision(t, { id: 'x', targetId: 'r0-p0', songIds: p.contested, at: '', selected: ['s2', 's6'] })).toBeNull();
    t = { ...t, decisions: addDecision(t, { id: 'p', targetId: 'r0-p0', songIds: p.contested, at: '', selected: ['s6'] })! };
    state = computeState(t);
    expect(state.rounds[0].playoffs[0].winners).toEqual(['s6']);
    expect(state.rounds[1].entrants).toContain('s6');
    expect(state.rounds[1].entrants).not.toContain('s2');
    // undo the extra spot decision
    t = { ...t, decisions: undoLast(t) };
    state = computeState(t);
    expect(state.rounds.length).toBe(1);
    expect(state.rounds[0].playoffs[0].status).toBe('open');
  });

  it('rank mode: the extra spot is always decided by the user', () => {
    const cfg = { ...blocks, evaluation: 'rank' as const };
    const t = makeTournament(8, cfg);
    let tt = t;
    for (const m of computeState(t).rounds[0].matches) {
      tt = { ...tt, decisions: addDecision(tt, { id: m.id, targetId: m.id, songIds: m.songIds, at: '', order: m.songIds })! };
    }
    const state = computeState(tt);
    expect(state.rounds[0].playoffs[0].status).toBe('open');
    expect(state.rounds[0].playoffs[0].contestedSpots).toBe(1);
  });

  it('incomplete block: 12 songs → 3 cyphers, only the first two form a block', () => {
    const state = computeState(makeTournament(12, blocks));
    expect(state.rounds[0].playoffs.length).toBe(1);
    expect(state.rounds[0].matches[2].candidateRequired).toBe(false);
    expect(state.rounds[0].notes.join(' ')).toContain('keinen vollständigen Block');
    const prev = previewRounds(blocks, 12);
    expect(prev[1].songs).toBe(2 + 2 + 2 + 1);
  });

  it('per-round extra spots wait for all groups and never stall the field', () => {
    const cfg = normalizeConfig({ ...cypher, evaluation: 'score', advancePerGroup: 3, extraMode: 'perRound', extraPerRound: 99 });
    const { t, state } = playThrough(makeTournament(32, cfg));
    checkInvariants(t, state);
    expect(state.rounds[0].playoffs[0].spots).toBe(7);
  });

  for (const n of [8, 16, 24, 32, 128, 150]) {
    it(`extra spot tournaments complete for ${n} songs (score, with forced ties)`, () => {
      const { t, state } = playThrough(makeTournament(n, blocks), 3, () => 5);
      checkInvariants(t, state);
    });
  }
});

describe('Scores and ties', () => {
  const cfg = normalizeConfig({ ...cypher, evaluation: 'score' });

  it('missing scores are rejected', () => {
    const t = makeTournament(8, cfg);
    const m = computeState(t).rounds[0].matches[0];
    const scores = { [m.songIds[0]]: 5, [m.songIds[1]]: 4, [m.songIds[2]]: 3 };
    expect(addDecision(t, { id: 'x', targetId: m.id, songIds: m.songIds, at: '', scores, order: m.songIds })).toBeNull();
  });

  it('tie at the qualification boundary must be resolved explicitly', () => {
    const t = makeTournament(8, cfg);
    const m = computeState(t).rounds[0].matches[0];
    const [a, b, c, d] = m.songIds;
    const scores = { [a]: 9, [b]: 7, [c]: 7, [d]: 3 };
    const base = { id: 'x', targetId: m.id, songIds: m.songIds, at: '', scores, order: [a, b, c, d] };
    expect(addDecision(t, base)).toBeNull();
    expect(addDecision(t, { ...base, resolvedTies: [[c, b]] })).not.toBeNull();
  });

  it('ties that do not matter stay shared and are not silently ranked', () => {
    const t = makeTournament(8, cfg);
    const m = computeState(t).rounds[0].matches[0];
    const [a, b, c, d] = m.songIds;
    const scores = { [a]: 9, [b]: 8, [c]: 3, [d]: 3 };
    const next = addDecision(t, { id: 'x', targetId: m.id, songIds: m.songIds, at: '', scores, order: [a, b, c, d] })!;
    const state = computeState({ ...t, decisions: next });
    expect(state.rounds[0].matches[0].outcome!.sharedTies).toEqual([[c, d]]);
  });

  it('order inconsistent with scores is rejected', () => {
    const t = makeTournament(8, cfg);
    const m = computeState(t).rounds[0].matches[0];
    const [a, b, c, d] = m.songIds;
    const scores = { [a]: 2, [b]: 8, [c]: 5, [d]: 3 };
    expect(addDecision(t, { id: 'x', targetId: m.id, songIds: m.songIds, at: '', scores, order: [a, b, c, d] })).toBeNull();
  });
});

describe('Persistence-relevant behaviour', () => {
  it('reload (replay from stored decisions) reproduces the same state', () => {
    const { t, state } = playThrough(makeTournament(32, blocks));
    const reloaded: Tournament = JSON.parse(JSON.stringify(t));
    const again = computeState(reloaded);
    expect(again.champion).toBe(state.champion);
    expect(again.rounds.map((r) => r.entrants)).toEqual(state.rounds.map((r) => r.entrants));
  });

  it('the same seed gives the same draw; reshuffle per round is reproducible', () => {
    const cfg = { ...cypher, reshufflePerRound: true };
    expect(makeDraw(songs(40), cfg, 5).draw).toEqual(makeDraw(songs(40), cfg, 5).draw);
    expect(makeDraw(songs(40), cfg, 5).draw).not.toEqual(makeDraw(songs(40), cfg, 6).draw);
    const a = playThrough(makeTournament(40, cfg, 9), 1);
    const b = computeState(JSON.parse(JSON.stringify(a.t)));
    expect(b.rounds.map((r) => r.entrants)).toEqual(a.state.rounds.map((r) => r.entrants));
  });

  it('double confirm does not create double qualification', () => {
    const t = makeTournament(8, cypher);
    const m = computeState(t).rounds[0].matches[0];
    const d: Decision = { id: 'x', targetId: m.id, songIds: m.songIds, at: '', selected: m.songIds.slice(0, 2) };
    const once = addDecision(t, d)!;
    expect(addDecision({ ...t, decisions: once }, { ...d, id: 'y' })).toBeNull();
    // even if a duplicate sneaks into storage, the replay ignores it
    const state = computeState({ ...t, decisions: [...once, { ...d, id: 'z', selected: m.songIds.slice(2) }] });
    expect(state.rounds[0].matches[0].outcome!.qualified).toEqual(m.songIds.slice(0, 2));
    expect(state.droppedDecisions.length).toBe(1);
  });

  it('undo after a qualification reopens the match; later rounds disappear', () => {
    const { t } = playThrough(makeTournament(16, duel));
    let tt = t;
    const before = computeState(tt);
    expect(before.finished).toBe(true);
    tt = { ...tt, decisions: undoLast(tt) };
    const after = computeState(tt);
    expect(after.finished).toBe(false);
    expect(after.openItems.length).toBe(1);
  });

  it('reopening an early match invalidates dependent rounds and extra spots', () => {
    const { t } = playThrough(makeTournament(16, blocks), 11, () => 5);
    const decisions = reopen(t, 'r0-m0');
    const state = computeState({ ...t, decisions });
    expect(state.rounds.length).toBe(1);
    expect(state.rounds[0].matches[0].status).toBe('open');
    expect(state.rounds[0].playoffs[0].status).toBe('waiting');
    // the other block's results stay
    expect(state.rounds[0].matches[2].status).toBe('done');
    expect(decisions.every((d) => d.targetId.startsWith('r0-'))).toBe(true);
  });

  it('postponed matches stay open; the round only completes with every decision', () => {
    const t = makeTournament(16, cypher);
    let state = computeState(t);
    const first = state.openItems[0].id;
    let tt = t;
    for (const item of state.openItems.slice(1)) {
      const m = findMatch(state, item.id)!;
      tt = { ...tt, decisions: addDecision(tt, { id: item.id, targetId: item.id, songIds: m.songIds, at: '', selected: m.songIds.slice(0, 2) })! };
    }
    state = computeState(tt);
    expect(state.rounds.length).toBe(1);
    expect(state.openItems).toEqual([{ type: 'match', id: first }]);
  });
});

describe('Draw options', () => {
  it('avoids same-artist pairs in round 1 when possible', () => {
    // 16 songs, 8 artists with two songs each
    const list = songs(16, (i) => `A${Math.floor(i / 2)}`);
    const cfg = { ...duel, drawMode: 'original' as const, avoidSameArtist: true };
    const t = makeTournament(16, cfg, 1, list);
    const state = computeState(t);
    const artist = (id: string) => list.find((s) => s.id === id)!.artists[0];
    for (const m of state.rounds[0].matches) {
      expect(artist(m.songIds[0])).not.toBe(artist(m.songIds[1]));
    }
    expect(t.drawNotes[0]).toContain('nicht aufeinander');
  });

  it('explains when separation is impossible', () => {
    const list = songs(8, () => 'Same');
    const t = makeTournament(8, { ...cypher, avoidSameArtist: true }, 1, list);
    expect(t.drawNotes[0]).toContain('nicht vollständig trennen');
  });

  it('rejects starting with 0 or 1 song', () => {
    expect(checkConfig(cypher, 0).errors.length).toBe(1);
    expect(checkConfig(cypher, 1).errors.length).toBe(1);
    expect(checkConfig(cypher, 2).errors.length).toBe(0);
  });

  it('extra spots without ranking are not offered', () => {
    expect(checkConfig({ ...cypher, extraMode: 'perBlock' }, 8).errors.length).toBe(1);
    expect(normalizeConfig({ ...cypher, extraMode: 'perBlock' }).extraMode).toBe('none');
  });
});

describe('Results', () => {
  it('winner path and elimination stages without invented places', () => {
    const { state } = playThrough(makeTournament(16, duel));
    const path = songPath(state, state.champion!);
    expect(path.length).toBe(4);
    expect(path[path.length - 1].via).toBe('final');
    const groups = eliminationGroups(state);
    expect(groups.map((g) => g.label)).toEqual([
      'Ausgeschieden: Halbfinale',
      'Ausgeschieden: Viertelfinale',
      'Ausgeschieden: Achtelfinale',
    ]);
    expect(groups.reduce((n, g) => n + g.songIds.length, 0)).toBe(14);
  });
});
