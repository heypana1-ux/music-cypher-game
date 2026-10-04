// Overall song rating (Elo) built from every decision in every tournament.
// Each decided encounter is broken into head-to-head results:
//   - selection: every song that advanced beat every song that went out
//   - rank / score: higher place beats lower place; unresolved equal scores count as a draw
//   - extra-spot votes: winners beat the other candidates
// In a group of n songs each pairing uses K/(n−1), so a cypher moves ratings about as much as a duel.

import { computeState } from './engine';
import { songInRound } from './participants';
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
  tournamentName: string;
  label: string;
}

function eventsOf(t: Tournament): Event[] {
  const state = computeState(t);
  const byId = new Map(t.songs.map((s) => [s.id, s]));
  const events: Event[] = [];
  let seq = 0;
  for (const round of state.rounds) {
    // In an artist cypher the participants are artists – rate the songs they actually played.
    const real = (id: string) => (t.artistMode ? songInRound(t, id, round.index) : byId.get(id));
    const realId = (id: string) => real(id)?.id ?? id;
    const mapPairs = (ps: Array<[string, string, boolean]>) => ps.map(([a, b, d]) => [realId(a), realId(b), d] as [string, string, boolean]);
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
        pairs: mapPairs(pairs),
        groupSize: m.songIds.length,
        songs: m.songIds.map((id) => real(id)!).filter(Boolean),
        tournamentId: t.id,
        tournamentName: t.name,
        label: round.label,
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
        pairs: mapPairs(pairs),
        groupSize: p.contested.length,
        songs: p.contested.map((id) => real(id)!).filter(Boolean),
        tournamentId: t.id,
        tournamentName: t.name,
        label: `${round.label} · Zusatzplatz`,
      });
    }
  }
  return events;
}

/** A song beat a song that was rated higher at that moment. */
export interface Upset {
  winner: Song;
  loser: Song;
  winnerRating: number;
  loserRating: number;
  /** Rating gap the winner overcame. */
  gap: number;
  at: string;
  tournamentId: string;
  tournamentName: string;
  label: string;
}

export interface Meeting {
  at: string;
  tournamentName: string;
  label: string;
  /** Song ID of the winner, null for a draw. */
  winner: string | null;
}

export interface HeadToHead {
  a: Song;
  b: Song;
  winsA: number;
  winsB: number;
  draws: number;
  meetings: Meeting[];
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

interface RatingRun {
  table: Map<string, SongRating>;
  upsets: Upset[];
  h2h: Map<string, HeadToHead>;
}

/** One chronological pass over all decisions. `until` stops before that moment (ratings "as of"). */
function runRatings(tournaments: Tournament[], until?: string): RatingRun {
  const events = tournaments
    .flatMap((t) => eventsOf(t))
    .filter((e) => !until || e.at < until)
    .sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const table = new Map<string, SongRating & { _t: Set<string> }>();
  const upsets: Upset[] = [];
  const h2h = new Map<string, HeadToHead>();
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
      // only count as an upset if both songs already had a track record
      if (!draw && rb.rating > ra.rating && ra.comparisons > 0 && rb.comparisons > 0) {
        upsets.push({
          winner: sa,
          loser: sb,
          winnerRating: ra.rating,
          loserRating: rb.rating,
          gap: rb.rating - ra.rating,
          at: ev.at,
          tournamentId: ev.tournamentId,
          tournamentName: ev.tournamentName,
          label: ev.label,
        });
      }
      const key = pairKey(a, b);
      let h = h2h.get(key);
      if (!h) {
        const [x, y] = a < b ? [sa, sb] : [sb, sa];
        h = { a: x, b: y, winsA: 0, winsB: 0, draws: 0, meetings: [] };
        h2h.set(key, h);
      }
      if (draw) h.draws++;
      else if (h.a.id === a) h.winsA++;
      else h.winsB++;
      h.meetings.push({ at: ev.at, tournamentName: ev.tournamentName, label: ev.label, winner: draw ? null : a });
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
  const out = new Map<string, SongRating>();
  for (const [id, { _t, ...r }] of table) out.set(id, { ...r, tournaments: _t.size });
  return { table: out, upsets, h2h };
}

export function computeRatings(tournaments: Tournament[]): SongRating[] {
  return [...runRatings(tournaments).table.values()].sort((a, b) => b.rating - a.rating);
}

/** Ratings as they stood right before `until` (e.g. the start of a tournament). */
export function ratingsAt(tournaments: Tournament[], until: string): Map<string, SongRating> {
  return runRatings(tournaments, until).table;
}

export interface RatingInsights {
  /** Biggest upsets first. */
  upsets: Upset[];
  h2h: Map<string, HeadToHead>;
}

export function ratingInsights(tournaments: Tournament[]): RatingInsights {
  const r = runRatings(tournaments);
  return { upsets: r.upsets.sort((a, b) => b.gap - a.gap), h2h: r.h2h };
}

/** Head-to-head records between every pair of the given songs that has met before. */
export function headToHeadFor(h2h: Map<string, HeadToHead>, songIds: string[]): HeadToHead[] {
  const out: HeadToHead[] = [];
  for (let i = 0; i < songIds.length; i++) {
    for (let j = i + 1; j < songIds.length; j++) {
      const h = h2h.get(pairKey(songIds[i], songIds[j]));
      if (h) out.push(h);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Underdogs and favourites: tournament results compared to the rating before the tournament

export interface Surprise {
  song: Song;
  tournament: Tournament;
  /** Rating right before the tournament started. */
  preRating: number;
  /** Place in the pre-tournament rating among rated participants (1 = favourite). */
  preRank: number;
  rated: number;
  stage: string;
  progress: number;
  /** progress − expected progress; positive = better than expected. */
  surprise: number;
}

export function tournamentSurprises(
  tournaments: Tournament[],
  runsOf: (t: Tournament) => Array<{ songId: string; progress: number; stage: string }>,
): { underdogs: Surprise[]; flops: Surprise[] } {
  const all: Surprise[] = [];
  for (const t of tournaments) {
    if (t.artistMode) continue; // artists bring different songs each round – no single pre-rating
    const st = computeState(t);
    if (!st.finished) continue;
    const firstAt = st.validDecisions.map((d) => d.at).sort()[0];
    if (!firstAt) continue;
    const pre = ratingsAt(tournaments, firstAt);
    const byId = new Map(t.songs.map((s) => [s.id, s]));
    const runs = runsOf(t).filter((r) => (pre.get(r.songId)?.comparisons ?? 0) >= 2);
    if (runs.length < 4) continue; // too few known songs for a meaningful expectation
    const sorted = runs.slice().sort((a, b) => pre.get(b.songId)!.rating - pre.get(a.songId)!.rating);
    sorted.forEach((r, i) => {
      const expected = 1 - i / (sorted.length - 1);
      all.push({
        song: byId.get(r.songId)!,
        tournament: t,
        preRating: pre.get(r.songId)!.rating,
        preRank: i + 1,
        rated: sorted.length,
        stage: r.stage,
        progress: r.progress,
        surprise: r.progress - expected,
      });
    });
  }
  return {
    underdogs: all.filter((x) => x.surprise >= 0.35).sort((a, b) => b.surprise - a.surprise),
    flops: all.filter((x) => x.surprise <= -0.35).sort((a, b) => a.surprise - b.surprise),
  };
}
