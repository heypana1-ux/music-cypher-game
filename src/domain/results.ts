import type { MatchState, PlayoffState, RoundState, Song, Tournament, TournamentState } from './types';

export interface PathStep {
  round: RoundState;
  match: MatchState;
  /** How the song got through: rank/score/selection or bye. */
  via: 'bye' | 'direct' | 'extra' | 'final' | 'out';
  playoff?: PlayoffState;
}

/** Every match a song took part in, with how it went. */
export function songPath(state: TournamentState, songId: string): PathStep[] {
  const steps: PathStep[] = [];
  for (const round of state.rounds) {
    for (const m of round.matches) {
      if (!m.songIds.includes(songId) || !m.outcome) continue;
      if (m.kind === 'bye') {
        steps.push({ round, match: m, via: 'bye' });
        continue;
      }
      if (m.outcome.qualified.includes(songId)) {
        steps.push({ round, match: m, via: m.kind === 'final' ? 'final' : 'direct' });
        continue;
      }
      const p = round.playoffs.find((x) => x.winners.includes(songId));
      steps.push({ round, match: m, via: p ? 'extra' : 'out', playoff: p });
    }
  }
  return steps;
}

export interface EliminationGroup {
  label: string;
  songIds: string[];
}

/**
 * Songs grouped by the stage where they were eliminated – latest stage first.
 * A knockout determines no exact ranking beyond this, so no invented places.
 */
export function eliminationGroups(state: TournamentState): EliminationGroup[] {
  const groups: EliminationGroup[] = [];
  for (const round of state.rounds.slice().reverse()) {
    const out: string[] = [];
    for (const m of round.matches) {
      if (!m.outcome || m.kind === 'thirdPlace') continue;
      for (const id of m.outcome.eliminated) {
        const extra = round.playoffs.some((p) => p.winners.includes(id));
        if (!extra) out.push(id);
      }
    }
    const known = new Set([state.champion, state.runnerUp, state.thirdPlace].filter(Boolean) as string[]);
    const rest = out.filter((id) => !known.has(id));
    if (rest.length) {
      groups.push({ label: round.isFinal ? 'Weitere Finalisten' : `Ausgeschieden: ${round.label}`, songIds: rest });
    }
  }
  return groups;
}

export function decidedMatchCount(state: TournamentState): number {
  return state.rounds.reduce((n, r) => n + r.matches.filter((m) => m.status === 'done').length, 0);
}

export function songLine(s: Song | undefined): string {
  if (!s) return '(unbekannt)';
  return `${s.title} – ${s.artists.join(', ') || 'Unbekannter Interpret'}`;
}

/** A readable export of the result (no credentials, no audio). */
export function resultExport(t: Tournament, state: TournamentState) {
  const byId = new Map(t.songs.map((s) => [s.id, s]));
  const brief = (id: string | null) => {
    const s = id ? byId.get(id) : undefined;
    return s ? { id: s.id, title: s.title, artists: s.artists, album: s.album ?? null } : null;
  };
  return {
    app: 'Music Cypher',
    exportVersion: 1,
    tournament: { id: t.id, name: t.name, createdAt: t.createdAt },
    config: t.config,
    champion: brief(state.champion),
    runnerUp: brief(state.runnerUp),
    thirdPlace: brief(state.thirdPlace),
    eliminated: eliminationGroups(state).map((g) => ({ stage: g.label, songs: g.songIds.map(brief) })),
    rounds: state.rounds.map((r) => ({
      label: r.label,
      sublabel: r.sublabel,
      matches: r.matches.map((m) => ({
        id: m.id,
        kind: m.kind,
        songs: m.songIds.map((id) => songLine(byId.get(id))),
        qualified: m.outcome?.qualified.map((id) => songLine(byId.get(id))) ?? [],
        order: m.outcome?.order?.map((id) => songLine(byId.get(id))) ?? null,
        scores: m.decision?.scores
          ? Object.fromEntries(Object.entries(m.decision.scores).map(([id, v]) => [songLine(byId.get(id)), v]))
          : null,
      })),
      extraSpots: r.playoffs.map((p) => ({
        candidates: p.candidates.map((id) => songLine(byId.get(id))),
        winners: p.winners.map((id) => songLine(byId.get(id))),
        decidedBy: p.decision ? 'Deine Entscheidung' : p.status === 'auto' ? 'Punktevergleich' : 'offen',
      })),
    })),
    note: 'Ergebnis deiner persönlichen Entscheidungen. Auslosung, Freilose und Gruppen beeinflussen den Verlauf – keine objektive Rangliste.',
  };
}

/**
 * Songs in the order the tournament actually determined them: champion, runner-up,
 * (third place / final order), then by elimination stage, latest stage first.
 * Within one stage songs stay grouped – the list order there is not a ranking.
 */
export function resultOrder(state: TournamentState): Array<{ songId: string; stage: string }> {
  const out: Array<{ songId: string; stage: string }> = [];
  const seen = new Set<string>();
  const push = (id: string | null, stage: string) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ songId: id, stage });
    }
  };
  push(state.champion, 'Sieger');
  const finalRound = state.rounds[state.rounds.length - 1];
  const fin = finalRound?.matches.find((m) => m.kind === 'final');
  if (fin?.outcome?.order) fin.outcome.order.forEach((id, i) => push(id, `Finale · Platz ${i + 1}`));
  push(state.runnerUp, 'Finale');
  push(state.thirdPlace, 'Platz 3');
  for (const g of eliminationGroups(state)) for (const id of g.songIds) push(id, g.label);
  return out;
}
