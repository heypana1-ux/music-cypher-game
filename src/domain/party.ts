// Party mode: several people vote on the same device, the group result decides.
// Aggregation is transparent and never breaks ties silently – tied songs at a
// qualification boundary go back to the group (the host settles them explicitly).

import { relevantTies } from './engine';
import type { Evaluation, PartyVote } from './types';

export interface AggregateInput {
  songIds: string[];
  /** How many songs advance (or spots for an extra-spot vote). */
  advanceCount: number;
  evaluation: Evaluation;
  candidateRequired: boolean;
}

export interface Aggregate {
  /** Group order, best first (ties kept in slot order until the host resolves them). */
  order: string[];
  /** Per song: votes (select), Borda points (rank) or average score (score). */
  value: Record<string, number>;
  unit: 'Stimmen' | 'Punkte' | 'Ø Punkte';
  /** Tie clusters that decide qualification and must be settled explicitly. */
  ties: string[][];
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function aggregateVotes(m: AggregateInput, votes: PartyVote[]): Aggregate {
  const value: Record<string, number> = Object.fromEntries(m.songIds.map((s) => [s, 0]));
  let unit: Aggregate['unit'];
  if (m.evaluation === 'select') {
    unit = 'Stimmen';
    for (const v of votes) for (const s of v.selected ?? []) if (s in value) value[s] += 1;
  } else if (m.evaluation === 'rank') {
    unit = 'Punkte';
    const n = m.songIds.length;
    // Borda count: last place 0 points, first place n−1
    for (const v of votes) (v.order ?? []).forEach((s, i) => s in value && (value[s] += n - 1 - i));
  } else {
    unit = 'Ø Punkte';
    for (const s of m.songIds) {
      const xs = votes.map((v) => v.scores?.[s]).filter((x): x is number => typeof x === 'number');
      value[s] = xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : 1;
    }
  }
  const order = m.songIds.slice().sort((a, b) => value[b] - value[a] || m.songIds.indexOf(a) - m.songIds.indexOf(b));
  const ties = relevantTies(order, value, m.advanceCount, m.candidateRequired);
  return { order, value, unit, ties };
}

/** Apply the host's explicit ordering of tied clusters to the group order. */
export function applyTieOrder(order: string[], resolved: string[][]): string[] {
  const out = order.slice();
  for (const cluster of resolved) {
    const positions = out.map((s, i) => (cluster.includes(s) ? i : -1)).filter((i) => i >= 0);
    positions.forEach((pos, k) => (out[pos] = cluster[k]));
  }
  return out;
}

/** Share of a voter's top-k picks that the group also sent through (0..1). */
export function agreement(vote: PartyVote, qualified: string[], k: number): number | null {
  let top: string[] = [];
  if (vote.selected) top = vote.selected;
  else if (vote.order) top = vote.order.slice(0, k);
  else if (vote.scores) {
    const sc = vote.scores;
    top = Object.keys(sc)
      .sort((a, b) => sc[b] - sc[a])
      .slice(0, k);
  }
  if (!top.length || !k) return null;
  return top.filter((s) => qualified.includes(s)).length / Math.min(k, top.length);
}
