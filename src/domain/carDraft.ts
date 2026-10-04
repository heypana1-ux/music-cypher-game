// Car mode: while driving you only tap big buttons (Top/Gut/Okay/Raus) or a star. Those marks are a
// draft – the real decision is made with one tap on "Vorschlag übernehmen" or later when parked.
// Ties are never broken silently: a tied proposal can't be confirmed from the car screen.

import { relevantTies } from './engine';
import type { CarDraft, CarRating, Decision, Evaluation } from './types';

export type CarStyle = 'buttons' | 'stars';

export const RATING_LABELS: Record<CarRating, string> = { 4: 'Top', 3: 'Gut', 2: 'Okay', 1: 'Raus' };
/** Score-mode mapping of the buttons (1–10 scale). */
export const RATING_SCORE: Record<CarRating, number> = { 4: 9, 3: 7, 2: 5, 1: 3 };

export interface DraftTarget {
  id: string;
  songIds: string[];
  advanceCount: number;
  evaluation: Evaluation;
  candidateRequired: boolean;
  /** Playoffs: always a plain selection among the contested songs. */
  isPlayoff?: boolean;
}

export interface Proposal {
  /** Best first. */
  order: string[];
  value: Record<string, number>;
  selected: string[];
  /** Ties that decide something – must be resolved when parked. */
  ties: string[][];
  /** Songs without any mark. */
  unrated: string[];
  /** Ready to confirm with one tap. */
  complete: boolean;
  reason: string | null;
}

export function emptyDraft(): CarDraft {
  return { ratings: {}, stars: [], heard: [], updatedAt: new Date().toISOString() };
}

export function proposal(target: DraftTarget, draft: CarDraft | undefined, style: CarStyle): Proposal {
  const d = draft ?? emptyDraft();
  const value: Record<string, number> = {};
  for (const id of target.songIds) {
    value[id] = style === 'stars' ? (d.stars.includes(id) ? 1 : 0) : (d.ratings[id] ?? 0);
  }
  const order = target.songIds.slice().sort((a, b) => value[b] - value[a] || target.songIds.indexOf(a) - target.songIds.indexOf(b));
  const adv = target.advanceCount;
  const evaluation = target.isPlayoff ? 'select' : target.evaluation;
  const unrated = style === 'buttons' ? target.songIds.filter((id) => !d.ratings[id]) : [];
  // Rank mode needs a full order, so every tie matters there.
  const ties =
    evaluation === 'rank'
      ? clusters(order, value)
      : relevantTies(order, value, adv, !target.isPlayoff && target.candidateRequired);
  let reason: string | null = null;
  if (style === 'stars' && d.stars.length !== adv) reason = `Markiere genau ${adv} ${adv === 1 ? 'Song' : 'Songs'} mit ★.`;
  else if (style === 'buttons' && unrated.length && evaluation !== 'select') reason = 'Nicht alle Songs bewertet.';
  else if (ties.length) reason = 'Gleichstand – beim nächsten Halt entscheiden.';
  return { order, value, selected: order.slice(0, adv), ties, unrated, complete: reason === null, reason };
}

function clusters(order: string[], value: Record<string, number>): string[][] {
  const out: string[][] = [];
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && value[order[j + 1]] === value[order[i]]) j++;
    if (j > i) out.push(order.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/** Decision payload for a complete proposal. */
export function proposalDecision(target: DraftTarget, p: Proposal, draft: CarDraft, style: CarStyle): Omit<Decision, 'id' | 'at'> {
  const base = { targetId: target.id, songIds: target.songIds };
  if (target.isPlayoff || target.evaluation === 'select') return { ...base, selected: p.selected };
  if (target.evaluation === 'rank') return { ...base, order: p.order };
  const scores = Object.fromEntries(
    target.songIds.map((id) => [id, style === 'stars' ? (draft.stars.includes(id) ? 8 : 4) : RATING_SCORE[draft.ratings[id] ?? 1]]),
  );
  return { ...base, scores, order: p.order, resolvedTies: [] };
}
