// Overall song rating (Elo) built from every decision in every tournament.
// Each decided encounter is broken into head-to-head results:
//   - selection: every song that advanced beat every song that went out
//   - rank / score: higher place beats lower place; unresolved equal scores count as a draw
//   - extra-spot votes: winners beat the other candidates
// In a group of n songs each pairing uses K/(n−1), so a cypher moves ratings about as much as a duel.

import { computeState } from './engine';
import type { Song, Tournament } from './types';

export const START_RATING = 1500;
const K = 32;

export interface SongRating {
  song: Song;
  rating: number;
  peak: number;
  /** Head-to-head comparisons the rating is based on. */
  comparisons: number;
  wins: number;
  losses: number;
  draws: number;
  tournaments: number;
  /** Change caused by the most recent encounter. */
  lastChange: number;
}

interface Event {
  at: string;
  order: number;
  /** Pairs [winner, loser, isDraw] */
  pairs: Array<[string, string, boolean]>;
  groupSize: number;
  songs: Song[];
  tournamentId: string;
}

function eventsOf(t: Tournament): Event[] {
  const state = computeState(t);
  const byId = new Map(t.songs.map((s) => [s.id, s]));
  const events: Event[] = [];
  let seq = 0;
  for (const round of state.rounds) {
    for (const m of round.matches) {
      if (m.status !== 'done' || !m.outcome || !m.decision) continue;
      const pairs: Array<[string, string, boolean]> = [];
      const o = m.outcome;
      if (o.order) {
        const scores = m.decision.scores;
        const shared = o.sharedTies;
        for (let i = 0; i < o.order.length; i++) {
          for (let j = i + 1; j < o.order.length; j++) {
            const a = o.order[i];
            const b = o.order[j];
            const draw = !!scores && scores[a] === scores[b] && shared.some((c) => c.includes(a) && c.includes(b));
            pairs.push([a, b, draw]);
          }
        }
      } else {
        for (const w of o.qualified) for (const l of o.eliminated) pairs.push([w, l, false]);
      }
      events.push({
        at: m.decision.at,
        order: seq++,
        pairs,
        groupSize: m.songIds.length,
        songs: m.songIds.map((id) => byId.get(id)!).filter(Boolean),
        tournamentId: t.id,
      });
    }
    for (const p of round.playoffs) {
      if (!p.decision) continue; // automatic extra spots repeat the group scores – no new comparison
      const pairs: Array<[string, string, boolean]> = [];
      const losers = p.contested.filter((c) => !p.winners.includes(c));
      for (const w of p.winners.filter((x) => p.contested.includes(x))) for (const l of losers) pairs.push([w, l, false]);
      events.push({
        at: p.decision.at,
        order: seq++,
        pairs,
        groupSize: p.contested.length,
        songs: p.contested.map((id) => byId.get(id)!).filter(Boolean),
        tournamentId: t.id,
      });
    }
  }
  return events;
}

export function computeRatings(tournaments: Tournament[]): SongRating[] {
  const events = tournaments
    .flatMap((t) => eventsOf(t))
    .sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const table = new Map<string, SongRating & { _t: Set<string> }>();
  const get = (s: Song) => {
    let r = table.get(s.id);
    if (!r) {
      r = { song: s, rating: START_RATING, peak: START_RATING, comparisons: 0, wins: 0, losses: 0, draws: 0, tournaments: 0, lastChange: 0, _t: new Set() };
      table.set(s.id, r);
    }
    return r;
  };
  for (const ev of events) {
    const k = K / Math.max(1, ev.groupSize - 1);
    const delta = new Map<string, number>();
    const songById = new Map(ev.songs.map((s) => [s.id, s]));
    for (const s of ev.songs) get(s)._t.add(ev.tournamentId);
    for (const [a, b, draw] of ev.pairs) {
      const sa = songById.get(a);
      const sb = songById.get(b);
      if (!sa || !sb) continue;
      const ra = get(sa);
      const rb = get(sb);
      const expA = 1 / (1 + 10 ** ((rb.rating - ra.rating) / 400));
      const scoreA = draw ? 0.5 : 1;
      const d = k * (scoreA - expA);
      delta.set(a, (delta.get(a) ?? 0) + d);
      delta.set(b, (delta.get(b) ?? 0) - d);
      ra.comparisons++;
      rb.comparisons++;
      if (draw) {
        ra.draws++;
        rb.draws++;
      } else {
        ra.wins++;
        rb.losses++;
      }
    }
    // apply simultaneously so the order of pairs inside one encounter doesn't matter
    for (const [id, d] of delta) {
      const r = table.get(id)!;
      r.rating += d;
      r.lastChange = d;
      r.peak = Math.max(r.peak, r.rating);
    }
  }
  return [...table.values()]
    .map(({ _t, ...r }) => ({ ...r, tournaments: _t.size }))
    .sort((a, b) => b.rating - a.rating);
}
