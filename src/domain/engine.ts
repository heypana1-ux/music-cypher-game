// Tournament engine. The state is derived purely from (config, frozen songs, draw, seed, decisions),
// so reloading, undo and "reopen a match" are all just a replay of the stored decisions.

import { deriveSeed, mulberry32, shuffle } from './rng';
import type {
  Decision,
  MatchKind,
  MatchOutcome,
  MatchState,
  OpenItem,
  PlayoffState,
  RoundState,
  Song,
  Tournament,
  TournamentConfig,
  TournamentState,
} from './types';

export function nextPow2(n: number): number {
  let b = 1;
  while (b < n) b *= 2;
  return b;
}

export function isPowerOfTwo(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0;
}

// ---------------------------------------------------------------------------
// Round names

const DUEL_ROUND_NAMES: Record<number, string> = {
  2: 'Finale',
  4: 'Halbfinale',
  8: 'Viertelfinale',
  16: 'Achtelfinale',
  32: '16tel-Finale',
  64: '32stel-Finale',
  128: '64stel-Finale',
  256: '128stel-Finale',
  512: '256stel-Finale',
};

/** Name of a knockout round by the number of bracket places (songs + byes). */
export function duelRoundName(places: number): string {
  return DUEL_ROUND_NAMES[places] ?? `Runde der ${places}`;
}

// ---------------------------------------------------------------------------
// Structure building (shared by the real engine and the setup preview)

interface GroupSpec {
  kind: MatchKind;
  songIds: string[];
  advanceCount: number;
}

/**
 * Round-1 knockout slots for N songs: bracket of B = nextPow2(N) places, B−N byes.
 * Byes are spread evenly over the matches so no match ever has two empty places.
 * The first B−N songs of the draw receive the byes (top seeds when the draw is a seed list).
 */
export function duelFirstRoundGroups(draw: string[]): GroupSpec[] {
  const n = draw.length;
  if (n < 2) return [];
  const places = nextPow2(n);
  const matchCount = places / 2;
  const byes = places - n;
  const byeIdx = new Set<number>();
  for (let k = 0; k < byes; k++) byeIdx.add(Math.floor((k * matchCount) / byes));
  const byeSongs = draw.slice(0, byes);
  const rest = draw.slice(byes);
  const groups: GroupSpec[] = [];
  let bi = 0;
  let ri = 0;
  for (let m = 0; m < matchCount; m++) {
    if (byeIdx.has(m)) {
      groups.push({ kind: 'bye', songIds: [byeSongs[bi++]], advanceCount: 1 });
    } else {
      groups.push({
        kind: places === 2 ? 'final' : 'duel',
        songIds: [rest[ri++], rest[ri++]],
        advanceCount: 1,
      });
    }
  }
  return groups;
}

export function duelLaterRoundGroups(entrants: string[]): GroupSpec[] {
  const groups: GroupSpec[] = [];
  for (let i = 0; i < entrants.length; i += 2) {
    groups.push({
      kind: entrants.length === 2 ? 'final' : 'duel',
      songIds: [entrants[i], entrants[i + 1]],
      advanceCount: 1,
    });
  }
  return groups;
}

/**
 * Cypher round: as many full groups of four as possible; a remainder of 2–3 forms a clearly
 * marked special group (advance = min(rule, size − 1)); a single leftover song gets a bye.
 * 2–4 songs in total form the final (exactly one winner).
 */
export function cypherRoundGroups(entrants: string[], advancePerGroup: number): GroupSpec[] {
  const n = entrants.length;
  if (n < 2) return [];
  if (n <= 4) return [{ kind: 'final', songIds: entrants.slice(), advanceCount: 1 }];
  const groups: GroupSpec[] = [];
  const full = Math.floor(n / 4);
  for (let g = 0; g < full; g++) {
    groups.push({ kind: 'cypher', songIds: entrants.slice(g * 4, g * 4 + 4), advanceCount: advancePerGroup });
  }
  const rest = entrants.slice(full * 4);
  if (rest.length === 1) groups.push({ kind: 'bye', songIds: rest, advanceCount: 1 });
  else if (rest.length >= 2) {
    groups.push({ kind: 'special', songIds: rest, advanceCount: Math.min(advancePerGroup, rest.length - 1) });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Config helpers

export function extrasActive(config: TournamentConfig): boolean {
  return config.format === 'cypher' && config.evaluation !== 'select' && config.extraMode !== 'none';
}

/** How many extra spots a round with `fullGroups` full cyphers gets under the per-round rule. */
export function perRoundSpots(config: TournamentConfig, fullGroups: number): number {
  if (fullGroups < 2) return 0;
  const cap = config.advancePerGroup === 3 ? fullGroups - 1 : fullGroups;
  return Math.max(0, Math.min(config.extraPerRound, cap));
}

// ---------------------------------------------------------------------------
// Draw

function artistKeys(song: Song | undefined): string[] {
  if (!song) return [];
  return song.artists.map((a) => a.trim().toLowerCase()).filter(Boolean);
}

function groupHasArtistClash(ids: string[], byId: Map<string, Song>): boolean {
  const seen = new Set<string>();
  for (const id of ids) {
    for (const k of artistKeys(byId.get(id))) {
      if (seen.has(k)) return true;
    }
    for (const k of artistKeys(byId.get(id))) seen.add(k);
  }
  return false;
}

/** Positions (indices into the draw) forming each group of round 1. */
function firstRoundPositionGroups(n: number, config: TournamentConfig): number[][] {
  const idx = Array.from({ length: n }, (_, i) => String(i));
  const groups = config.format === 'duel' ? duelFirstRoundGroups(idx) : cypherRoundGroups(idx, config.advancePerGroup);
  return groups.filter((g) => g.kind !== 'bye').map((g) => g.songIds.map(Number));
}

export function makeDraw(
  songs: Song[],
  config: TournamentConfig,
  seed: number,
): { draw: string[]; notes: string[] } {
  const ordered = songs.slice().sort((a, b) => a.originalIndex - b.originalIndex);
  const rand = mulberry32(deriveSeed(seed, 'draw'));
  const draw = (config.drawMode === 'random' ? shuffle(ordered, rand) : ordered).map((s) => s.id);
  const notes: string[] = [];
  if (config.avoidSameArtist && draw.length > 2) {
    const clashes = separateArtists(draw, songs, config, mulberry32(deriveSeed(seed, 'artists')));
    if (clashes > 0) {
      notes.push(
        `Gleiche Interpreten ließen sich nicht vollständig trennen: ${clashes} ${
          clashes === 1 ? 'Begegnung enthält' : 'Begegnungen enthalten'
        } in der ersten Runde mehrere Songs desselben Interpreten.`,
      );
    } else {
      notes.push('Songs desselben Interpreten treffen in der ersten Runde nicht aufeinander.');
    }
  }
  return { draw, notes };
}

/** Swap songs between round-1 groups to avoid artist clashes. Returns remaining clash count. */
function separateArtists(draw: string[], songs: Song[], config: TournamentConfig, rand: () => number): number {
  const byId = new Map(songs.map((s) => [s.id, s]));
  const groups = firstRoundPositionGroups(draw.length, config);
  const ids = (g: number[]) => g.map((p) => draw[p]);
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (!groupHasArtistClash(ids(g), byId)) continue;
      // try every position of this group against every position elsewhere
      const order = shuffle(
        groups.map((_, i) => i).filter((i) => i !== gi),
        rand,
      );
      let fixed = false;
      for (const pa of g) {
        for (const gj of order) {
          for (const pb of groups[gj]) {
            [draw[pa], draw[pb]] = [draw[pb], draw[pa]];
            if (!groupHasArtistClash(ids(g), byId) && !groupHasArtistClash(ids(groups[gj]), byId)) {
              fixed = true;
              break;
            }
            [draw[pa], draw[pb]] = [draw[pb], draw[pa]];
          }
          if (fixed) break;
        }
        if (fixed) break;
      }
      if (fixed) changed = true;
    }
    if (!changed) break;
  }
  return groups.filter((g) => groupHasArtistClash(ids(g), byId)).length;
}

// ---------------------------------------------------------------------------
// Evaluation of a single match

export function scoreBoundaries(advanceCount: number, candidateRequired: boolean): number[] {
  return candidateRequired ? [advanceCount, advanceCount + 1] : [advanceCount];
}

/** Clusters of equal score in a score-ordered list: [startIndex, endIndex] inclusive. */
export function tieClusters(order: string[], scores: Record<string, number>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && scores[order[j + 1]] === scores[order[i]]) j++;
    if (j > i) out.push([i, j]);
    i = j + 1;
  }
  return out;
}

/** Tie clusters that decide who qualifies (or who is the extra-spot candidate). */
export function relevantTies(
  order: string[],
  scores: Record<string, number>,
  advanceCount: number,
  candidateRequired: boolean,
): string[][] {
  const bounds = scoreBoundaries(advanceCount, candidateRequired).filter((b) => b < order.length);
  return tieClusters(order, scores)
    .filter(([i, j]) => bounds.some((b) => i < b && j >= b))
    .map(([i, j]) => order.slice(i, j + 1));
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function isPermutation(order: string[] | undefined, ids: string[]): order is string[] {
  return !!order && order.length === ids.length && new Set(order).size === ids.length && sameSet(order, ids);
}

export function evaluateMatch(
  match: Pick<MatchState, 'kind' | 'songIds' | 'advanceCount' | 'evaluation' | 'candidateRequired'>,
  d: Decision,
): MatchOutcome | string {
  const ids = match.songIds;
  const adv = match.advanceCount;
  const candReq = match.candidateRequired;
  if (match.evaluation === 'select') {
    const sel = d.selected ?? [];
    if (new Set(sel).size !== sel.length) return 'Doppelte Auswahl.';
    if (sel.length !== adv) return `Es müssen genau ${adv} Songs ausgewählt werden.`;
    if (!sel.every((s) => ids.includes(s))) return 'Auswahl enthält fremde Songs.';
    // Qualified keep their slot order: the click order never creates a hidden ranking.
    return {
      order: null,
      sharedTies: [],
      qualified: ids.filter((s) => sel.includes(s)),
      eliminated: ids.filter((s) => !sel.includes(s)),
      candidate: null,
    };
  }
  if (!isPermutation(d.order, ids)) return 'Die Rangfolge muss alle Songs genau einmal enthalten.';
  const order = d.order;
  if (match.evaluation === 'rank') {
    return {
      order,
      sharedTies: [],
      qualified: order.slice(0, adv),
      eliminated: order.slice(adv),
      candidate: candReq ? (order[adv] ?? null) : null,
    };
  }
  // score
  const scores = d.scores ?? {};
  for (const id of ids) {
    const v = scores[id];
    // Party mode stores averages (e.g. 7.33), so decimals are allowed within 1–10.
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 10) {
      return 'Jeder Song braucht eine Bewertung von 1 bis 10.';
    }
  }
  for (let i = 1; i < order.length; i++) {
    if (scores[order[i]] > scores[order[i - 1]]) return 'Die Reihenfolge passt nicht zu den Punkten.';
  }
  const needed = relevantTies(order, scores, adv, candReq);
  const resolved = d.resolvedTies ?? [];
  for (const cluster of needed) {
    if (!resolved.some((r) => sameSet(r, cluster))) {
      return 'Punktgleichheit an einer Qualifikationsgrenze muss ausdrücklich entschieden werden.';
    }
  }
  const sharedTies = tieClusters(order, scores)
    .map(([i, j]) => order.slice(i, j + 1))
    .filter((c) => !resolved.some((r) => sameSet(r, c)));
  return {
    order,
    sharedTies,
    qualified: order.slice(0, adv),
    eliminated: order.slice(adv),
    candidate: candReq ? (order[adv] ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Playoffs (extra spots)

function setupPlayoff(p: PlayoffState, matches: MatchState[], config: TournamentConfig): void {
  const sources = p.sourceMatchIds.map((id) => matches.find((m) => m.id === id)!);
  if (!sources.every((m) => m.status === 'done')) {
    p.status = 'waiting';
    return;
  }
  p.candidates = sources.map((m) => m.outcome!.candidate).filter((c): c is string => !!c);
  const spots = Math.min(p.spots, p.candidates.length);
  if (config.evaluation === 'score') {
    const scores: Record<string, number> = {};
    for (const m of sources) {
      const c = m.outcome!.candidate;
      if (c) scores[c] = m.decision!.scores![c];
    }
    p.scores = scores;
    const sorted = p.candidates.slice().sort((a, b) => scores[b] - scores[a]);
    if (spots >= sorted.length) {
      p.sureWinners = sorted;
      p.contested = [];
      p.contestedSpots = 0;
    } else {
      const cut = scores[sorted[spots - 1]];
      if (cut > scores[sorted[spots]]) {
        p.sureWinners = sorted.slice(0, spots);
        p.contested = [];
        p.contestedSpots = 0;
      } else {
        p.sureWinners = sorted.filter((c) => scores[c] > cut);
        p.contested = sorted.filter((c) => scores[c] === cut);
        p.contestedSpots = spots - p.sureWinners.length;
      }
    }
  } else {
    p.sureWinners = spots >= p.candidates.length ? p.candidates.slice() : [];
    p.contested = spots >= p.candidates.length ? [] : p.candidates.slice();
    p.contestedSpots = spots >= p.candidates.length ? 0 : spots;
  }
  if (p.contestedSpots === 0) {
    p.status = 'auto';
    p.winners = p.sureWinners.slice();
  } else {
    p.status = 'open';
  }
}

export function evaluatePlayoff(p: PlayoffState, d: Decision): string[] | string {
  const sel = d.selected ?? [];
  if (new Set(sel).size !== sel.length) return 'Doppelte Auswahl.';
  if (sel.length !== p.contestedSpots) return `Es müssen genau ${p.contestedSpots} Songs gewählt werden.`;
  if (!sel.every((s) => p.contested.includes(s))) return 'Auswahl enthält Songs, die nicht im Vergleich stehen.';
  return [...p.sureWinners, ...p.contested.filter((c) => sel.includes(c))];
}

// ---------------------------------------------------------------------------
// Round building

interface Ctx {
  config: TournamentConfig;
  seed: number;
  bracketPlaces: number; // duel: places of round 1
}

function roundLabels(
  ctx: Ctx,
  index: number,
  entrants: string[],
  groups: GroupSpec[],
): { label: string; sublabel: string; isFinal: boolean; isPrelim: boolean; notes: string[] } {
  const { config } = ctx;
  const byes = groups.filter((g) => g.kind === 'bye').length;
  const notes: string[] = [];
  const isFinal = groups.some((g) => g.kind === 'final');
  if (config.format === 'duel') {
    const places = index === 0 ? ctx.bracketPlaces : entrants.length;
    const duels = groups.filter((g) => g.kind !== 'bye').length;
    const main = typeof config.duelMainRound === 'number' ? config.duelMainRound : null;
    const isPrelim = main !== null && places > main;
    let label: string;
    if (isPrelim) {
      // count prelim rounds: places M*2^k → Vorrunde (s−k+1) of s
      let total = 0;
      for (let p = ctx.bracketPlaces; p > main!; p /= 2) total++;
      label = total > 1 ? `Vorrunde ${index + 1}` : 'Vorrunde';
    } else {
      label = duelRoundName(places);
      if (main !== null && places === main) label += ' (Hauptrunde)';
    }
    const parts = [`${entrants.length} Songs`, `${duels} ${duels === 1 ? 'Duell' : 'Duelle'}`];
    if (byes > 0) parts.push(isPrelim ? `${byes} direkt gesetzt` : `${byes} ${byes === 1 ? 'Freilos' : 'Freilose'}`);
    if (isPrelim && byes > 0) {
      notes.push(`${byes} Songs sind direkt für die nächste Runde gesetzt, ${duels * 2} Songs spielen ${duels} Duelle.`);
    } else if (byes > 0) {
      notes.push(`${byes} Songs haben ein Freilos und kommen ohne Duell weiter.`);
    }
    return { label, sublabel: parts.join(' · '), isFinal, isPrelim, notes };
  }
  // cypher
  if (isFinal) {
    const n = entrants.length;
    const sub = n === 2 ? 'Finalduell' : n === 3 ? 'Finale mit drei Songs' : 'Finale Cypher';
    return { label: 'Finale', sublabel: `${sub} – genau ein Gewinner`, isFinal, isPrelim: false, notes };
  }
  const full = groups.filter((g) => g.kind === 'cypher').length;
  const special = groups.find((g) => g.kind === 'special');
  const parts = [`${entrants.length} Songs – ${full} ${full === 1 ? 'Cypher' : 'Cyphers'}`];
  if (special) {
    parts.push(`1 Sondergruppe (${special.songIds.length})`);
    notes.push(
      `Sondergruppe mit ${special.songIds.length} Songs: ${special.advanceCount} ${
        special.advanceCount === 1 ? 'kommt' : 'kommen'
      } weiter (höchstens Gruppengröße minus eins).`,
    );
  }
  if (byes > 0) {
    parts.push('1 Freilos');
    notes.push('Ein übriger Song erhält ein Freilos und kommt ohne Begegnung weiter.');
  }
  return { label: `Runde ${index + 1}`, sublabel: parts.join(' · '), isFinal: false, isPrelim: false, notes };
}

function buildRound(ctx: Ctx, index: number, entrants: string[], prev: RoundState | null): RoundState {
  const { config } = ctx;
  let groups: GroupSpec[];
  if (config.format === 'duel') {
    groups = index === 0 ? duelFirstRoundGroups(entrants) : duelLaterRoundGroups(entrants);
  } else {
    groups = cypherRoundGroups(entrants, config.advancePerGroup);
  }
  const lab = roundLabels(ctx, index, entrants, groups);
  const evaluation = config.format === 'duel' ? 'select' : config.evaluation;
  const matches: MatchState[] = groups.map((g, i) => ({
    id: `r${index}-m${i}`,
    roundIndex: index,
    index: i,
    kind: g.kind,
    songIds: g.songIds,
    advanceCount: g.advanceCount,
    evaluation: g.kind === 'bye' ? 'select' : evaluation,
    blockIndex: null,
    candidateRequired: false,
    status: g.kind === 'bye' ? 'auto' : 'open',
    outcome:
      g.kind === 'bye'
        ? { order: null, sharedTies: [], qualified: g.songIds.slice(), eliminated: [], candidate: null }
        : undefined,
  }));

  // third place match (duel only)
  if (config.format === 'duel' && config.thirdPlaceMatch && lab.isFinal && prev) {
    const losers = prev.matches.filter((m) => m.kind === 'duel').flatMap((m) => m.outcome?.eliminated ?? []);
    if (losers.length === 2) {
      matches.push({
        id: `r${index}-m${matches.length}`,
        roundIndex: index,
        index: matches.length,
        kind: 'thirdPlace',
        songIds: losers,
        advanceCount: 1,
        evaluation: 'select',
        blockIndex: null,
        candidateRequired: false,
        status: 'open',
      });
    } else {
      lab.notes.push('Spiel um Platz 3 entfällt: Im Halbfinale gab es nur ein echtes Duell.');
    }
  }

  const playoffs: PlayoffState[] = [];
  if (extrasActive(config) && !lab.isFinal) {
    const full = matches.filter((m) => m.kind === 'cypher');
    const mk = (k: number, scope: 'block' | 'round', src: MatchState[], spots: number, blockIndex: number | null) => {
      src.forEach((m) => {
        m.candidateRequired = true;
        m.blockIndex = blockIndex;
      });
      playoffs.push({
        id: `r${index}-p${k}`,
        roundIndex: index,
        scope,
        blockIndex,
        sourceMatchIds: src.map((m) => m.id),
        candidates: [],
        spots,
        status: 'waiting',
        sureWinners: [],
        contested: [],
        contestedSpots: 0,
        winners: [],
      });
    };
    if (config.extraMode === 'perBlock') {
      const blocks = Math.floor(full.length / 2);
      for (let b = 0; b < blocks; b++) mk(b, 'block', [full[2 * b], full[2 * b + 1]], 1, b);
      if (full.length % 2 === 1 && full.length > 0) {
        lab.notes.push('Die letzte Vierergruppe bildet keinen vollständigen Block aus zwei Cyphers – dort gilt die Grundregel ohne Zusatzplatz.');
      }
    } else if (config.extraMode === 'perRound') {
      const spots = perRoundSpots(config, full.length);
      if (spots > 0) {
        mk(0, 'round', full, spots, null);
        if (spots < config.extraPerRound) {
          lab.notes.push(`Zusatzplätze in dieser Runde auf ${spots} begrenzt, damit die Runde Songs ausscheiden lässt.`);
        }
      } else {
        lab.notes.push('Zu wenige vollständige Cyphers für einen rundenweiten Vergleich – diese Runde ohne Zusatzplätze.');
      }
    }
  }

  return {
    index,
    label: lab.label,
    sublabel: lab.sublabel,
    entrants,
    matches,
    playoffs,
    isFinal: lab.isFinal,
    isPrelim: lab.isPrelim,
    complete: false,
    byes: groups.filter((g) => g.kind === 'bye').length,
    notes: lab.notes,
  };
}

function nextEntrants(ctx: Ctx, round: RoundState): string[] {
  const winners = new Set(round.playoffs.flatMap((p) => p.winners));
  const out: string[] = [];
  for (const m of round.matches) {
    if (m.kind === 'thirdPlace') continue;
    out.push(...m.outcome!.qualified);
    const c = m.outcome!.candidate;
    if (c && winners.has(c)) out.push(c);
  }
  if (ctx.config.format === 'cypher' && ctx.config.reshufflePerRound) {
    return shuffle(out, mulberry32(deriveSeed(ctx.seed, `round-${round.index + 1}`)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Replay

export function computeState(t: Pick<Tournament, 'config' | 'draw' | 'seed' | 'decisions'>): TournamentState {
  const ctx: Ctx = { config: t.config, seed: t.seed, bracketPlaces: nextPow2(t.draw.length) };
  const byTarget = new Map<string, Decision>();
  for (const d of t.decisions) if (!byTarget.has(d.targetId)) byTarget.set(d.targetId, d);
  const used = new Set<Decision>();

  const rounds: RoundState[] = [];
  let entrants = t.draw.slice();
  let champion: string | null = null;
  let runnerUp: string | null = null;
  let thirdPlace: string | null = null;

  if (entrants.length < 2) {
    return {
      rounds,
      champion: entrants[0] ?? null,
      runnerUp,
      thirdPlace,
      validDecisions: [],
      droppedDecisions: t.decisions.slice(),
      openItems: [],
      finished: entrants.length === 1,
    };
  }

  for (let index = 0; index < 64; index++) {
    const round = buildRound(ctx, index, entrants, rounds[rounds.length - 1] ?? null);
    for (const m of round.matches) {
      if (m.status !== 'open') continue;
      const d = byTarget.get(m.id);
      if (!d || d.songIds.join('|') !== m.songIds.join('|')) continue;
      const res = evaluateMatch(m, d);
      if (typeof res === 'string') continue;
      m.decision = d;
      m.outcome = res;
      m.status = 'done';
      used.add(d);
    }
    for (const p of round.playoffs) {
      setupPlayoff(p, round.matches, ctx.config);
      if (p.status !== 'open') continue;
      const d = byTarget.get(p.id);
      if (!d || !sameSet(d.songIds, p.contested)) continue;
      const res = evaluatePlayoff(p, d);
      if (typeof res === 'string') continue;
      p.decision = d;
      p.winners = res;
      p.status = 'done';
      used.add(d);
    }
    round.complete =
      round.matches.every((m) => m.status !== 'open') && round.playoffs.every((p) => p.status === 'done' || p.status === 'auto');
    rounds.push(round);
    if (!round.complete) break;
    if (round.isFinal) {
      const fin = round.matches.find((m) => m.kind === 'final')!;
      champion = fin.outcome!.qualified[0];
      if (fin.songIds.length === 2) runnerUp = fin.outcome!.eliminated[0];
      else if (fin.outcome!.order) runnerUp = fin.outcome!.order[1];
      const third = round.matches.find((m) => m.kind === 'thirdPlace');
      if (third) thirdPlace = third.outcome!.qualified[0];
      break;
    }
    entrants = nextEntrants(ctx, round);
    if (entrants.length === 1) {
      champion = entrants[0];
      break;
    }
  }

  const current = rounds[rounds.length - 1];
  const openItems: OpenItem[] = [];
  if (current && !current.complete) {
    for (const m of current.matches) if (m.status === 'open') openItems.push({ type: 'match', id: m.id });
    for (const p of current.playoffs) if (p.status === 'open') openItems.push({ type: 'playoff', id: p.id });
  }
  return {
    rounds,
    champion,
    runnerUp,
    thirdPlace,
    validDecisions: t.decisions.filter((d) => used.has(d)),
    droppedDecisions: t.decisions.filter((d) => !used.has(d)),
    openItems,
    finished: champion !== null,
  };
}

// ---------------------------------------------------------------------------
// Mutations (pure: return new decision lists)

export function roundOfTarget(targetId: string): number {
  const m = /^r(\d+)-/.exec(targetId);
  return m ? Number(m[1]) : -1;
}

/** Add a decision. Ignored (returns null) if the target is not open – protects against double clicks. */
export function addDecision(t: Tournament, d: Decision): Decision[] | null {
  const state = computeState(t);
  if (!state.openItems.some((o) => o.id === d.targetId)) return null;
  const next = [...state.validDecisions, d];
  const after = computeState({ ...t, decisions: next });
  if (!after.validDecisions.includes(d)) return null;
  return next;
}

/** Undo the most recent decision. Dependent results are recomputed by the replay. */
export function undoLast(t: Tournament): Decision[] {
  const state = computeState(t);
  return state.validDecisions.slice(0, -1);
}

/**
 * Reopen any decided match or playoff: removes its decision, the extra-spot decisions that
 * depend on it, and every decision of later rounds.
 */
export function reopen(t: Tournament, targetId: string): Decision[] {
  const state = computeState(t);
  const r = roundOfTarget(targetId);
  const round = state.rounds[r];
  const dependentPlayoffs = new Set(
    (round?.playoffs ?? []).filter((p) => p.sourceMatchIds.includes(targetId)).map((p) => p.id),
  );
  return state.validDecisions.filter((d) => {
    if (d.targetId === targetId) return false;
    if (dependentPlayoffs.has(d.targetId)) return false;
    return roundOfTarget(d.targetId) <= r;
  });
}

export function findMatch(state: TournamentState, id: string): MatchState | undefined {
  for (const r of state.rounds) {
    const m = r.matches.find((x) => x.id === id);
    if (m) return m;
  }
  return undefined;
}

export function findPlayoff(state: TournamentState, id: string): PlayoffState | undefined {
  for (const r of state.rounds) {
    const p = r.playoffs.find((x) => x.id === id);
    if (p) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Preview: simulate the structure with placeholder outcomes (counts are outcome-independent).

export interface PreviewRound {
  label: string;
  sublabel: string;
  songs: number;
  notes: string[];
  extraSpots: number;
  isFinal: boolean;
}

export function previewRounds(config: TournamentConfig, n: number): PreviewRound[] {
  if (n < 2) return [];
  const draw = Array.from({ length: n }, (_, i) => `s${i}`);
  const ctx: Ctx = { config, seed: 1, bracketPlaces: nextPow2(n) };
  const out: PreviewRound[] = [];
  let entrants = draw;
  let prev: RoundState | null = null;
  for (let index = 0; index < 64 && entrants.length >= 2; index++) {
    const round = buildRound(ctx, index, entrants, prev);
    for (const m of round.matches) {
      if (m.status !== 'open') continue;
      m.status = 'done';
      m.outcome = {
        order: m.songIds.slice(),
        sharedTies: [],
        qualified: m.songIds.slice(0, m.advanceCount),
        eliminated: m.songIds.slice(m.advanceCount),
        candidate: m.candidateRequired ? m.songIds[m.advanceCount] : null,
      };
      m.decision = {
        id: '',
        targetId: m.id,
        songIds: m.songIds,
        at: '',
        scores: Object.fromEntries(m.songIds.map((s, i) => [s, 10 - i])),
      };
    }
    let extra = 0;
    for (const p of round.playoffs) {
      p.status = 'waiting';
      const src = p.sourceMatchIds.map((id) => round.matches.find((m) => m.id === id)!);
      p.candidates = src.map((m) => m.outcome!.candidate!).filter(Boolean);
      p.winners = p.candidates.slice(0, Math.min(p.spots, p.candidates.length));
      extra += p.winners.length;
    }
    out.push({
      label: round.label,
      sublabel: round.sublabel,
      songs: entrants.length,
      notes: round.notes,
      extraSpots: extra,
      isFinal: round.isFinal,
    });
    if (round.isFinal) break;
    entrants = nextEntrants(ctx, round);
    prev = round;
  }
  return out;
}
